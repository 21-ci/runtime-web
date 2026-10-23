package api

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func TestSetupFlow(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()

	rec := e.send(http.MethodGet, "/api/setup", nil, noOrigin)
	expectStatus(t, rec, http.StatusOK)
	if decode(t, rec)["needed"] != true {
		t.Fatal("needed = false on empty database")
	}

	rec = e.send(http.MethodPost, "/api/setup", map[string]string{
		"setup_token": "wrong", "email": "root@example.test", "name": "Root", "password": testPassword,
	})
	expectStatus(t, rec, http.StatusForbidden)
	if code := errCode(t, rec); code != "setup_token_invalid" {
		t.Fatalf("code = %q, want setup_token_invalid", code)
	}
	if n, _ := e.st.Q().CountUsers(ctx); n != 0 {
		t.Fatalf("users = %d after wrong token, want 0", n)
	}

	rec = e.send(http.MethodPost, "/api/setup", map[string]string{
		"setup_token": testSetupToken, "email": "root@example.test", "name": "Root", "password": testPassword,
	})
	expectStatus(t, rec, http.StatusCreated)
	if e.cookieFrom(rec) == "" {
		t.Fatal("setup did not set a session cookie")
	}
	body := decode(t, rec)
	if body["csrf"] == "" || body["csrf"] == nil {
		t.Fatalf("csrf missing: %v", body)
	}
	user := body["user"].(map[string]any)
	if user["email"] != "root@example.test" || user["instance_admin"] != true {
		t.Fatalf("user = %v, want root admin", user)
	}

	rec = e.send(http.MethodGet, "/api/setup", nil, noOrigin)
	if decode(t, rec)["needed"] != false {
		t.Fatal("needed = true after setup")
	}

	rec = e.send(http.MethodPost, "/api/setup", map[string]string{
		"setup_token": testSetupToken, "email": "again@example.test", "name": "Again", "password": testPassword,
	})
	expectStatus(t, rec, http.StatusConflict)
	if code := errCode(t, rec); code != "already_set_up" {
		t.Fatalf("code = %q, want already_set_up", code)
	}
}

func TestSetupValidationFields(t *testing.T) {
	e := newTestEnv(t)
	rec := e.send(http.MethodPost, "/api/setup", map[string]string{
		"setup_token": testSetupToken, "email": "root@example.test", "name": "Root", "password": "short",
	})
	expectStatus(t, rec, http.StatusUnprocessableEntity)
	env := decode(t, rec)["error"].(map[string]any)
	if env["code"] != "invalid" {
		t.Fatalf("code = %v, want invalid", env["code"])
	}
	fields := env["details"].(map[string]any)["fields"].(map[string]any)
	if got := fields["password"]; got != "password shorter than 12 characters" {
		t.Fatalf("fields[password] = %q, want the policy reason", got)
	}
}

func TestLoginFailuresAreUniform(t *testing.T) {
	e := newTestEnv(t)
	e.mkUser("ann@example.test", testPassword)
	for _, email := range []string{"ann@example.test", "nobody@example.test"} {
		rec := e.send(http.MethodPost, "/api/auth/login", map[string]string{"email": email, "password": "wrong"})
		expectStatus(t, rec, http.StatusUnauthorized)
		if code := errCode(t, rec); code != "invalid_credentials" {
			t.Fatalf("%s: code = %q, want invalid_credentials", email, code)
		}
	}
}

