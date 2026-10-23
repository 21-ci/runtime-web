package api

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/21cloud/runtime-web/internal/audit"
	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/invites"
	"github.com/21cloud/runtime-web/internal/store/db"
)

func TestDeletedUserStaysAuditableAndCannotLogin(t *testing.T) {
	e := newTestEnv(t)
	e.mkAdmin("admin@example.com")
	aliceID := e.mkUser("alice@example.com", testPassword)
	org := e.mkOrg("acme", aliceID)
	// A second owner keeps alice from being the sole owner, which is a last_owner conflict.
	e.addMember(org.ID, e.mkUser("bob@example.com", testPassword), authz.RoleOwner)
	aliceCookie, aliceCSRF := e.session("alice@example.com")

	// Alice creates a token through the API and an invite through the service.
	rec := e.send(http.MethodPost, "/api/orgs/"+org.Slug+"/tokens", map[string]any{"name": "ci", "scopes": []string{"services:read"}},
		withCookie(aliceCookie), withCSRF(aliceCSRF))
	expectStatus(t, rec, http.StatusCreated)
	role := authz.RoleMember
	inv := invites.New(e.st, testHasher{}, e.auth, testPublicURL)
	if _, _, err := inv.Create(context.Background(), audit.Actor{UserID: aliceID}, "new@example.com", &org.ID, &role); err != nil {
		t.Fatalf("invite create: %v", err)
	}
	// Alice also authored a version; the author row must survive the soft delete.
	if err := e.st.Q().UpsertVersionAuthor(context.Background(), db.UpsertVersionAuthorParams{
		OrgID: org.ID, ServiceID: "svc_test", Version: 1, UserID: aliceID, CreatedAt: 1,
	}); err != nil {
		t.Fatalf("UpsertVersionAuthor: %v", err)
	}

	admin, adminCSRF := e.session("admin@example.com")
	rec = e.send(http.MethodDelete, "/api/admin/users/"+aliceID, nil, withCookie(admin), withCSRF(adminCSRF))
	expectStatus(t, rec, http.StatusNoContent)

	rec = e.send(http.MethodPost, "/api/auth/login", map[string]string{"email": "alice@example.com", "password": testPassword})
	expectStatus(t, rec, http.StatusUnauthorized)

	rec = e.send(http.MethodGet, "/api/orgs/"+org.Slug+"/audit?actor="+aliceID, nil, withCookie(admin))
	expectStatus(t, rec, http.StatusOK)
	items, _ := decode(t, rec)["items"].([]any)
	if len(items) == 0 {
		t.Fatalf("no audit rows for deleted actor: %s", rec.Body.String())
	}
	for _, it := range items {
		actor, _ := it.(map[string]any)["actor"].(map[string]any)
		if actor["name"] != "Deleted user" {
			t.Fatalf("actor name = %v, want Deleted user", actor["name"])
		}
		if email, _ := actor["email"].(string); email != "deleted-"+aliceID+"@invalid" {
			t.Fatalf("actor email = %q, want anonymized", email)
		}
	}

	var n int
	if err := e.st.DB().QueryRow("SELECT COUNT(*) FROM tokens WHERE created_by = ?", aliceID).Scan(&n); err != nil || n != 1 {
		t.Fatalf("token created_by rows = %d, err %v; want 1", n, err)
	}
	if err := e.st.DB().QueryRow("SELECT COUNT(*) FROM version_authors WHERE user_id = ?", aliceID).Scan(&n); err != nil || n != 1 {
		t.Fatalf("version author rows = %d, err %v; want 1", n, err)
	}
}

func TestDeleteSoleOwnerIsConflict(t *testing.T) {
	e := newTestEnv(t)
	e.mkAdmin("admin@example.com")
	ownerID := e.mkUser("owner@example.com", testPassword)
	e.mkOrg("acme", ownerID)
	admin, adminCSRF := e.session("admin@example.com")

	rec := e.send(http.MethodDelete, "/api/admin/users/"+ownerID, nil, withCookie(admin), withCSRF(adminCSRF))
	expectStatus(t, rec, http.StatusConflict)
	if got := errCode(t, rec); got != "last_owner" {
		t.Fatalf("code = %q, want last_owner", got)
	}
}

