package api

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/21cloud/runtime-web/internal/auth"
	"github.com/21cloud/runtime-web/internal/authz"
)

func TestHealthz(t *testing.T) {
	e := newTestEnv(t)
	rec := e.send(http.MethodGet, "/healthz", nil, noOrigin)
	expectStatus(t, rec, http.StatusOK)
	if body := decode(t, rec); body["ok"] != true {
		t.Fatalf("body = %v, want ok:true", body)
	}
}

func TestOriginEnforced(t *testing.T) {
	e := newTestEnv(t)
	tests := []struct {
		name string
		mod  func(*http.Request)
	}{
		{"missing origin", noOrigin},
		{"foreign origin", withOrigin("https://evil.example.test")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := e.send(http.MethodPost, "/api/auth/login", map[string]string{"email": "a@b.c", "password": "x"}, tt.mod)
			expectStatus(t, rec, http.StatusForbidden)
			if code := errCode(t, rec); code != "origin_invalid" {
				t.Fatalf("code = %q, want origin_invalid", code)
			}
		})
	}
}

func TestRoutesRequireSession(t *testing.T) {
	e := newTestEnv(t)
	e.mkUser("ann@example.test", testPassword)
	pendingCookie := e.pendingLogin("ann@example.test")

	tests := []struct {
		name   string
		cookie string
	}{
		{"no cookie", ""},
		{"garbage cookie", "not-hex"},
		{"mfa pending cookie", pendingCookie},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var mods []func(*http.Request)
			if tt.cookie != "" {
				mods = append(mods, withCookie(tt.cookie))
			}
			rec := e.send(http.MethodGet, "/api/me", nil, mods...)
			expectStatus(t, rec, http.StatusUnauthorized)
			if code := errCode(t, rec); code != "unauthenticated" {
				t.Fatalf("code = %q, want unauthenticated", code)
			}
		})
	}
}

// pendingLogin enrolls TOTP for email and returns the MFA-pending cookie of a password login.
func (e *testEnv) pendingLogin(email string) string {
	e.t.Helper()
	uid := e.userID(email)
	otpauth, err := e.auth.TOTP.Enroll(context.Background(), uid)
	if err != nil {
		e.t.Fatalf("Enroll: %v", err)
	}
	if _, err := e.auth.TOTP.Confirm(context.Background(), uid, totpAt(e.t, otpauth, time.Now())); err != nil {
		e.t.Fatalf("Confirm: %v", err)
	}
	rec := e.send(http.MethodPost, "/api/auth/login", map[string]string{"email": email, "password": testPassword})
	expectStatus(e.t, rec, http.StatusOK)
	return e.cookieFrom(rec)
}

func (e *testEnv) userID(email string) string {
	e.t.Helper()
	row, err := e.st.Q().GetUserByEmail(context.Background(), email)
	if err != nil {
		e.t.Fatalf("GetUserByEmail: %v", err)
	}
	return row.ID
}

func TestCSRFEnforced(t *testing.T) {
	e := newTestEnv(t)
	e.mkUser("ann@example.test", testPassword)
	cookie, csrf := e.login("ann@example.test", testPassword)
	body := map[string]string{"current_password": testPassword, "new_password": "another long password"}

	tests := []struct {
		name string
		mods []func(*http.Request)
	}{
		{"missing token", []func(*http.Request){withCookie(cookie)}},
		{"wrong token", []func(*http.Request){withCookie(cookie), withCSRF(csrf + "x")}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := e.send(http.MethodPut, "/api/me/password", body, tt.mods...)
			expectStatus(t, rec, http.StatusForbidden)
			if code := errCode(t, rec); code != "csrf_invalid" {
				t.Fatalf("code = %q, want csrf_invalid", code)
			}
		})
	}
}

// TestGatesApply registers a probe session route and checks the password and
// 2FA gates against it, while /api/me stays reachable.
func TestGatesApply(t *testing.T) {
	ctx := context.Background()
	e := newTestEnv(t)
	probe := func(w http.ResponseWriter, _ *http.Request) error {
		w.WriteHeader(http.StatusOK)
		return nil
	}
	e.srv.route(http.MethodGet, "/api/test/probe", "", probe)

	t.Run("must change password", func(t *testing.T) {
		uid := e.mkUser("gate1@example.test", testPassword)
		if err := e.auth.ResetPassword(ctx, uid, "temporary password!"); err != nil {
			t.Fatal(err)
		}
		cookie, _ := e.login("gate1@example.test", "temporary password!")
		rec := e.send(http.MethodGet, "/api/test/probe", nil, withCookie(cookie))
		if code := errCode(t, rec); code != "password_change_required" {
			t.Fatalf("code = %q, want password_change_required", code)
		}
		expectStatus(t, e.send(http.MethodGet, "/api/me", nil, withCookie(cookie)), http.StatusOK)
	})

	t.Run("2fa enrollment required", func(t *testing.T) {
		e.mkUser("gate2@example.test", testPassword)
		if err := e.auth.SetPolicy(ctx, auth.Policy{Require2FA: true}); err != nil {
			t.Fatal(err)
		}
		cookie, _ := e.login("gate2@example.test", testPassword)
		rec := e.send(http.MethodGet, "/api/test/probe", nil, withCookie(cookie))
		expectStatus(t, rec, http.StatusForbidden)
		if code := errCode(t, rec); code != "mfa_enrollment_required" {
			t.Fatalf("code = %q, want mfa_enrollment_required", code)
		}
		expectStatus(t, e.send(http.MethodGet, "/api/me", nil, withCookie(cookie)), http.StatusOK)
	})
}

func TestAdminRouteRequiresInstanceAdmin(t *testing.T) {
	e := newTestEnv(t)
	e.mkUser("member@example.test", testPassword)
	e.srv.route(http.MethodGet, "/api/test/admin", authz.InstanceAdmin, func(w http.ResponseWriter, _ *http.Request) error {
		w.WriteHeader(http.StatusNoContent)
		return nil
	})
	cookie, _ := e.login("member@example.test", testPassword)
	rec := e.send(http.MethodGet, "/api/test/admin", nil, withCookie(cookie))
	expectStatus(t, rec, http.StatusForbidden)
	if code := errCode(t, rec); code != "forbidden" {
		t.Fatalf("code = %q, want forbidden", code)
	}
}

func TestRegistryListsRoutes(t *testing.T) {
	e := newTestEnv(t)
	want := map[string]bool{
		"GET /healthz":            true,
		"GET /api/setup":          true,
		"POST /api/setup":         true,
		"GET /api/auth/providers": true,
		"POST /api/auth/login":    true,
		"POST /api/auth/mfa":      true,
		"POST /api/auth/logout":   false,
		"GET /api/me":             false,
		"PUT /api/me/password":    false,
	}
	got := map[string]RouteSpec{}
	for _, r := range e.srv.Routes() {
		got[r.Method+" "+r.Pattern] = r
	}
	for key, public := range want {
		r, ok := got[key]
		if !ok {
			t.Fatalf("route %s not registered", key)
		}
		if r.Public != public {
			t.Fatalf("route %s Public = %v, want %v", key, r.Public, public)
		}
	}
}
