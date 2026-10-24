// Package runtimetest is an in-memory fake of the runtime control API
// (runtime-copy docs/api.md). It enforces auth, scopes, tenant isolation, plan
// limits and optimistic concurrency so the web BFF can be tested through the
// real internal/runtime client.
package runtimetest

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// operatorScope marks routes only the operator root token may call.
const operatorScope = "operator"

// rootKeyID is the SSE stream bucket of the operator root token.
const rootKeyID = "root"

const fakeVersion = "runtimetest"

// FakePlan is the subset of a plan the fake enforces. A zero limit is unlimited.
type FakePlan struct {
	MaxServices  int
	MaxSchedules int
	Triggers     []string
}

// Fake is an in-memory runtime control API served over HTTP. Tests reach it
// through URL and must not share a Fake across tests.
type Fake struct {
	// URL is the base URL of the control API.
	URL string
	// RootToken is the operator root token.
	RootToken string
	// SSELimit caps open log streams per key; default 10.
	SSELimit int

	srv  *httptest.Server
	done chan struct{} // closed before shutdown so SSE handlers return

	mu       sync.Mutex
	plans    map[string]FakePlan
	tenants  map[string]*tenant
	keys     map[string]*apiKey
	services map[string]*service
	hosts    map[string]*hostEntry
	projects map[string]*project
	failNext *injected
	streams  map[string]int
	// kick is closed by DropLogStreams to end every open follow stream.
	kick chan struct{}
}

type injected struct {
	status int
	code   string
	retry  time.Duration
}

// NewServer starts a fake runtime for the duration of t.
func NewServer(t *testing.T) *Fake {
	t.Helper()
	f := &Fake{
		RootToken: "test-root-token",
		SSELimit:  10,
		done:      make(chan struct{}),
		plans: map[string]FakePlan{
			"free": {MaxServices: 10, MaxSchedules: 3, Triggers: []string{"http", "interval", "queue", "call"}},
		},
		tenants:  map[string]*tenant{},
		keys:     map[string]*apiKey{},
		services: map[string]*service{},
		hosts:    map[string]*hostEntry{},
		projects: map[string]*project{},
		streams:  map[string]int{},
		kick:     make(chan struct{}),
	}
	mux := http.NewServeMux()
	f.routes(mux)
	f.srv = httptest.NewServer(f.withFailure(mux))
	f.URL = f.srv.URL
	t.Cleanup(f.srv.Close)
	// LIFO: done closes before the server, so blocked SSE handlers return.
	t.Cleanup(func() { close(f.done) })
	return f
}

// FailNext makes the next request fail once with status, code and an optional Retry-After.
func (f *Fake) FailNext(status int, code string, retryAfter time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failNext = &injected{status: status, code: code, retry: retryAfter}
}

// SetPlan defines or replaces a plan; existing tenants on it see the change.
func (f *Fake) SetPlan(name string, p FakePlan) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.plans[name] = p
}

func (f *Fake) routes(mux *http.ServeMux) {
	f.tenantRoutes(mux)
	f.serviceRoutes(mux)
	f.versionRoutes(mux)
	f.hostRoutes(mux)
	f.logRoutes(mux)
	f.projectRoutes(mux)
	f.nodeRoutes(mux)
}

