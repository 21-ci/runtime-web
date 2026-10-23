package api

import (
	"net/http"
	"strings"
	"testing"
)

func TestSPAFallback(t *testing.T) {
	e := newTestEnv(t)
	tests := []struct {
		name  string
		path  string
		body  string
		cache string
	}{
		{"nested console route", "/orgs/x/apps/y", "<title>app</title>", "no-cache"},
		{"root", "/", "<title>app</title>", "no-cache"},
		{"asset is immutable", "/assets/app.js", "console.log(1)", "public, max-age=31536000, immutable"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := e.send(http.MethodGet, tt.path, nil, noOrigin)
			expectStatus(t, rec, http.StatusOK)
			if !strings.Contains(rec.Body.String(), tt.body) {
				t.Fatalf("body = %q, want it to contain %q", rec.Body.String(), tt.body)
			}
			if got := rec.Header().Get("Cache-Control"); got != tt.cache {
				t.Fatalf("Cache-Control = %q, want %q", got, tt.cache)
			}
		})
	}
}

func TestSPAHasCSP(t *testing.T) {
	e := newTestEnv(t)
	rec := e.send(http.MethodGet, "/orgs/x", nil, noOrigin)
	want := "default-src 'self'; frame-src " + testRuntimeURL + "; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
	if got := rec.Header().Get("Content-Security-Policy"); got != want {
		t.Fatalf("CSP = %q, want %q", got, want)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q, want nosniff", got)
	}
	if got := rec.Header().Get("Referrer-Policy"); got != "same-origin" {
		t.Fatalf("Referrer-Policy = %q, want same-origin", got)
	}
}

func TestUnknownAPIIsJSON404(t *testing.T) {
	e := newTestEnv(t)
	rec := e.send(http.MethodGet, "/api/unknown", nil, noOrigin)
	expectStatus(t, rec, http.StatusNotFound)
	if code := errCode(t, rec); code != "not_found" {
		t.Fatalf("code = %q, want not_found", code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("Content-Type = %q, want JSON", ct)
	}
}
