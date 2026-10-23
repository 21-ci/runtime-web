package auth

import (
	"net/http"
	"slices"
)

// RequirePasswordChanged blocks users who must change their password from
// every path except allow (403 password_change_required). Requests without
// a Principal pass through; RequireSession guards those.
func RequirePasswordChanged(allow ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			p, ok := FromContext(r.Context())
			if ok && p.User.MustChangePassword && !slices.Contains(allow, r.URL.Path) {
				writeError(w, http.StatusForbidden, "password_change_required", "change your password to continue")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
