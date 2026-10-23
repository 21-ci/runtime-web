package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/21cloud/runtime-web/internal/domains"
)

// routerAuth is the bearer header rtrouter sends.
func routerAuth(secret string) func(*http.Request) {
	return func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+secret) }
}

// rawRequest sends body as-is (not JSON-encoded) with no Origin header, as rtrouter does.
func rawRequest(e *testEnv, method, target, body string, mods ...func(*http.Request)) *httptest.ResponseRecorder {
	e.t.Helper()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for _, m := range mods {
		m(req)
	}
	rec := httptest.NewRecorder()
	e.srv.ServeHTTP(rec, req)
	return rec
}

func TestInternalRoutesInRegistry(t *testing.T) {
	e := newTestEnv(t)
	want := map[string]bool{
		"GET /api/internal/router/routes":       false,
		"POST /api/internal/router/cert-status": false,
	}
	for _, rt := range e.srv.Routes() {
		key := rt.Method + " " + rt.Pattern
		if _, ok := want[key]; !ok {
			continue
		}
		if !rt.Internal || rt.Action != "" {
			t.Errorf("%s: Internal = %v, Action = %q; want internal gate and no authz action", key, rt.Internal, rt.Action)
		}
		want[key] = true
	}
	for key, found := range want {
		if !found {
			t.Errorf("%s is not in the registry", key)
		}
	}
}

func TestRouterRoutesAuthAndETag(t *testing.T) {
	e := newTestEnv(t)
	tests := []struct {
		name string
		mods []func(*http.Request)
		code int
	}{
		{"no bearer", nil, http.StatusUnauthorized},
		{"wrong bearer", []func(*http.Request){routerAuth("nope")}, http.StatusUnauthorized},
		{"session cookie is not enough", []func(*http.Request){withCookie("x")}, http.StatusUnauthorized},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := rawRequest(e, http.MethodGet, "/api/internal/router/routes", "", tt.mods...)
			if rec.Code != tt.code {
				t.Fatalf("status = %d, want %d; body %s", rec.Code, tt.code, rec.Body.String())
			}
		})
	}

	rec := rawRequest(e, http.MethodGet, "/api/internal/router/routes", "", routerAuth(testRouterSecret))
	expectStatus(t, rec, http.StatusOK)
	etag := rec.Header().Get("ETag")
	if etag == "" {
		t.Fatal("missing ETag")
	}
	var table domains.RouteTable
	if err := json.Unmarshal(rec.Body.Bytes(), &table); err != nil {
		t.Fatalf("decode table: %v", err)
	}
	if table.ConsoleHost != "console.test" || table.BaseDomain != "apps.test" || table.Hosts == nil {
		t.Fatalf("table = %+v", table)
	}

	rec = rawRequest(e, http.MethodGet, "/api/internal/router/routes", "",
		routerAuth(testRouterSecret), func(r *http.Request) { r.Header.Set("If-None-Match", etag) })
	if rec.Code != http.StatusNotModified {
		t.Fatalf("If-None-Match status = %d, want 304", rec.Code)
	}
	if rec.Header().Get("ETag") != etag {
		t.Errorf("304 ETag = %q, want %q", rec.Header().Get("ETag"), etag)
	}
}

func TestCertStatusEndpointAuth(t *testing.T) {
	e := newTestEnv(t)
	body := `{"hosts":{"unknown.example.test":{"status":"issued"}}}`
	tests := []struct {
		name string
		body string
		mods []func(*http.Request)
		code int
	}{
		{"no bearer", body, nil, http.StatusUnauthorized},
		{"wrong bearer", body, []func(*http.Request){routerAuth("nope")}, http.StatusUnauthorized},
		{"unknown host ignored", body, []func(*http.Request){routerAuth(testRouterSecret)}, http.StatusNoContent},
		{"invalid JSON", `{"hosts":`, []func(*http.Request){routerAuth(testRouterSecret)}, http.StatusUnprocessableEntity},
		{"body over 1 MiB", `{"hosts":{"x":{"status":"issued","error":"` + strings.Repeat("a", 1<<20) + `"}}}`,
			[]func(*http.Request){routerAuth(testRouterSecret)}, http.StatusRequestEntityTooLarge},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := rawRequest(e, http.MethodPost, "/api/internal/router/cert-status", tt.body, tt.mods...)
			if rec.Code != tt.code {
				t.Fatalf("status = %d, want %d; body %s", rec.Code, tt.code, rec.Body.String())
			}
		})
	}
}

func TestCertStatusReportsOnNoBody(t *testing.T) {
	e := newTestEnv(t)
	var b bytes.Buffer
	b.WriteString(`{"hosts":{}}`)
	rec := rawRequest(e, http.MethodPost, "/api/internal/router/cert-status", b.String(), routerAuth(testRouterSecret))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("empty report status = %d, want 204", rec.Code)
	}
}