func (f *Fake) withFailure(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		inj := f.failNext
		f.failNext = nil
		f.mu.Unlock()
		if inj != nil {
			writeErr(w, &apiError{status: inj.status, code: inj.code, msg: "injected failure", retry: inj.retry})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// principal is the authenticated caller. tenant is the acting tenant: a
// tenant key's own tenant, or the operator's x-rt-tenant (empty = all).
type principal struct {
	operator bool
	tenant   string
	key      *apiKey
}

// check enforces scope for p. The operatorScope sentinel requires the root token.
func (p principal) check(scope string) *apiError {
	if scope == "" {
		return nil
	}
	if scope == operatorScope {
		if p.operator {
			return nil
		}
		return insufficientScope(nil)
	}
	if p.operator || p.key.hasScope(scope) {
		return nil
	}
	return insufficientScope(nil)
}

// sees reports whether p may touch service s (tenant isolation and key restriction).
func (p principal) sees(s *service) bool {
	if p.tenant != "" && s.tenantID != p.tenant {
		return false
	}
	return p.key.allows(s.projectID, s.environment)
}

func (f *Fake) authenticate(r *http.Request) (principal, *apiError) {
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if tok == "" {
		return principal{}, unauthorized()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if subtle.ConstantTimeCompare([]byte(tok), []byte(f.RootToken)) == 1 {
		p := principal{operator: true}
		if tid := r.Header.Get("x-rt-tenant"); tid != "" {
			if f.tenants[tid] == nil {
				return principal{}, notFound()
			}
			p.tenant = tid
		}
		return p, nil
	}
	rest, ok := strings.CutPrefix(tok, "rtk_")
	if !ok {
		return principal{}, unauthorized()
	}
	i := strings.LastIndexByte(rest, '_')
	if i < 0 {
		return principal{}, unauthorized()
	}
	k := f.keys[rest[:i]]
	if k == nil || subtle.ConstantTimeCompare([]byte(k.secret), []byte(rest[i+1:])) != 1 || !k.active(time.Now()) {
		return principal{}, unauthorized()
	}
	return principal{tenant: k.tenantID, key: k}, nil
}

// handlerFunc serves one authenticated request; it runs under f.mu.
type handlerFunc func(p principal, w http.ResponseWriter, r *http.Request) *apiError

// route registers pattern with auth and scope checks. scope "" accepts any
// valid credential; operatorScope accepts only the root token.
func (f *Fake) route(mux *http.ServeMux, pattern, scope string, h handlerFunc) {
	mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		p, err := f.authenticate(r)
		if err == nil {
			err = p.check(scope)
		}
		if err == nil {
			f.mu.Lock()
			err = h(p, w, r)
			f.mu.Unlock()
		}
		if err != nil {
			writeErr(w, err)
		}
	})
}

// apiError is a control-API error envelope.
type apiError struct {
	status  int
	code    string
	msg     string
	details map[string]any
	retry   time.Duration
}

func (e *apiError) Error() string { return e.code + ": " + e.msg }

func unauthorized() *apiError {
	return &apiError{status: http.StatusUnauthorized, code: "unauthorized", msg: "missing or invalid credential"}
}

func notFound() *apiError {
	return &apiError{status: http.StatusNotFound, code: "not_found", msg: "not found"}
}

func insufficientScope(details map[string]any) *apiError {
	return &apiError{status: http.StatusForbidden, code: "insufficient_scope", msg: "missing scope", details: details}
}

func invalid(format string, args ...any) *apiError {
	return &apiError{status: http.StatusUnprocessableEntity, code: "validation_failed", msg: fmt.Sprintf(format, args...)}
}

func conflict(code, msg string) *apiError {
	return &apiError{status: http.StatusConflict, code: code, msg: msg}
}

func forbidden(code, msg string, details map[string]any) *apiError {
	return &apiError{status: http.StatusForbidden, code: code, msg: msg, details: details}
}

func writeErr(w http.ResponseWriter, e *apiError) {
	if e.retry > 0 {
		secs := int((e.retry + time.Second - 1) / time.Second)
		w.Header().Set("Retry-After", strconv.Itoa(secs))
	}
	details := e.details
	if details == nil {
		details = map[string]any{}
	}
	writeJSON(w, e.status, map[string]any{"error": map[string]any{"code": e.code, "message": e.msg, "details": details}})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func decode(r *http.Request, v any) *apiError {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		return invalid("malformed body: %v", err)
	}
	return nil
}

func newID(prefix string) string { return prefix + randHex(10) }

func nowMS() int64 { return time.Now().UnixMilli() }

func truthy(s string) bool {
	switch strings.ToLower(s) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
