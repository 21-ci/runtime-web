// Package api is the HTTP layer of rtweb: the route registry, the middleware
// chain, error mapping, SPA serving and the setup, auth and profile routes.
package api

import (
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"runtime/debug"
	"slices"
	"time"

	"github.com/21cloud/runtime-web/internal/admin"
	"github.com/21cloud/runtime-web/internal/apps"
	"github.com/21cloud/runtime-web/internal/auth"
	"github.com/21cloud/runtime-web/internal/domains"
	"github.com/21cloud/runtime-web/internal/invites"
	"github.com/21cloud/runtime-web/internal/keys"
	"github.com/21cloud/runtime-web/internal/orgs"
	"github.com/21cloud/runtime-web/internal/users"
)

// Deps are the services and settings the HTTP layer needs.
type Deps struct {
	Auth    *auth.Service
	Orgs    *orgs.Service
	Users   *users.Service
	Admin   *admin.Service
	Keys    *keys.Service
	Invites *invites.Service
	Apps    *apps.Service
	// Logs fans out app log streams. New creates one over Apps when nil.
	Logs *apps.LogHub
	// Domains serves the router's route table and certificate status.
	Domains *domains.Service
	// RouterSecret is ROUTER_SHARED_SECRET, the bearer token of the internal router routes.
	RouterSecret string
	Logger       *slog.Logger
	// WebVersion is the console build version the node version route reports.
	WebVersion string
	// PublicURL is RTWEB_PUBLIC_URL; unsafe requests must send it as Origin.
	PublicURL string
	// RuntimePublicURL is RUNTIME_PUBLIC_URL, the only allowed frame source.
	RuntimePublicURL string
	// SPA is the console build. nil serves the embedded build.
	SPA fs.FS
}

// Server routes HTTP requests to the rtweb handlers.
type Server struct {
	deps     Deps
	mux      *http.ServeMux
	registry Registry
	handler  http.Handler
	// sseHeartbeat is the interval of the ": ping" comment on log streams (15 s; tests shorten it).
	sseHeartbeat time.Duration
}

// New builds the server and registers every route.
func New(d Deps) *Server {
	if d.Logger == nil {
		d.Logger = slog.Default()
	}
	if d.SPA == nil {
		d.SPA = embeddedSPA()
	}
	if d.Logs == nil && d.Apps != nil {
		d.Logs = apps.NewLogHub(d.Apps)
	}
	s := &Server{deps: d, mux: http.NewServeMux(), sseHeartbeat: 15 * time.Second}
	s.registerAuthRoutes()
	s.registerAdminRoutes()
	s.registerOrgRoutes()
	s.registerAccountRoutes()
	s.registerInviteRoutes()
	s.registerStreamRoutes()
	s.registerInternalRoutes()
	s.registerAppRoutes()
	s.mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		writeAPIError(w, apiError{status: http.StatusNotFound, code: "not_found", message: "not found"})
	})
	s.mux.Handle("/", newSPAHandler(d.SPA))
	plain := s.securityHeaders(s.mux)
	s.handler = s.recoverPanic(s.logRequests(routerOriginExempt(auth.CheckOrigin(d.PublicURL)(plain), plain)))
	return s
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.handler.ServeHTTP(w, r)
}

// Routes returns every registered route in registration order.
func (s *Server) Routes() Registry {
	return slices.Clone(s.registry)
}

// recoverPanic turns a handler panic into a 500 internal JSON error.
func (s *Server) recoverPanic(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				s.deps.Logger.Error("api: panic", "method", r.Method, "path", r.URL.Path,
					"panic", v, "stack", string(debug.Stack()))
				writeAPIError(w, apiError{status: http.StatusInternalServerError, code: "internal", message: "internal error"})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// statusWriter records the status code for the request log. Unwrap keeps
// http.ResponseController (flushing for SSE) working.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// logRequests writes one slog line per request.
func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(sw, r)
		s.deps.Logger.Info("http request", "method", r.Method, "path", r.URL.Path,
			"status", sw.status, "duration_ms", time.Since(start).Milliseconds())
	})
}

// securityHeaders sets the console Content-Security-Policy on every response.
func (s *Server) securityHeaders(next http.Handler) http.Handler {
	frame := "'none'"
	if o := originOf(s.deps.RuntimePublicURL); o != "" {
		frame = o
	}
	csp := "default-src 'self'; frame-src " + frame + "; frame-ancestors 'none'"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "same-origin")
		next.ServeHTTP(w, r)
	})
}

// originOf returns scheme://host of raw, or "" when raw is not an absolute URL.
func originOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}
