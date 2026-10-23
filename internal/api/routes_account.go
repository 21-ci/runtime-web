package api

import (
	"fmt"
	"net/http"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/auth"
)

// registerAccountRoutes wires the signed-in user's security routes of api-web.md §5.1. They take
// the caller's own session, so every handler works on the caller's user id only.
func (s *Server) registerAccountRoutes() {
	s.route(http.MethodGet, "/api/me/sessions", "", s.listSessions)
	s.route(http.MethodDelete, "/api/me/sessions/{id}", "", s.revokeSession)
	s.route(http.MethodPost, "/api/me/sessions/revoke-others", "", s.revokeOtherSessions)
	s.route(http.MethodPost, "/api/me/totp/enroll", "", s.enrollTOTP)
	s.route(http.MethodPost, "/api/me/totp/confirm", "", s.confirmTOTP)
	s.route(http.MethodPost, "/api/me/totp/disable", "", s.disableTOTP)
	s.route(http.MethodPost, "/api/me/recovery-codes", "", s.regenerateRecoveryCodes)
	s.route(http.MethodGet, "/api/me/logins", "", s.listLogins)
}

// callerOf returns the signed-in principal of r.
func callerOf(r *http.Request) (auth.Principal, error) {
	p, ok := auth.FromContext(r.Context())
	if !ok {
		return auth.Principal{}, auth.ErrNoSession
	}
	return p, nil
}

// sessionInfoJSON is the SessionInfo shape of api-web.md §5.1.
type sessionInfoJSON struct {
	ID         string `json:"id"`
	IP         string `json:"ip"`
	UA         string `json:"ua"`
	CreatedAt  int64  `json:"created_at"`
	LastSeenAt int64  `json:"last_seen_at"`
	Current    bool   `json:"current"`
}

func (s *Server) listSessions(w http.ResponseWriter, r *http.Request) error {
	p, err := callerOf(r)
	if err != nil {
		return err
	}
	list, err := s.deps.Auth.Sessions.ListForUser(r.Context(), p.User.ID, p.SessionID)
	if err != nil {
		return err
	}
	items := make([]sessionInfoJSON, 0, len(list))
	for _, si := range list {
		items = append(items, sessionInfoJSON{
			ID: si.ID, IP: si.IP, UA: si.UA,
			CreatedAt: si.CreatedAt.UnixMilli(), LastSeenAt: si.LastSeenAt.UnixMilli(), Current: si.Current,
		})
	}
	writeJSON(w, http.StatusOK, itemsJSON[sessionInfoJSON]{Items: items})
	return nil
}

// revokeSession signs out one of the caller's sessions. Other users' and unknown ids are 404.
func (s *Server) revokeSession(w http.ResponseWriter, r *http.Request) error {
	p, err := callerOf(r)
	if err != nil {
		return err
	}
	if err := s.deps.Auth.Sessions.RevokeByPublicID(r.Context(), p.User.ID, r.PathValue("id")); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// revokeOtherSessions signs out every session but the caller's and reports how many were live.
func (s *Server) revokeOtherSessions(w http.ResponseWriter, r *http.Request) error {
	p, err := callerOf(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	list, err := s.deps.Auth.Sessions.ListForUser(ctx, p.User.ID, p.SessionID)
	if err != nil {
		return err
	}
	others := 0
	for _, si := range list {
		if !si.Current {
			others++
		}
	}
	if err := s.deps.Auth.Sessions.RevokeAllForUser(ctx, p.User.ID, p.SessionID); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]int{"revoked": others})
	return nil
}

// enrollTOTP starts a TOTP enrolment and returns its otpauth URL.
func (s *Server) enrollTOTP(w http.ResponseWriter, r *http.Request) error {
	p, err := callerOf(r)
	if err != nil {
		return err
	}
	url, err := s.deps.Auth.TOTP.Enroll(r.Context(), p.User.ID)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]string{"otpauth_url": url})
	return nil
}

type totpCodeReq struct {
	Code string `json:"code"`
}

// confirmTOTP activates a pending enrolment. The recovery codes are returned once.
func (s *Server) confirmTOTP(w http.ResponseWriter, r *http.Request) error {
	var in totpCodeReq
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	p, err := callerOf(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	on, err := s.deps.Auth.TOTP.Enabled(ctx, p.User.ID)
	if err != nil {
		return err
	}
	if on {
		return fmt.Errorf("api: totp confirm: %w", apperr.Conflict{Code: "totp_already_enabled"})
	}
	codes, err := s.deps.Auth.TOTP.Confirm(ctx, p.User.ID, in.Code)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string][]string{"recovery_codes": codes})
	return nil
}

type disableTOTPReq struct {
	Password string `json:"password"`
	Code     string `json:"code"`
}

// disableTOTP removes TOTP and signs out every other session, keeping the caller's own.
func (s *Server) disableTOTP(w http.ResponseWriter, r *http.Request) error {
	var in disableTOTPReq
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	p, err := callerOf(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	on, err := s.deps.Auth.TOTP.Enabled(ctx, p.User.ID)
	if err != nil {
		return err
	}
	if !on {
		return fmt.Errorf("api: totp disable: %w", apperr.Conflict{Code: "totp_not_enabled"})
	}
	if err := s.deps.Auth.TOTP.Disable(ctx, p.User.ID, p.SessionID, in.Password, in.Code); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

type passwordReq struct {
	Password string `json:"password"`
}

// regenerateRecoveryCodes replaces every recovery code; the new ones are returned once.
func (s *Server) regenerateRecoveryCodes(w http.ResponseWriter, r *http.Request) error {
	var in passwordReq
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	p, err := callerOf(r)
	if err != nil {
		return err
	}
	codes, err := s.deps.Auth.TOTP.Regenerate(r.Context(), p.User.ID, in.Password)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string][]string{"recovery_codes": codes})
	return nil
}

// loginEventJSON is the LoginEvent shape of api-web.md §5.1.
type loginEventJSON struct {
	ID     string `json:"id"`
	At     int64  `json:"at"`
	IP     string `json:"ip"`
	UA     string `json:"ua"`
	Method string `json:"method"`
	Result string `json:"result"`
}

// listLogins returns the caller's own login attempts, newest first.
func (s *Server) listLogins(w http.ResponseWriter, r *http.Request) error {
	_, limit, err := listParams(r)
	if err != nil {
		return err
	}
	p, err := callerOf(r)
	if err != nil {
		return err
	}
	evs, err := s.deps.Auth.Events.ListForUser(r.Context(), p.User.ID, limit)
	if err != nil {
		return err
	}
	items := make([]loginEventJSON, 0, len(evs))
	for _, ev := range evs {
		items = append(items, loginEventJSON{
			ID: ev.ID, At: ev.At.UnixMilli(), IP: ev.IP, UA: ev.UA, Method: ev.Method, Result: ev.Result,
		})
	}
	writeJSON(w, http.StatusOK, itemsJSON[loginEventJSON]{Items: items})
	return nil
}
