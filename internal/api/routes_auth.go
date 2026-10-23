package api

import (
	"errors"
	"net"
	"net/http"
	"strings"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/auth"
)

func (s *Server) registerAuthRoutes() {
	s.routePublic(http.MethodGet, "/healthz", s.healthz)
	s.routePublic(http.MethodGet, "/api/setup", s.setupStatus)
	s.routePublic(http.MethodPost, "/api/setup", s.setup)
	s.routePublic(http.MethodGet, "/api/auth/providers", s.authProviders)
	s.routePublic(http.MethodPost, "/api/auth/login", s.login)
	s.routePublic(http.MethodPost, "/api/auth/mfa", s.completeMFA)
	s.route(http.MethodPost, "/api/auth/logout", "", s.logout)
	s.route(http.MethodGet, "/api/me", "", s.me)
	s.route(http.MethodPut, "/api/me/password", "", s.changePassword)
}

// userJSON is the User shape of api-web.md §2.
type userJSON struct {
	ID                 string `json:"id"`
	Email              string `json:"email"`
	Name               string `json:"name"`
	InstanceAdmin      bool   `json:"instance_admin"`
	MustChangePassword bool   `json:"must_change_password"`
	Disabled           bool   `json:"disabled"`
	TOTPEnabled        bool   `json:"totp_enabled"`
	CreatedAt          int64  `json:"created_at"`
}

// sessionJSON is the SessionResp shape of api-web.md §3.
type sessionJSON struct {
	User userJSON `json:"user"`
	CSRF string   `json:"csrf"`
}

func (s *Server) userJSON(r *http.Request, u auth.User) (userJSON, error) {
	ctx := r.Context()
	row, err := s.deps.Auth.Store.Q().GetUserByID(ctx, u.ID)
	if err != nil {
		return userJSON{}, err
	}
	on, err := s.deps.Auth.TOTP.Enabled(ctx, u.ID)
	if err != nil {
		return userJSON{}, err
	}
	return userJSON{
		ID: u.ID, Email: u.Email, Name: u.Name,
		InstanceAdmin: u.IsInstanceAdmin, MustChangePassword: u.MustChangePassword,
		Disabled: u.Disabled, TOTPEnabled: on, CreatedAt: row.CreatedAt,
	}, nil
}

// clientIP is the peer address; forwarded headers are not trusted.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (s *Server) healthz(w http.ResponseWriter, _ *http.Request) error {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

func (s *Server) setupStatus(w http.ResponseWriter, r *http.Request) error {
	writeJSON(w, http.StatusOK, map[string]bool{"needed": s.deps.Auth.SetupNeeded(r.Context())})
	return nil
}

type setupReq struct {
	SetupToken string `json:"setup_token"`
	Email      string `json:"email"`
	Name       string `json:"name"`
	Password   string `json:"password"`
}

// setup creates the first instance admin and signs them in. The setup token
// is checked before any input validation, so a bad token is always a 403.
func (s *Server) setup(w http.ResponseWriter, r *http.Request) error {
	var in setupReq
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	u, err := s.deps.Auth.Setup(ctx, in.SetupToken, in.Email, in.Name, in.Password)
	if err != nil {
		if fields := setupFields(in); len(fields) > 0 && errors.Is(err, apperr.ErrInvalid) {
			return invalid(fields)
		}
		return err
	}
	cookie, csrf, err := s.deps.Auth.Sessions.Create(ctx, u.ID, clientIP(r), r.UserAgent())
	if err != nil {
		return err
	}
	s.deps.Auth.Sessions.SetCookie(w, cookie)
	uj, err := s.userJSON(r, u)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, sessionJSON{User: uj, CSRF: csrf})
	return nil
}

// setupFields explains which setup input fields are invalid.
func setupFields(in setupReq) fieldErrors {
	fields := fieldErrors{}
	if !strings.Contains(in.Email, "@") {
		fields["email"] = "must be an email address"
	}
	if strings.TrimSpace(in.Name) == "" {
		fields["name"] = "required"
	}
	if err := auth.ValidatePassword(in.Password); err != nil {
		fields["password"] = "must be at least 12 characters"
	}
	return fields
}

type authConfigJSON struct {
	PasswordLoginDisabled bool           `json:"password_login_disabled"`
	Providers             []providerJSON `json:"providers"`
}

type providerJSON struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// authProviders reports the login options. OAuth providers arrive in Task 11e.
func (s *Server) authProviders(w http.ResponseWriter, r *http.Request) error {
	pol, err := s.deps.Auth.Policy(r.Context())
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, authConfigJSON{PasswordLoginDisabled: pol.PasswordLoginDisabled, Providers: []providerJSON{}})
	return nil
}