func TestSettingsProvidersEnableSSO(t *testing.T) {
	e := newTestEnv(t)
	e.mkAdmin("admin@example.com")
	cookie, csrf := e.session("admin@example.com")

	rec := e.send(http.MethodPut, "/api/admin/settings", map[string]any{
		"password_login_disabled": true,
	}, withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusUnprocessableEntity)

	rec = e.send(http.MethodPut, "/api/admin/settings", map[string]any{
		"providers": []map[string]any{{"id": "github", "enabled": true, "client_id": "cid", "client_secret": "s3cret-value"}},
	}, withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusOK)

	rec = e.send(http.MethodPut, "/api/admin/settings", map[string]any{
		"password_login_disabled": true,
	}, withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusOK)

	rec = e.send(http.MethodGet, "/api/admin/settings", nil, withCookie(cookie))
	expectStatus(t, rec, http.StatusOK)
	if body := rec.Body.String(); strings.Contains(body, "s3cret-value") {
		t.Fatalf("client secret leaked in GET: %s", body)
	}
	providers, _ := decode(t, rec)["providers"].([]any)
	var gh map[string]any
	for _, p := range providers {
		if m := p.(map[string]any); m["id"] == "github" {
			gh = m
		}
	}
	if gh == nil || gh["client_secret_set"] != true || gh["client_id"] != "cid" {
		t.Fatalf("github provider = %v", gh)
	}
}

func TestSettingsAuditCommitsWithPolicy(t *testing.T) {
	e := newTestEnv(t)
	e.mkAdmin("admin@example.com")
	cookie, csrf := e.session("admin@example.com")

	rec := e.send(http.MethodPut, "/api/admin/settings", map[string]any{"require_2fa": false},
		withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusOK)
	rec = e.send(http.MethodGet, "/api/admin/audit?action=settings.update", nil, withCookie(cookie))
	expectStatus(t, rec, http.StatusOK)
	items, _ := decode(t, rec)["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("settings.update rows = %d, want 1", len(items))
	}
}

func TestUsageRangeValidation(t *testing.T) {
	e := newTestEnv(t)
	ownerID := e.mkUser("owner@example.com", testPassword)
	org := e.mkOrg("acme", ownerID)
	cookie, _ := e.session("owner@example.com")
	base := "/api/orgs/" + org.Slug + "/usage"

	for _, q := range []string{
		"?from=2026-03-02&to=2026-03-01",
		"?from=2026-01-01&to=2026-06-01",
		"?from=bogus",
	} {
		rec := e.send(http.MethodGet, base+q, nil, withCookie(cookie))
		expectStatus(t, rec, http.StatusUnprocessableEntity)
	}
	rec := e.send(http.MethodGet, base+"?from=2026-01-01&to=2026-03-01", nil, withCookie(cookie))
	expectStatus(t, rec, http.StatusOK)
}

func TestInstanceAdminMemberNotFlaggedAsAdmin(t *testing.T) {
	e := newTestEnv(t)
	adminID := e.mkAdmin("admin@example.com")
	ownerID := e.mkUser("owner@example.com", testPassword)
	org := e.mkOrg("acme", ownerID)
	e.addMember(org.ID, adminID, authz.RoleOwner)
	cookie, csrf := e.session("admin@example.com")

	rec := e.send(http.MethodPost, "/api/orgs/"+org.Slug+"/projects", map[string]string{"slug": "web"},
		withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusCreated)
	rec = e.send(http.MethodGet, "/api/orgs/"+org.Slug+"/audit?action=project.create", nil, withCookie(cookie))
	expectStatus(t, rec, http.StatusOK)
	items, _ := decode(t, rec)["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("rows = %d, want 1", len(items))
	}
	if got, _ := items[0].(map[string]any)["as_instance_admin"].(bool); got {
		t.Fatal("as_instance_admin = true for an org member, want false")
	}
}
