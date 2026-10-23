package api

import (
	"net/http"
	"testing"
)

// providerState reads one provider from GET /api/admin/settings.
func providerState(t *testing.T, e *testEnv, cookie, id string) map[string]any {
	t.Helper()
	rec := e.send(http.MethodGet, "/api/admin/settings", nil, withCookie(cookie))
	expectStatus(t, rec, http.StatusOK)
	providers, _ := decode(t, rec)["providers"].([]any)
	for _, p := range providers {
		if m := p.(map[string]any); m["id"] == id {
			return m
		}
	}
	t.Fatalf("provider %s missing from settings", id)
	return nil
}

func TestSettingsRejectedChangeWritesNothing(t *testing.T) {
	e := newTestEnv(t)
	e.mkAdmin("admin@example.com")
	cookie, csrf := e.session("admin@example.com")

	rec := e.send(http.MethodPut, "/api/admin/settings", map[string]any{
		"providers": []map[string]any{{"id": "github", "enabled": true, "client_id": "cid", "client_secret": "sek"}},
	}, withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusOK)
	rec = e.send(http.MethodPut, "/api/admin/settings", map[string]any{"password_login_disabled": true},
		withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusOK)

	// Disabling the only provider while password login is off must fail and change nothing.
	rec = e.send(http.MethodPut, "/api/admin/settings", map[string]any{
		"providers": []map[string]any{{"id": "github", "enabled": false, "client_id": "cid"}},
	}, withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusUnprocessableEntity)
	gh := providerState(t, e, cookie, "github")
	if gh["enabled"] != true {
		t.Fatalf("github enabled = %v after rejected change, want true", gh["enabled"])
	}
}

func TestSettingsInvalidProviderWritesNothing(t *testing.T) {
	e := newTestEnv(t)
	e.mkAdmin("admin@example.com")
	cookie, csrf := e.session("admin@example.com")

	rec := e.send(http.MethodPut, "/api/admin/settings", map[string]any{
		"providers": []map[string]any{
			{"id": "github", "enabled": true, "client_id": "cid", "client_secret": "sek"},
			{"id": "oidc", "enabled": true, "client_id": "x", "client_secret": "y", "issuer": "not a url"},
		},
	}, withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusUnprocessableEntity)

	gh := providerState(t, e, cookie, "github")
	if gh["enabled"] != false || gh["client_secret_set"] != false || gh["client_id"] != "" {
		t.Fatalf("github persisted despite invalid batch: %v", gh)
	}
}
