package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/store"
	"github.com/21cloud/runtime-web/internal/store/db"
)

func TestPolicyDefaultsAndRoundTrip(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	p, err := e.svc.Policy(ctx)
	if err != nil || p != (Policy{}) {
		t.Fatalf("default Policy = %+v, %v", p, err)
	}
	if err := e.svc.SetPolicy(ctx, Policy{Require2FA: true}); err != nil {
		t.Fatalf("SetPolicy: %v", err)
	}
	if p, _ := e.svc.Policy(ctx); !p.Require2FA || p.PasswordLoginDisabled {
		t.Fatalf("Policy = %+v", p)
	}
	err = e.svc.SetPolicy(ctx, Policy{PasswordLoginDisabled: true})
	if c, ok := apperr.ConflictCode(err); !ok || c != "sso_not_configured" {
		t.Fatalf("SetPolicy without SSO err = %v", err)
	}
	e.svc.SSOConfigured = func(context.Context) bool { return true }
	if err := e.svc.SetPolicy(ctx, Policy{PasswordLoginDisabled: true}); err != nil {
		t.Fatalf("SetPolicy with SSO: %v", err)
	}
	if p, _ := e.svc.Policy(ctx); p.Require2FA || !p.PasswordLoginDisabled {
		t.Fatalf("Policy = %+v", p)
	}
}

func TestRequire2FAForcesEnrollmentAfterLogin(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	u := e.mkUser(t, "a@example.com", "password-123456")
	if err := e.svc.SetPolicy(ctx, Policy{Require2FA: true}); err != nil {
		t.Fatal(err)
	}
	res, err := e.svc.Login(ctx, u.Email, "password-123456", "1.2.3.4", "ua")
	if err != nil || res.MFARequired || res.CSRF == "" {
		t.Fatalf("Login = %+v, %v; want a normal session", res, err)
	}

	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	h := e.svc.Sessions.RequireSession(e.svc.RequireMFAEnrolled("/api/extra")(ok))
	call := func(path string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.AddCookie(&http.Cookie{Name: e.svc.Sessions.CookieName(), Value: res.Cookie})
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	tests := []struct {
		path string
		want int
	}{
		{"/api/me", http.StatusNoContent},
		{"/api/me/totp/enroll", http.StatusNoContent},
		{"/api/me/totp/confirm", http.StatusNoContent},
		{"/api/auth/logout", http.StatusNoContent},
		{"/api/extra", http.StatusNoContent},
		{"/api/orgs", http.StatusForbidden},
		{"/api/me/sessions", http.StatusForbidden},
		{"/api/me/totpx", http.StatusForbidden},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			rec := call(tt.path)
			if rec.Code != tt.want {
				t.Fatalf("status = %d, want %d", rec.Code, tt.want)
			}
			if tt.want == http.StatusForbidden && !strings.Contains(rec.Body.String(), `"mfa_enrollment_required"`) {
				t.Fatalf("body = %s", rec.Body.String())
			}
		})
	}

	e.enroll(t, u.ID)
	if rec := call("/api/orgs"); rec.Code != http.StatusNoContent {
		t.Fatalf("after enroll /api/orgs = %d", rec.Code)
	}
	if err := e.svc.SetPolicy(ctx, Policy{}); err != nil {
		t.Fatal(err)
	}
	other := e.mkUser(t, "b@example.com", "password-123456")
	res, _ = e.svc.Login(ctx, other.Email, "password-123456", "1.2.3.4", "ua")
	if rec := call("/api/orgs"); rec.Code != http.StatusNoContent {
		t.Fatalf("policy off /api/orgs = %d", rec.Code)
	}
}

func TestPasswordLoginDisabledWhenSSOEnforced(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	u := e.mkUser(t, "a@example.com", "password-123456")
	admin := db.CreateUserParams{
		ID: store.NewID("usr_"), Email: "root@example.com", Name: "Root",
		PasswordHash: "plain$password-123456", IsInstanceAdmin: 1, CreatedAt: 1, UpdatedAt: 1,
	}
	if err := e.st.Q().CreateUser(ctx, admin); err != nil {
		t.Fatal(err)
	}
	e.svc.SSOConfigured = func(context.Context) bool { return true }
	if err := e.svc.SetPolicy(ctx, Policy{PasswordLoginDisabled: true}); err != nil {
		t.Fatal(err)
	}

	_, err := e.svc.Login(ctx, u.Email, "password-123456", "1.2.3.4", "ua")
	if c, ok := apperr.ForbiddenCode(err); !ok || c != "password_login_disabled" {
		t.Fatalf("Login err = %v, want password_login_disabled", err)
	}
	// A wrong password still reads as invalid credentials.
	if _, err := e.svc.Login(ctx, u.Email, "wrong-password-1", "1.2.3.4", "ua"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("Login bad password err = %v", err)
	}
	evs, _ := e.svc.Events.ListForUser(ctx, u.ID, 10)
	var sso bool
	for _, ev := range evs {
		sso = sso || ev.Result == ResultSSOOnly
	}
	if !sso {
		t.Fatalf("no sso_only event in %+v", evs)
	}
	// Instance admins keep break-glass password login.
	if res, err := e.svc.Login(ctx, admin.Email, "password-123456", "1.2.3.4", "ua"); err != nil || res.CSRF == "" {
		t.Fatalf("admin Login = %+v, %v", res, err)
	}
	// OAuth login is unaffected.
	if res, err := e.svc.LoginUser(ctx, u.ID, MethodOAuth, "1.2.3.4", "ua"); err != nil || res.CSRF == "" {
		t.Fatalf("LoginUser = %+v, %v", res, err)
	}
}
