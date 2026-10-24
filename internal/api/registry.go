package api

import (
	"net/http"

	"github.com/21cloud/runtime-web/internal/auth"
	"github.com/21cloud/runtime-web/internal/authz"
)

// RouteSpec describes one registered route. TestEveryRouteChecksAuthz walks
// the registry to confirm each route states its access rule.
type RouteSpec struct {
	Method  string
	Pattern string
	// Action is authz.InstanceAdmin for instance-admin routes. Org-scoped
	// action routes record their action here; their handlers check it with
	// authz.Can against the project slug. Empty means any signed-in user.
	Action authz.Action
	// Public routes take no session.
	Public bool
	// Internal routes are for rtrouter: they take no session, CSRF or Origin check and are gated by
	// the ROUTER_SHARED_SECRET bearer instead (reference/api.md §9).
	Internal bool
}

// Registry lists every route in registration order.
type Registry []RouteSpec

// HandlerFunc handles a request. A returned error is mapped to the error
// envelope by writeErr; a handler that writes its own response returns nil.
type HandlerFunc func(w http.ResponseWriter, r *http.Request) error

// route registers a session route. The session gates and CSRF apply.
func (s *Server) route(method, pattern string, action authz.Action, h HandlerFunc) {
	s.add(RouteSpec{Method: method, Pattern: pattern, Action: action}, h, s.sessionChain(action))
}

// routePublic registers a route with no session. Origin still applies to unsafe methods.
func (s *Server) routePublic(method, pattern string, h HandlerFunc) {
	s.add(RouteSpec{Method: method, Pattern: pattern, Public: true}, h, nil)
}

func (s *Server) add(spec RouteSpec, h HandlerFunc, chain func(http.Handler) http.Handler) {
	var hh http.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := h(w, r); err != nil {
			s.writeErr(w, r, err)
		}
	})
	if chain != nil {
		hh = chain(hh)
	}
	s.registry = append(s.registry, spec)
	s.mux.Handle(spec.Method+" "+spec.Pattern, hh)
}

// Gate exemptions (reference/api.md §1.2): these stay reachable while a password
// change or 2FA enrolment is pending.
var (
	passwordGateExempt = []string{"/api/me", "/api/me/password", "/api/auth/logout"}
	mfaGateExempt      = []string{"/api/me", "/api/me/totp/", "/api/auth/logout"}
)

// sessionChain runs, in order: session load (rejects MFA-pending cookies),
// password-change gate, 2FA-enrolment gate, CSRF, instance-admin check. CSRF
// comes before the authz check so a cross-site request gets csrf_invalid.
func (s *Server) sessionChain(action authz.Action) func(http.Handler) http.Handler {
	sessions := s.deps.Auth.Sessions
	return func(next http.Handler) http.Handler {
		h := next
		if action == authz.InstanceAdmin {
			h = auth.RequireInstanceAdmin(h)
		}
		h = auth.RequireCSRF(h)
		h = s.deps.Auth.RequireMFAEnrolled(mfaGateExempt...)(h)
		h = auth.RequirePasswordChanged(passwordGateExempt...)(h)
		return sessions.RequireSession(h)
	}
}