func TestLoginMFAFlow(t *testing.T) {
	e := newTestEnv(t)
	e.mkUser("ann@example.test", testPassword)
	uid := e.userID("ann@example.test")
	ctx := context.Background()
	otpauth, err := e.auth.TOTP.Enroll(ctx, uid)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.auth.TOTP.Confirm(ctx, uid, totpAt(t, otpauth, time.Now())); err != nil {
		t.Fatal(err)
	}

	rec := e.send(http.MethodPost, "/api/auth/login", map[string]string{"email": "ann@example.test", "password": testPassword})
	expectStatus(t, rec, http.StatusOK)
	if decode(t, rec)["mfa_required"] != true {
		t.Fatal("mfa_required = false for a user with TOTP")
	}
	pending := e.cookieFrom(rec)
	if pending == "" {
		t.Fatal("no MFA-pending cookie")
	}

	expectStatus(t, e.send(http.MethodGet, "/api/me", nil, withCookie(pending)), http.StatusUnauthorized)

	rec = e.send(http.MethodPost, "/api/auth/mfa", map[string]string{"code": "000000"}, withCookie(pending))
	expectStatus(t, rec, http.StatusUnauthorized)
	if code := errCode(t, rec); code != "invalid_code" {
		t.Fatalf("code = %q, want invalid_code", code)
	}

	// A code from the next 30 s step: the enrolment code is already consumed.
	good := totpAt(t, otpauth, time.Now().Add(30*time.Second))
	rec = e.send(http.MethodPost, "/api/auth/mfa", map[string]string{"code": good}, withCookie(pending))
	expectStatus(t, rec, http.StatusOK)
	full := e.cookieFrom(rec)
	if full == "" || full == pending {
		t.Fatal("MFA did not issue a new full session cookie")
	}
	body := decode(t, rec)
	if body["csrf"] == nil || body["csrf"] == "" {
		t.Fatalf("csrf missing: %v", body)
	}
	expectStatus(t, e.send(http.MethodGet, "/api/me", nil, withCookie(full)), http.StatusOK)
}

func TestMeAndPasswordChange(t *testing.T) {
	e := newTestEnv(t)
	e.mkUser("ann@example.test", testPassword)
	cookie, csrf := e.login("ann@example.test", testPassword)

	rec := e.send(http.MethodGet, "/api/me", nil, withCookie(cookie))
	expectStatus(t, rec, http.StatusOK)
	me := decode(t, rec)
	if me["csrf"] != csrf {
		t.Fatalf("csrf = %v, want %s", me["csrf"], csrf)
	}
	if _, ok := me["policy"].(map[string]any); !ok {
		t.Fatalf("policy missing: %v", me)
	}

	mods := []func(*http.Request){withCookie(cookie), withCSRF(csrf)}
	rec = e.send(http.MethodPut, "/api/me/password",
		map[string]string{"current_password": "nope nope nope", "new_password": "a brand new password"}, mods...)
	expectStatus(t, rec, http.StatusUnauthorized)
	if code := errCode(t, rec); code != "invalid_credentials" {
		t.Fatalf("code = %q, want invalid_credentials", code)
	}

	rec = e.send(http.MethodPut, "/api/me/password",
		map[string]string{"current_password": testPassword, "new_password": "short"}, mods...)
	expectStatus(t, rec, http.StatusUnprocessableEntity)
	fields := decode(t, rec)["error"].(map[string]any)["details"].(map[string]any)["fields"].(map[string]any)
	if got := fields["new_password"]; got != "password shorter than 12 characters" {
		t.Fatalf("fields[new_password] = %q, want the policy reason", got)
	}

	rec = e.send(http.MethodPut, "/api/me/password",
		map[string]string{"current_password": testPassword, "new_password": "a brand new password"}, mods...)
	expectStatus(t, rec, http.StatusNoContent)
	expectStatus(t, e.send(http.MethodGet, "/api/me", nil, withCookie(cookie)), http.StatusOK)
	e.login("ann@example.test", "a brand new password")
}

func TestLogoutEndsSession(t *testing.T) {
	e := newTestEnv(t)
	e.mkUser("ann@example.test", testPassword)
	cookie, csrf := e.login("ann@example.test", testPassword)
	rec := e.send(http.MethodPost, "/api/auth/logout", nil, withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusNoContent)
	expectStatus(t, e.send(http.MethodGet, "/api/me", nil, withCookie(cookie)), http.StatusUnauthorized)
}

func TestAuthProviders(t *testing.T) {
	e := newTestEnv(t)
	rec := e.send(http.MethodGet, "/api/auth/providers", nil, noOrigin)
	expectStatus(t, rec, http.StatusOK)
	body := decode(t, rec)
	if body["password_login_disabled"] != false {
		t.Fatalf("password_login_disabled = %v", body["password_login_disabled"])
	}
	if _, ok := body["providers"].([]any); !ok {
		t.Fatalf("providers must be an array: %v", body)
	}
}
