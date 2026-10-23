package api

import (
	"net/http"
	"testing"
	"time"
)

// enableTOTP enrolls and confirms TOTP for the signed-in caller and returns the otpauth URL.
func enableTOTP(t *testing.T, e *testEnv, cookie, csrf string) string {
	t.Helper()
	rec := e.send(http.MethodPost, "/api/me/totp/enroll", nil, withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusOK)
	otpauth, _ := decode(t, rec)["otpauth_url"].(string)
	if otpauth == "" {
		t.Fatalf("no otpauth_url in %s", rec.Body.String())
	}
	rec = e.send(http.MethodPost, "/api/me/totp/confirm", map[string]string{"code": totpAt(t, otpauth, time.Now())},
		withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusOK)
	return otpauth
}

func TestSessionsRoutes(t *testing.T) {
	e := newTestEnv(t)
	e.mkUser("alice@example.com", testPassword)
	cookieA, csrfA := e.session("alice@example.com")
	cookieB, _ := e.session("alice@example.com")

	rec := e.send(http.MethodGet, "/api/me/sessions", nil, withCookie(cookieA))
	expectStatus(t, rec, http.StatusOK)
	items, _ := decode(t, rec)["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("sessions = %d, want 2", len(items))
	}
	var otherID string
	current := 0
	for _, raw := range items {
		it := raw.(map[string]any)
		if it["current"] == true {
			current++
		} else {
			otherID, _ = it["id"].(string)
		}
	}
	if current != 1 || otherID == "" {
		t.Fatalf("current = %d, other id %q; want exactly one current and one other", current, otherID)
	}

	// Revoking the other session logs it out; the caller's own session keeps working.
	rec = e.send(http.MethodDelete, "/api/me/sessions/"+otherID, nil, withCookie(cookieA), withCSRF(csrfA))
	expectStatus(t, rec, http.StatusNoContent)
	rec = e.send(http.MethodGet, "/api/me", nil, withCookie(cookieB))
	expectStatus(t, rec, http.StatusUnauthorized)

	// A third session is swept by revoke-others; the caller's session survives.
	cookieC, _ := e.session("alice@example.com")
	rec = e.send(http.MethodPost, "/api/me/sessions/revoke-others", nil, withCookie(cookieA), withCSRF(csrfA))
	expectStatus(t, rec, http.StatusOK)
	if n, _ := decode(t, rec)["revoked"].(float64); n != 1 {
		t.Fatalf("revoked = %v, want 1", n)
	}
	rec = e.send(http.MethodGet, "/api/me", nil, withCookie(cookieC))
	expectStatus(t, rec, http.StatusUnauthorized)
	rec = e.send(http.MethodGet, "/api/me", nil, withCookie(cookieA))
	expectStatus(t, rec, http.StatusOK)
}

func TestSessionRevokeOtherUsersSessionNotFound(t *testing.T) {
	e := newTestEnv(t)
	e.mkUser("alice@example.com", testPassword)
	e.mkUser("bob@example.com", testPassword)
	aliceCookie, aliceCSRF := e.session("alice@example.com")
	bobCookie, _ := e.session("bob@example.com")

	rec := e.send(http.MethodGet, "/api/me/sessions", nil, withCookie(bobCookie))
	expectStatus(t, rec, http.StatusOK)
	bobItems, _ := decode(t, rec)["items"].([]any)
	bobSessionID, _ := bobItems[0].(map[string]any)["id"].(string)

	rec = e.send(http.MethodDelete, "/api/me/sessions/"+bobSessionID, nil, withCookie(aliceCookie), withCSRF(aliceCSRF))
	expectStatus(t, rec, http.StatusNotFound)
	if got := errCode(t, rec); got != "not_found" {
		t.Fatalf("code = %q, want not_found", got)
	}
}

func TestTOTPRoutes(t *testing.T) {
	e := newTestEnv(t)
	e.mkUser("alice@example.com", testPassword)
	cookie, csrf := e.session("alice@example.com")

	rec := e.send(http.MethodPost, "/api/me/totp/enroll", nil, withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusOK)
	otpauth, _ := decode(t, rec)["otpauth_url"].(string)

	rec = e.send(http.MethodPost, "/api/me/totp/confirm", map[string]string{"code": "000000"}, withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusUnprocessableEntity)
	if got := errCode(t, rec); got != "invalid_code" {
		t.Fatalf("code = %q, want invalid_code", got)
	}

	rec = e.send(http.MethodPost, "/api/me/totp/confirm", map[string]string{"code": totpAt(t, otpauth, time.Now())},
		withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusOK)
	codes, _ := decode(t, rec)["recovery_codes"].([]any)
	if len(codes) != 10 {
		t.Fatalf("recovery codes = %d, want 10", len(codes))
	}

	rec = e.send(http.MethodPost, "/api/me/totp/confirm", map[string]string{"code": totpAt(t, otpauth, time.Now())},
		withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusConflict)
	if got := errCode(t, rec); got != "totp_already_enabled" {
		t.Fatalf("second confirm code = %q, want totp_already_enabled", got)
	}

	rec = e.send(http.MethodPost, "/api/me/totp/enroll", nil, withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusConflict)
}

