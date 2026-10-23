package auth

import (
	"net/http"
	"net/url"
	"strings"
)

// normalizeOrigin returns scheme://host[:port] in lower case, or "".
func normalizeOrigin(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	return strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host)
}

// CheckOrigin rejects unsafe requests whose Origin header is missing or not
// the origin of publicURL (403 origin_invalid). It applies to every unsafe
// method, including unauthenticated login and setup.
func CheckOrigin(publicURL string) func(http.Handler) http.Handler {
	want := normalizeOrigin(publicURL)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if safeMethod(r.Method) {
				next.ServeHTTP(w, r)
				return
			}
			got := normalizeOrigin(r.Header.Get("Origin"))
			if want == "" || got != want {
				writeError(w, http.StatusForbidden, "origin_invalid", "request origin not allowed")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
