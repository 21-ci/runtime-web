package api

import (
	"net/http"
	"testing"
)

func TestOAuthStartUnconfiguredIs404(t *testing.T) {
	e := newTestEnv(t)
	rec := e.send(http.MethodGet, "/api/auth/oauth/github/start", nil)
	expectStatus(t, rec, http.StatusNotFound)
	if got := errCode(t, rec); got != "not_found" {
		t.Fatalf("code = %q, want not_found", got)
	}
}

func TestOAuthCallbackWithoutStateRedirectsToLogin(t *testing.T) {
	e := newTestEnv(t)
	rec := e.send(http.MethodGet, "/api/auth/oauth/oidc/callback?code=x&state=y", nil)
	expectStatus(t, rec, http.StatusFound)
	if loc := rec.Header().Get("Location"); loc != "/login?error=oauth_state_invalid" {
		t.Fatalf("Location = %q, want /login?error=oauth_state_invalid", loc)
	}
}

func TestAuthProvidersEmptyWhenUnconfigured(t *testing.T) {
	e := newTestEnv(t)
	rec := e.send(http.MethodGet, "/api/auth/providers", nil)
	expectStatus(t, rec, http.StatusOK)
	body := decode(t, rec)
	providers, ok := body["providers"].([]any)
	if !ok || len(providers) != 0 {
		t.Fatalf("providers = %v, want empty list", body["providers"])
	}
}
