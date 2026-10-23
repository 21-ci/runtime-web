package auth

import (
	"crypto/subtle"
	"net/http"
)

// CSRFHeader carries the session's CSRF token on mutations.
const CSRFHeader = "X-CSRF-Token"

// RequireCSRF rejects unsafe requests whose X-CSRF-Token does not equal the
// session's token (403 csrf_invalid). It runs after RequireSession.
func RequireCSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if safeMethod(r.Method) {
			next.ServeHTTP(w, r)
			return
		}
		p, ok := FromContext(r.Context())
		got := r.Header.Get(CSRFHeader)
		if !ok || p.CSRF == "" || got == "" || subtle.ConstantTimeCompare([]byte(got), []byte(p.CSRF)) != 1 {
			writeError(w, http.StatusForbidden, "csrf_invalid", "missing or invalid CSRF token")
			return
		}
		next.ServeHTTP(w, r)
	})
}
