package api

import (
	"net/http"
	"strings"
	"testing"

	"github.com/21cloud/runtime-web/internal/authz"
)

// sessionOnlyRoutes are non-public routes that take a session but no authz.Action: the caller
// sees only their own data.
var sessionOnlyRoutes = map[string]bool{
	"POST /api/auth/logout":               true,
	"GET /api/me":                         true,
	"GET /api/me/sessions":                true,
	"DELETE /api/me/sessions/{id}":        true,
	"POST /api/me/sessions/revoke-others": true,
	"POST /api/me/totp/enroll":            true,
	"POST /api/me/totp/confirm":           true,
	"POST /api/me/totp/disable":           true,
	"POST /api/me/recovery-codes":         true,
	"GET /api/me/logins":                  true,
	"PUT /api/me/password":                true,
	"GET /api/orgs":                       true,
}

func TestEveryRouteChecksAuthz(t *testing.T) {
	e := newTestEnv(t)
	ownerID := e.mkUser("owner@example.com", testPassword)
	org := e.mkOrg("acme", ownerID)
	e.mkUser("stranger@example.com", testPassword)
	cookie, csrf := e.session("stranger@example.com")

	for _, rt := range e.srv.Routes() {
		if rt.Public {
			continue
		}
		key := rt.Method + " " + rt.Pattern
		if rt.Action == "" && !sessionOnlyRoutes[key] {
			t.Errorf("%s has no authz.Action", key)
			continue
		}
		if sessionOnlyRoutes[key] {
			continue
		}
		t.Run(key, func(t *testing.T) {
			path := strings.NewReplacer(
				"{org}", org.Slug, "{p}", "web", "{app}", "app", "{user}", ownerID,
				"{id}", "tok_missing", "{project}", "web",
			).Replace(rt.Pattern)
			rec := e.send(rt.Method, path, map[string]any{}, withCookie(cookie), withCSRF(csrf))
			switch rec.Code {
			case http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound:
			default:
				t.Fatalf("%s %s as non-member = %d, want 401, 403 or 404; body %s", rt.Method, path, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestOrgRoutesReturn404ForNonMember(t *testing.T) {
	e := newTestEnv(t)
	ownerID := e.mkUser("owner@example.com", testPassword)
	org := e.mkOrg("acme", ownerID)
	e.mkUser("stranger@example.com", testPassword)
	cookie, _ := e.session("stranger@example.com")

	for _, path := range []string{
		"/api/orgs/" + org.Slug,
		"/api/orgs/" + org.Slug + "/members",
		"/api/orgs/" + org.Slug + "/tokens",
		"/api/orgs/" + org.Slug + "/audit",
		"/api/orgs/" + org.Slug + "/limits",
	} {
		rec := e.send(http.MethodGet, path, nil, withCookie(cookie))
		expectStatus(t, rec, http.StatusNotFound)
	}
}

func TestLimitsReadOnly(t *testing.T) {
	e := newTestEnv(t)
	ownerID := e.mkUser("owner@example.com", testPassword)
	org := e.mkOrg("acme", ownerID)
	cookie, csrf := e.session("owner@example.com")

	rec := e.send(http.MethodGet, "/api/orgs/"+org.Slug+"/limits", nil, withCookie(cookie))
	expectStatus(t, rec, http.StatusOK)

	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		rec := e.send(method, "/api/orgs/"+org.Slug+"/limits", map[string]any{}, withCookie(cookie), withCSRF(csrf))
		if rec.Code != http.StatusNotFound && rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s limits = %d, want 404 or 405", method, rec.Code)
		}
	}
}

func TestAuditVisibleOnlyToOrgAdmins(t *testing.T) {
	e := newTestEnv(t)
	ownerID := e.mkUser("owner@example.com", testPassword)
	org := e.mkOrg("acme", ownerID)
	memberID := e.mkUser("member@example.com", testPassword)
	e.addMember(org.ID, memberID, authz.RoleMember)
	adminID := e.mkUser("orgadmin@example.com", testPassword)
	e.addMember(org.ID, adminID, authz.RoleAdmin)

	memberCookie, _ := e.session("member@example.com")
	rec := e.send(http.MethodGet, "/api/orgs/"+org.Slug+"/audit", nil, withCookie(memberCookie))
	expectStatus(t, rec, http.StatusForbidden)

	adminCookie, _ := e.session("orgadmin@example.com")
	rec = e.send(http.MethodGet, "/api/orgs/"+org.Slug+"/audit", nil, withCookie(adminCookie))
	expectStatus(t, rec, http.StatusOK)
}

func TestAuditCrossOrg404(t *testing.T) {
	e := newTestEnv(t)
	aliceID := e.mkUser("alice@example.com", testPassword)
	mine := e.mkOrg("mine", aliceID)
	bobID := e.mkUser("bob@example.com", testPassword)
	theirs := e.mkOrg("theirs", bobID)
	cookie, _ := e.session("alice@example.com")

	rec := e.send(http.MethodGet, "/api/orgs/"+theirs.Slug+"/audit", nil, withCookie(cookie))
	expectStatus(t, rec, http.StatusNotFound)
	rec = e.send(http.MethodGet, "/api/orgs/"+mine.Slug+"/audit", nil, withCookie(cookie))
	expectStatus(t, rec, http.StatusOK)
}

func TestInstanceAdminInOrgAudited(t *testing.T) {
	e := newTestEnv(t)
	ownerID := e.mkUser("owner@example.com", testPassword)
	org := e.mkOrg("acme", ownerID)
	e.mkAdmin("admin@example.com")
	cookie, csrf := e.session("admin@example.com")

	rec := e.send(http.MethodPost, "/api/orgs/"+org.Slug+"/projects", map[string]string{"slug": "web", "name": "Web"},
		withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusCreated)

	rec = e.send(http.MethodGet, "/api/orgs/"+org.Slug+"/audit?action=project.create", nil, withCookie(cookie))
	expectStatus(t, rec, http.StatusOK)
	items, _ := decode(t, rec)["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("project.create rows = %d, want 1: %s", len(items), rec.Body.String())
	}
	row, _ := items[0].(map[string]any)
	if got, _ := row["as_instance_admin"].(bool); !got {
		t.Fatalf("as_instance_admin = false, want true: %s", rec.Body.String())
	}
}

func TestMemberRoleMatrix(t *testing.T) {
	e := newTestEnv(t)
	ownerID := e.mkUser("owner@example.com", testPassword)
	org := e.mkOrg("acme", ownerID)
	memberID := e.mkUser("member@example.com", testPassword)
	e.addMember(org.ID, memberID, authz.RoleMember)
	cookie, csrf := e.session("member@example.com")

	rec := e.send(http.MethodGet, "/api/orgs/"+org.Slug+"/members", nil, withCookie(cookie))
	expectStatus(t, rec, http.StatusOK)

	rec = e.send(http.MethodPost, "/api/orgs/"+org.Slug+"/members", map[string]string{"user_id": memberID, "role": "member"},
		withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusForbidden)

	rec = e.send(http.MethodPost, "/api/orgs/"+org.Slug+"/tokens", map[string]any{"name": "t", "scopes": []string{"services:read"}},
		withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusForbidden)
}

func TestAdminCannotGrantOwnerRole(t *testing.T) {
	e := newTestEnv(t)
	ownerID := e.mkUser("owner@example.com", testPassword)
	org := e.mkOrg("acme", ownerID)
	adminID := e.mkUser("orgadmin@example.com", testPassword)
	e.addMember(org.ID, adminID, authz.RoleAdmin)
	otherID := e.mkUser("other@example.com", testPassword)
	e.addMember(org.ID, otherID, authz.RoleMember)
	cookie, csrf := e.session("orgadmin@example.com")

	rec := e.send(http.MethodPatch, "/api/orgs/"+org.Slug+"/members/"+otherID, map[string]string{"role": "owner"},
		withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusForbidden)
}

func TestProjectInvisibleWithoutGrant404(t *testing.T) {
	e := newTestEnv(t)
	ownerID := e.mkUser("owner@example.com", testPassword)
	org := e.mkOrg("acme", ownerID)
	ownerCookie, ownerCSRF := e.session("owner@example.com")
	rec := e.send(http.MethodPost, "/api/orgs/"+org.Slug+"/projects", map[string]string{"slug": "web", "name": "Web"},
		withCookie(ownerCookie), withCSRF(ownerCSRF))
	expectStatus(t, rec, http.StatusCreated)

	memberID := e.mkUser("member@example.com", testPassword)
	e.addMember(org.ID, memberID, authz.RoleMember)
	cookie, _ := e.session("member@example.com")
	rec = e.send(http.MethodGet, "/api/orgs/"+org.Slug+"/projects/web", nil, withCookie(cookie))
	expectStatus(t, rec, http.StatusNotFound)
}

func TestProjectDeleteRecordsAudit(t *testing.T) {
	e := newTestEnv(t)
	ownerID := e.mkUser("owner@example.com", testPassword)
	org := e.mkOrg("acme", ownerID)
	cookie, csrf := e.session("owner@example.com")
	rec := e.send(http.MethodPost, "/api/orgs/"+org.Slug+"/projects", map[string]string{"slug": "web", "name": "Web"},
		withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusCreated)
	rec = e.send(http.MethodDelete, "/api/orgs/"+org.Slug+"/projects/web", nil, withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusNoContent)

	rec = e.send(http.MethodGet, "/api/orgs/"+org.Slug+"/audit?action=project.delete", nil, withCookie(cookie))
	expectStatus(t, rec, http.StatusOK)
	items, _ := decode(t, rec)["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("project.delete rows = %d, want 1", len(items))
	}
}