type loginReq struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type loginResp struct {
	MFARequired bool      `json:"mfa_required"`
	User        *userJSON `json:"user,omitempty"`
	CSRF        string    `json:"csrf,omitempty"`
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) error {
	var in loginReq
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	res, err := s.deps.Auth.Login(r.Context(), in.Email, in.Password, clientIP(r), r.UserAgent())
	if err != nil {
		return err
	}
	s.deps.Auth.Sessions.SetCookie(w, res.Cookie)
	if res.MFARequired {
		writeJSON(w, http.StatusOK, loginResp{MFARequired: true})
		return nil
	}
	uj, err := s.userJSON(r, res.User)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, loginResp{User: &uj, CSRF: res.CSRF})
	return nil
}

type mfaReq struct {
	Code string `json:"code"`
}

// completeMFA exchanges the MFA-pending cookie for a full session. Bad codes
// are 401 here (the code is the second factor); on /me/totp/* they are 422.
func (s *Server) completeMFA(w http.ResponseWriter, r *http.Request) error {
	var in mfaReq
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	sessions := s.deps.Auth.Sessions
	c, err := r.Cookie(sessions.CookieName())
	if err != nil {
		return auth.ErrNoSession
	}
	cookie, _, err := s.deps.Auth.CompleteMFA(r.Context(), c.Value, in.Code)
	if err != nil {
		if errors.Is(err, auth.ErrInvalidCode) {
			writeAPIError(w, apiError{status: http.StatusUnauthorized, code: "invalid_code", message: "invalid code"})
			return nil
		}
		return err
	}
	sess, u, err := sessions.Lookup(r.Context(), cookie)
	if err != nil {
		return err
	}
	sessions.SetCookie(w, cookie)
	uj, err := s.userJSON(r, u)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, sessionJSON{User: uj, CSRF: sess.CSRF})
	return nil
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) error {
	p, ok := auth.FromContext(r.Context())
	if !ok {
		return auth.ErrNoSession
	}
	if err := s.deps.Auth.Sessions.Revoke(r.Context(), p.SessionID); err != nil {
		return err
	}
	s.deps.Auth.Sessions.ClearCookie(w)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

type meJSON struct {
	User                  userJSON    `json:"user"`
	CSRF                  string      `json:"csrf"`
	Orgs                  []meOrgJSON `json:"orgs"`
	Policy                policyJSON  `json:"policy"`
	MFAEnrollmentRequired bool        `json:"mfa_enrollment_required"`
}

type meOrgJSON struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
	Role string `json:"role"`
}

type policyJSON struct {
	Require2FA            bool `json:"require_2fa"`
	PasswordLoginDisabled bool `json:"password_login_disabled"`
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	p, ok := auth.FromContext(ctx)
	if !ok {
		return auth.ErrNoSession
	}
	uj, err := s.userJSON(r, p.User)
	if err != nil {
		return err
	}
	list, err := s.deps.Orgs.List(ctx, p.User.ID)
	if err != nil {
		return err
	}
	orgs := []meOrgJSON{}
	for _, o := range list {
		sub, err := s.deps.Orgs.Subject(ctx, p.User.ID, o.ID)
		if err != nil {
			return err
		}
		if sub.OrgRole == "" {
			continue
		}
		orgs = append(orgs, meOrgJSON{Slug: o.Slug, Name: o.Name, Role: sub.OrgRole})
	}
	pol, err := s.deps.Auth.Policy(ctx)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, meJSON{
		User: uj, CSRF: p.CSRF, Orgs: orgs,
		Policy:                policyJSON{Require2FA: pol.Require2FA, PasswordLoginDisabled: pol.PasswordLoginDisabled},
		MFAEnrollmentRequired: pol.Require2FA && !uj.TOTPEnabled,
	})
	return nil
}

type changePasswordReq struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

// changePassword sets a new password and revokes the caller's other sessions.
func (s *Server) changePassword(w http.ResponseWriter, r *http.Request) error {
	var in changePasswordReq
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	p, ok := auth.FromContext(r.Context())
	if !ok {
		return auth.ErrNoSession
	}
	err := s.deps.Auth.ChangePassword(r.Context(), p.User.ID, p.SessionID, in.CurrentPassword, in.NewPassword)
	if err != nil {
		if errors.Is(err, apperr.ErrInvalid) {
			return invalid(fieldErrors{"new_password": "must be at least 12 characters"})
		}
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}
