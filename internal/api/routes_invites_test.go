package api

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/21cloud/runtime-web/internal/auth"
	"github.com/21cloud/runtime-web/internal/authz"
)

// inviteTokenFrom extracts the token from an invite link returned by the API.
func inviteTokenFrom(t *testing.T, link any) string {
	t.Helper()
	s, _ := link.(string)
	tok := strings.TrimPrefix(s, testPublicURL+"/invite/")
	if tok == "" || tok == s {
		t.Fatalf("bad invite link %q", s)
	}
	return tok
}

func TestInviteRoutesScoped(t *testing.T) {
	e := newTestEnv(t)
	aliceID := e.mkUser("alice@example.com", testPassword)
	memberID := e.mkUser("mia@example.com", testPassword)
	carolID := e.mkUser("carol@example.com", testPassword)
	org1 := e.mkOrg("acme", aliceID)
	e.addMember(org1.ID, memberID, authz.RoleMember)
	e.mkOrg("globex", carolID)
	aliceCookie, aliceCSRF := e.session("alice@example.com")
	miaCookie, _ := e.session("mia@example.com")
	carolCookie, carolCSRF := e.session("carol@example.com")

	rec := e.send(http.MethodPost, "/api/orgs/acme/invites", map[string]string{"email": "new@example.com", "role": "member"},
		withCookie(aliceCookie), withCSRF(aliceCSRF))
	expectStatus(t, rec, http.StatusCreated)
	body := decode(t, rec)
	inv, _ := body["invite"].(map[string]any)
	id, _ := inv["id"].(string)
	if id == "" || inv["email"] != "new@example.com" {
		t.Fatalf("invite = %v", inv)
	}
	if _, ok := body["link"].(string); !ok {
		t.Fatalf("no link in %v", body)
	}

	// A member lacks invites.manage: a known org with insufficient role is 403.
	rec = e.send(http.MethodGet, "/api/orgs/acme/invites", nil, withCookie(miaCookie))
	expectStatus(t, rec, http.StatusForbidden)

	// Another org's owner cannot see or revoke acme's invite.
	rec = e.send(http.MethodGet, "/api/orgs/acme/invites", nil, withCookie(carolCookie))
	expectStatus(t, rec, http.StatusNotFound)
	rec = e.send(http.MethodDelete, "/api/orgs/globex/invites/"+id, nil, withCookie(carolCookie), withCSRF(carolCSRF))
	expectStatus(t, rec, http.StatusNotFound)

	rec = e.send(http.MethodGet, "/api/orgs/acme/invites", nil, withCookie(aliceCookie))
	expectStatus(t, rec, http.StatusOK)
	if items, _ := decode(t, rec)["items"].([]any); len(items) != 1 {
		t.Fatalf("pending = %d, want 1", len(items))
	}

	rec = e.send(http.MethodDelete, "/api/orgs/acme/invites/"+id, nil, withCookie(aliceCookie), withCSRF(aliceCSRF))
	expectStatus(t, rec, http.StatusNoContent)
	rec = e.send(http.MethodGet, "/api/orgs/acme/invites", nil, withCookie(aliceCookie))
	expectStatus(t, rec, http.StatusOK)
	if items, _ := decode(t, rec)["items"].([]any); len(items) != 0 {
		t.Fatalf("pending after revoke = %d, want 0", len(items))
	}
}

func TestAdminInviteRoutes(t *testing.T) {
	e := newTestEnv(t)
	e.mkAdmin("admin@example.com")
	aliceID := e.mkUser("alice@example.com", testPassword)
	e.mkOrg("acme", aliceID)
	adminCookie, adminCSRF := e.session("admin@example.com")
	aliceCookie, _ := e.session("alice@example.com")

	rec := e.send(http.MethodPost, "/api/admin/invites", map[string]string{"email": "free@example.com"},
		withCookie(adminCookie), withCSRF(adminCSRF))
	expectStatus(t, rec, http.StatusCreated)
	freeID, _ := decode(t, rec)["invite"].(map[string]any)["id"].(string)

	rec = e.send(http.MethodPost, "/api/admin/invites", map[string]string{"email": "bound@example.com", "org": "acme", "role": "member"},
		withCookie(adminCookie), withCSRF(adminCSRF))
	expectStatus(t, rec, http.StatusCreated)

	rec = e.send(http.MethodGet, "/api/admin/invites", nil, withCookie(adminCookie))
	expectStatus(t, rec, http.StatusOK)
	if items, _ := decode(t, rec)["items"].([]any); len(items) != 2 {
		t.Fatalf("all pending = %d, want 2", len(items))
	}
	rec = e.send(http.MethodGet, "/api/admin/invites?org=acme", nil, withCookie(adminCookie))
	expectStatus(t, rec, http.StatusOK)
	if items, _ := decode(t, rec)["items"].([]any); len(items) != 1 {
		t.Fatalf("acme pending = %d, want 1", len(items))
	}

	rec = e.send(http.MethodPost, "/api/admin/invites", map[string]string{"email": "x@example.com", "org": "nope"},
		withCookie(adminCookie), withCSRF(adminCSRF))
	expectStatus(t, rec, http.StatusNotFound)

	rec = e.send(http.MethodDelete, "/api/admin/invites/"+freeID, nil, withCookie(adminCookie), withCSRF(adminCSRF))
	expectStatus(t, rec, http.StatusNoContent)

	rec = e.send(http.MethodGet, "/api/admin/invites", nil, withCookie(aliceCookie))
	expectStatus(t, rec, http.StatusForbidden)
}

