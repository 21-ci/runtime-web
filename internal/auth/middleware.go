package auth

import (
	"context"
	"encoding/json"
	"net/http"
)

// Principal is the authenticated caller of a request.
type Principal struct {
	User      User
	SessionID string
	CSRF      string
}

type ctxKey struct{}

// NewContext returns ctx carrying p.
func NewContext(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, ctxKey{}, p)
}

// FromContext returns the request's Principal, if any.
func FromContext(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(ctxKey{}).(Principal)
	return p, ok
}

// writeError writes the shared error JSON shape.
func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}

func safeMethod(m string) bool {
	return m == http.MethodGet || m == http.MethodHead || m == http.MethodOptions
}

// RequireSession rejects requests without a live session cookie (401) and
// puts the Principal in the request context.
func (s *Sessions) RequireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(s.CookieName())
		if err != nil {
			writeError(w, http.StatusUnauthorized, "unauthenticated", "sign in required")
			return
		}
		sess, u, err := s.Lookup(r.Context(), c.Value)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "unauthenticated", "sign in required")
			return
		}
		p := Principal{User: u, SessionID: sess.ID, CSRF: sess.CSRF}
		next.ServeHTTP(w, r.WithContext(NewContext(r.Context(), p)))
	})
}

// RequireInstanceAdmin allows only instance admins (403 forbidden).
func RequireInstanceAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, ok := FromContext(r.Context())
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthenticated", "sign in required")
			return
		}
		if !p.User.IsInstanceAdmin {
			writeError(w, http.StatusForbidden, "forbidden", "instance admin required")
			return
		}
		next.ServeHTTP(w, r)
	})
}