func TestTOTPDisableRevokesOtherSessions(t *testing.T) {
	e := newTestEnv(t)
	e.mkUser("alice@example.com", testPassword)
	cookieA, csrfA := e.session("alice@example.com")
	cookieB, _ := e.session("alice@example.com")
	otpauth := enableTOTP(t, e, cookieA, csrfA)

	disable := "/api/me/totp/disable"
	rec := e.send(http.MethodPost, disable, map[string]string{"password": "wrong password", "code": "000000"},
		withCookie(cookieA), withCSRF(csrfA))
	expectStatus(t, rec, http.StatusUnauthorized)

	rec = e.send(http.MethodPost, disable, map[string]string{"password": testPassword, "code": "000000"},
		withCookie(cookieA), withCSRF(csrfA))
	expectStatus(t, rec, http.StatusUnprocessableEntity)
	if got := errCode(t, rec); got != "invalid_code" {
		t.Fatalf("code = %q, want invalid_code", got)
	}

	// The enrolment step used above is spent; a code one period later is fresh.
	code := totpAt(t, otpauth, time.Now().Add(30*time.Second))
	rec = e.send(http.MethodPost, disable, map[string]string{"password": testPassword, "code": code},
		withCookie(cookieA), withCSRF(csrfA))
	expectStatus(t, rec, http.StatusNoContent)

	// The caller's session was passed as current, so it survives; the other one is gone.
	rec = e.send(http.MethodGet, "/api/me", nil, withCookie(cookieA))
	expectStatus(t, rec, http.StatusOK)
	rec = e.send(http.MethodGet, "/api/me", nil, withCookie(cookieB))
	expectStatus(t, rec, http.StatusUnauthorized)
}

func TestTOTPDisableNotEnabled(t *testing.T) {
	e := newTestEnv(t)
	e.mkUser("alice@example.com", testPassword)
	cookie, csrf := e.session("alice@example.com")
	rec := e.send(http.MethodPost, "/api/me/totp/disable", map[string]string{"password": testPassword, "code": "000000"},
		withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusConflict)
	if got := errCode(t, rec); got != "totp_not_enabled" {
		t.Fatalf("code = %q, want totp_not_enabled", got)
	}
}

func TestRecoveryCodesRegenerate(t *testing.T) {
	e := newTestEnv(t)
	e.mkUser("alice@example.com", testPassword)
	cookie, csrf := e.session("alice@example.com")

	rec := e.send(http.MethodPost, "/api/me/recovery-codes", map[string]string{"password": testPassword},
		withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusConflict)
	if got := errCode(t, rec); got != "totp_not_enabled" {
		t.Fatalf("code = %q, want totp_not_enabled", got)
	}

	enableTOTP(t, e, cookie, csrf)
	rec = e.send(http.MethodPost, "/api/me/recovery-codes", map[string]string{"password": "wrong password"},
		withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusUnauthorized)

	rec = e.send(http.MethodPost, "/api/me/recovery-codes", map[string]string{"password": testPassword},
		withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusOK)
	codes, _ := decode(t, rec)["recovery_codes"].([]any)
	if len(codes) != 10 {
		t.Fatalf("recovery codes = %d, want 10", len(codes))
	}
}

func TestLoginHistoryOwnOnly(t *testing.T) {
	e := newTestEnv(t)
	e.mkUser("alice@example.com", testPassword)
	e.mkUser("bob@example.com", testPassword)
	cookie, _ := e.session("alice@example.com")
	rec := e.send(http.MethodPost, "/api/auth/login", map[string]string{"email": "bob@example.com", "password": "wrong password"})
	expectStatus(t, rec, http.StatusUnauthorized)

	rec = e.send(http.MethodGet, "/api/me/logins", nil, withCookie(cookie))
	expectStatus(t, rec, http.StatusOK)
	items, _ := decode(t, rec)["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("login events = %d, want 1 (alice's own)", len(items))
	}
	ev := items[0].(map[string]any)
	if ev["result"] != "ok" || ev["method"] != "password" || ev["id"] == "" {
		t.Fatalf("event = %v, want ok password event with an id", ev)
	}

	rec = e.send(http.MethodGet, "/api/me/logins?limit=0", nil, withCookie(cookie))
	expectStatus(t, rec, http.StatusUnprocessableEntity)
}
