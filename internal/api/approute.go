package api

import (
	"net/http"

	"github.com/21cloud/runtime-web/internal/authz"
)

// appRoute registers an app-scoped org route. It requires org membership only (a non-member gets
// 404). The action is recorded in the registry, but the check is made by apps.Service, which
// resolves the app and checks its project, so a grant on another project yields 404 rather than 403.
func (s *Server) appRoute(method, pattern string, action authz.Action, h orgHandler) {
	s.route(method, pattern, action, func(w http.ResponseWriter, r *http.Request) error {
		c, err := s.orgMember(r)
		if err != nil {
			return err
		}
		return h(w, r, c)
	})
}
