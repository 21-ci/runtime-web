package api

import (
	"net/http"
	"testing"
)

// adminGETs are the instance-admin reads; each must refuse a plain user with 403.
var adminGETs = []string{
	"/api/admin/users",
	"/api/admin/orgs",
	"/api/admin/node/status",
	"/api/admin/node/config",
	"/api/admin/node/scheduler",
	"/api/admin/node/cache",
	"/api/admin/node/version",
	"/api/admin/domains",
	"/api/admin/audit",
	"/api/admin/settings",
}

func TestAdminRoutesRequireInstanceAdmin(t *testing.T) {
	e := newTestEnv(t)
	e.mkUser("plain@example.com", testPassword)
	cookie, csrf := e.session("plain@example.com")

	for _, path := range adminGETs {
		t.Run("GET "+path, func(t *testing.T) {
			rec := e.send(http.MethodGet, path, nil, withCookie(cookie))
			expectStatus(t, rec, http.StatusForbidden)
			if got := errCode(t, rec); got != "forbidden" {
				t.Fatalf("code = %q, want forbidden", got)
			}
		})
	}
	writes := []struct {
		method, path string
		body         any
	}{
		{http.MethodPost, "/api/admin/users", map[string]string{"email": "x@example.com", "name": "X"}},
		{http.MethodPut, "/api/admin/settings", map[string]any{"require_2fa": true}},
		{http.MethodPost, "/api/admin/node/drain", map[string]string{"confirm": "drain"}},
		{http.MethodPost, "/api/admin/orgs", map[string]string{"slug": "nope", "name": "Nope"}},
	}
	for _, w := range writes {
		t.Run(w.method+" "+w.path, func(t *testing.T) {
			rec := e.send(w.method, w.path, w.body, withCookie(cookie), withCSRF(csrf))
			expectStatus(t, rec, http.StatusForbidden)
		})
	}
}

func TestAdminReadsNeedSession(t *testing.T) {
	e := newTestEnv(t)
	for _, path := range adminGETs {
		rec := e.send(http.MethodGet, path, nil)
		expectStatus(t, rec, http.StatusUnauthorized)
	}
}

func TestSSOOnlyRequiresProvider(t *testing.T) {
	e := newTestEnv(t)
	e.mkAdmin("admin@example.com")
	cookie, csrf := e.session("admin@example.com")

	rec := e.send(http.MethodPut, "/api/admin/settings", map[string]any{
		"require_2fa":             false,
		"password_login_disabled": true,
		"providers":               []any{},
	}, withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusUnprocessableEntity)
	env := decode(t, rec)
	details, _ := env["error"].(map[string]any)["details"].(map[string]any)
	fields, _ := details["fields"].(map[string]any)
	if _, ok := fields["password_login_disabled"]; !ok {
		t.Fatalf("details.fields.password_login_disabled missing: %s", rec.Body.String())
	}
}

func TestNodeConfigRejectsExtraFieldsAndBadDrain(t *testing.T) {
	e := newTestEnv(t)
	e.mkAdmin("admin@example.com")
	cookie, csrf := e.session("admin@example.com")

	rec := e.send(http.MethodPut, "/api/admin/node/config", map[string]any{
		"degradation_mode": "shed",
		"bogus":            1,
	}, withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusUnprocessableEntity)

	rec = e.send(http.MethodPost, "/api/admin/node/drain", map[string]string{"confirm": "yes"},
		withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusUnprocessableEntity)
}

func TestAdminUserLifecycle(t *testing.T) {
	e := newTestEnv(t)
	adminID := e.mkAdmin("admin@example.com")
	cookie, csrf := e.session("admin@example.com")

	rec := e.send(http.MethodPost, "/api/admin/users", map[string]any{"email": "new@example.com", "name": "New"},
		withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusCreated)
	body := decode(t, rec)
	user, _ := body["user"].(map[string]any)
	userID, _ := user["id"].(string)
	if tmp, _ := body["temp_password"].(string); tmp == "" || userID == "" {
		t.Fatalf("create body = %s", rec.Body.String())
	}

	rec = e.send(http.MethodPatch, "/api/admin/users/"+userID, map[string]any{"name": "Renamed"},
		withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusOK)
	if got := decode(t, rec)["name"]; got != "Renamed" {
		t.Fatalf("name = %v, want Renamed", got)
	}

	rec = e.send(http.MethodPost, "/api/admin/users/"+userID+"/reset-password", nil,
		withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusOK)
	if tmp, _ := decode(t, rec)["temp_password"].(string); tmp == "" {
		t.Fatal("reset-password returned no temp_password")
	}

	rec = e.send(http.MethodDelete, "/api/admin/users/"+adminID, nil, withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusConflict)
	if got := errCode(t, rec); got != "last_admin" {
		t.Fatalf("code = %q, want last_admin", got)
	}

	rec = e.send(http.MethodDelete, "/api/admin/users/"+userID, nil, withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusNoContent)
	rec = e.send(http.MethodDelete, "/api/admin/users/usr_missing", nil, withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusNotFound)
}

func TestAdminCreatesOrgAndSeesAudit(t *testing.T) {
	e := newTestEnv(t)
	adminID := e.mkAdmin("admin@example.com")
	cookie, csrf := e.session("admin@example.com")

	rec := e.send(http.MethodPost, "/api/admin/orgs", map[string]string{"slug": "acme", "name": "Acme", "owner_user_id": adminID},
		withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusCreated)

	rec = e.send(http.MethodGet, "/api/admin/audit?action=org.create", nil, withCookie(cookie))
	expectStatus(t, rec, http.StatusOK)
	items, _ := decode(t, rec)["items"].([]any)
	if len(items) == 0 {
		t.Fatalf("no org.create audit rows: %s", rec.Body.String())
	}
}

func TestAdminResetTOTPAndUnknownUser(t *testing.T) {
	e := newTestEnv(t)
	e.mkAdmin("admin@example.com")
	cookie, csrf := e.session("admin@example.com")
	userID := e.mkUser("someone@example.com", testPassword)

	rec := e.send(http.MethodDelete, "/api/admin/users/"+userID+"/totp", nil, withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusNoContent)

	rec = e.send(http.MethodDelete, "/api/admin/users/usr_missing/totp", nil, withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusNotFound)
}
