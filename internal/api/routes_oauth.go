package api

import (
	"net/http"

	"github.com/21cloud/runtime-web/internal/auth"
)

// registerOAuthRoutes wires the OAuth/OIDC login routes (api-web.md §4).
func (s *Server) registerOAuthRoutes() {
	s.routePublic(http.MethodGet, "/api/auth/oauth/{provider}/start", s.oauthStart)
	s.routePublic(http.MethodGet, "/api/auth/oauth/{provider}/callback", s.oauthCallback)
}

// oauth returns the OAuth flow bound to the current auth service.
func (s *Server) oauth() *auth.OAuth {
	return auth.NewOAuth(s.deps.Auth, s.deps.PublicURL)
}

// providerList is the enabled providers for /api/auth/providers.
func (s *Server) providerList(r *http.Request) ([]providerJSON, error) {
	infos, err := s.oauth().Providers(r.Context())
	if err != nil {
		return nil, err
	}
	out := make([]providerJSON, 0, len(infos))
	for _, p := range infos {
		out = append(out, providerJSON{ID: p.ID, Name: p.Name})
	}
	return out, nil
}

// oauthStart redirects to the provider. Unconfigured providers are 404.
func (s *Server) oauthStart(w http.ResponseWriter, r *http.Request) error {
	dest, err := s.oauth().Start(r.Context(), w, r.PathValue("provider"), r.URL.Query().Get("next"))
	if err != nil {
		return err
	}
	http.Redirect(w, r, dest, http.StatusFound)
	return nil
}

// oauthCallback completes the login. Failures redirect to /login?error=<code>
// and never create a user.
func (s *Server) oauthCallback(w http.ResponseWriter, r *http.Request) error {
	dest, err := s.oauth().Finish(r.Context(), w, r, r.PathValue("provider"))
	if err != nil {
		return err
	}
	http.Redirect(w, r, dest, http.StatusFound)
	return nil
}
