package api

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/21cloud/runtime-web/internal/domains"
)

// internalPrefix marks the router-only routes (reference/api.md §9).
const internalPrefix = "/api/internal/"

// certStatusMax bounds the cert-status report body.
const certStatusMax = 1 << 20

// registerInternalRoutes registers the routes rtrouter uses (reference/api.md §9).
func (s *Server) registerInternalRoutes() {
	s.internal(http.MethodGet, "/api/internal/router/routes", s.routerRoutes)
	s.internal(http.MethodPost, "/api/internal/router/cert-status", s.routerCertStatus)
}

// internal registers a router-only route. It has no session, CSRF or Origin check; the bearer
// secret is its gate.
func (s *Server) internal(method, pattern string, h HandlerFunc) {
	s.add(RouteSpec{Method: method, Pattern: pattern, Public: true, Internal: true}, h, s.bearerChain)
}

// bearerChain admits a request whose Authorization header is "Bearer <ROUTER_SHARED_SECRET>". An
// unset secret admits nothing.
func (s *Server) bearerChain(next http.Handler) http.Handler {
	secret := s.deps.RouterSecret
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || secret == "" || !secretEqual(got, secret) {
			writeAPIError(w, apiError{status: http.StatusUnauthorized, code: "unauthenticated", message: "unauthenticated"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// secretEqual compares digests of a and b in constant time, so neither the value nor its length leaks.
func secretEqual(a, b string) bool {
	x := sha256.Sum256([]byte(a))
	y := sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(x[:], y[:]) == 1
}

// routerOriginExempt sends internal requests past the Origin check: rtrouter sends no browser Origin.
func routerOriginExempt(checked, plain http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, internalPrefix) {
			plain.ServeHTTP(w, r)
			return
		}
		checked.ServeHTTP(w, r)
	})
}

// routerRoutes returns the active route table with its ETag, or 304 when If-None-Match matches.
func (s *Server) routerRoutes(w http.ResponseWriter, r *http.Request) error {
	table, etag, err := s.deps.Domains.Routes(r.Context())
	if err != nil {
		return err
	}
	w.Header().Set("ETag", etag)
	if etagMatch(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return nil
	}
	writeJSON(w, http.StatusOK, table)
	return nil
}

// etagMatch reports whether an If-None-Match header lists etag (weak or strong) or "*".
func etagMatch(header, etag string) bool {
	for _, part := range strings.Split(header, ",") {
		p := strings.TrimSpace(part)
		if p == "*" || strings.TrimPrefix(p, "W/") == etag {
			return true
		}
	}
	return false
}

// certStatusBody is the CertStatusReport of reference/api.md §9.
type certStatusBody struct {
	Hosts map[string]domains.CertStatus `json:"hosts"`
}

// routerCertStatus stores rtrouter's certificate report. Unknown hosts are ignored by the service.
func (s *Server) routerCertStatus(w http.ResponseWriter, r *http.Request) error {
	r.Body = http.MaxBytesReader(w, r.Body, certStatusMax)
	var body certStatusBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeAPIError(w, apiError{status: http.StatusRequestEntityTooLarge, code: "payload_too_large", message: "report exceeds 1 MiB"})
			return nil
		}
		return &validationError{message: "body must be a JSON object with hosts"}
	}
	if err := s.deps.Domains.SetCertStatus(r.Context(), body.Hosts); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}