func TestInvitePreviewAndNewUserAccept(t *testing.T) {
	e := newTestEnv(t)
	aliceID := e.mkUser("alice@example.com", testPassword)
	e.mkOrg("acme", aliceID)
	aliceCookie, aliceCSRF := e.session("alice@example.com")

	rec := e.send(http.MethodPost, "/api/orgs/acme/invites", map[string]string{"email": "new@example.com"},
		withCookie(aliceCookie), withCSRF(aliceCSRF))
	expectStatus(t, rec, http.StatusCreated)
	token := inviteTokenFrom(t, decode(t, rec)["link"])
	accept := "/api/invites/accept/" + token
	body := map[string]string{"name": "New Person", "password": "new password 123"}

	// Preview is public and shows only the email and org name.
	rec = e.send(http.MethodGet, accept, nil)
	expectStatus(t, rec, http.StatusOK)
	pv := decode(t, rec)
	if pv["email"] != "new@example.com" || pv["org_name"] != "Org acme" {
		t.Fatalf("preview = %v", pv)
	}

	// Accept is Origin-checked even without a session.
	rec = e.send(http.MethodPost, accept, body, withOrigin("https://evil.example"))
	expectStatus(t, rec, http.StatusForbidden)
	if got := errCode(t, rec); got != "origin_invalid" {
		t.Fatalf("code = %q, want origin_invalid", got)
	}

	// A new account is created and signed in without a CSRF token.
	rec = e.send(http.MethodPost, accept, body)
	expectStatus(t, rec, http.StatusOK)
	newCookie := e.cookieFrom(rec)
	if newCookie == "" {
		t.Fatalf("no session cookie after new-user accept")
	}
	if decode(t, rec)["email"] != "new@example.com" {
		t.Fatalf("accept body = %s", rec.Body.String())
	}
	rec = e.send(http.MethodGet, "/api/me", nil, withCookie(newCookie))
	expectStatus(t, rec, http.StatusOK)

	// Single use: the token no longer previews or accepts.
	rec = e.send(http.MethodPost, accept, body)
	expectStatus(t, rec, http.StatusNotFound)
	if got := errCode(t, rec); got != "invite_invalid" {
		t.Fatalf("code = %q, want invite_invalid", got)
	}
	rec = e.send(http.MethodGet, accept, nil)
	expectStatus(t, rec, http.StatusNotFound)
}

func TestInviteAcceptNewUserFollowsMFAPolicy(t *testing.T) {
	e := newTestEnv(t)
	aliceID := e.mkUser("alice@example.com", testPassword)
	e.mkOrg("acme", aliceID)
	aliceCookie, aliceCSRF := e.session("alice@example.com")
	rec := e.send(http.MethodPost, "/api/orgs/acme/invites", map[string]string{"email": "new@example.com"},
		withCookie(aliceCookie), withCSRF(aliceCSRF))
	expectStatus(t, rec, http.StatusCreated)
	token := inviteTokenFrom(t, decode(t, rec)["link"])
	if err := e.auth.SetPolicy(context.Background(), auth.Policy{Require2FA: true}); err != nil {
		t.Fatal(err)
	}

	rec = e.send(http.MethodPost, "/api/invites/accept/"+token, map[string]string{"name": "New", "password": "new password 123"})
	expectStatus(t, rec, http.StatusOK)
	newCookie := e.cookieFrom(rec)
	if newCookie == "" {
		t.Fatalf("no session cookie")
	}
	// The session exists but the 2FA gate holds every route except the enrolment ones.
	rec = e.send(http.MethodGet, "/api/orgs/acme", nil, withCookie(newCookie))
	expectStatus(t, rec, http.StatusForbidden)
	if got := errCode(t, rec); got != "mfa_enrollment_required" {
		t.Fatalf("code = %q, want mfa_enrollment_required", got)
	}
}

func TestInviteAcceptExistingAccount(t *testing.T) {
	e := newTestEnv(t)
	aliceID := e.mkUser("alice@example.com", testPassword)
	e.mkOrg("acme", aliceID)
	e.mkUser("bob@example.com", testPassword)
	aliceCookie, aliceCSRF := e.session("alice@example.com")

	rec := e.send(http.MethodPost, "/api/orgs/acme/invites", map[string]string{"email": "bob@example.com", "role": "member"},
		withCookie(aliceCookie), withCSRF(aliceCSRF))
	expectStatus(t, rec, http.StatusCreated)
	token := inviteTokenFrom(t, decode(t, rec)["link"])
	accept := "/api/invites/accept/" + token
	hijack := map[string]string{"name": "x", "password": "hijacked password"}

	// Anonymous, and signed in as someone else: both need to be signed in as bob.
	rec = e.send(http.MethodPost, accept, hijack)
	expectStatus(t, rec, http.StatusForbidden)
	if got := errCode(t, rec); got != "invite_login_required" {
		t.Fatalf("code = %q, want invite_login_required", got)
	}
	rec = e.send(http.MethodPost, accept, hijack, withCookie(aliceCookie))
	expectStatus(t, rec, http.StatusForbidden)
	if got := errCode(t, rec); got != "invite_login_required" {
		t.Fatalf("code = %q, want invite_login_required", got)
	}

	bobCookie, _ := e.session("bob@example.com")
	rec = e.send(http.MethodPost, accept, hijack, withCookie(bobCookie))
	expectStatus(t, rec, http.StatusOK)
	if e.cookieFrom(rec) != "" {
		t.Fatalf("existing-account accept must not set a session cookie")
	}

	// The password is untouched and bob now belongs to acme.
	e.login("bob@example.com", testPassword)
	rec = e.send(http.MethodGet, "/api/me", nil, withCookie(bobCookie))
	expectStatus(t, rec, http.StatusOK)
	found := false
	for _, o := range decode(t, rec)["orgs"].([]any) {
		if o.(map[string]any)["slug"] == "acme" {
			found = true
		}
	}
	if !found {
		t.Fatalf("bob is not a member of acme after accept")
	}
}
