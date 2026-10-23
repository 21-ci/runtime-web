package api

import (
	"fmt"
	"net/http"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/audit"
	"github.com/21cloud/runtime-web/internal/auth"
	"github.com/21cloud/runtime-web/internal/authz"
)

// appRoute registers an org-scoped app route. Unlike orgRoute it does not check action against the
// {p} path value (there is none on /apps/{app}/... routes). It gates on org membership only: a non-member
// gets 404. The app's project is checked by the apps or domains service, which knows the app's project.
// action is recorded in the registry.
func (s *Server) appRoute(method, pattern string, action authz.Action, h orgHandler) {
	s.route(method, pattern, action, func(w http.ResponseWriter, r *http.Request) error {
		c, err := s.appAccess(r)
		if err != nil {
			return err
		}
		return h(w, r, c)
	})
}

// appAccess resolves {org} and the caller's membership in it. A non-member gets 404.
func (s *Server) appAccess(r *http.Request) (orgCall, error) {
	ctx := r.Context()
	p, ok := auth.FromContext(ctx)
	if !ok {
		return orgCall{}, auth.ErrNoSession
	}
	org, err := s.deps.Orgs.GetBySlug(ctx, r.PathValue("org"))
	if err != nil {
		return orgCall{}, err
	}
	sub, err := s.deps.Orgs.Subject(ctx, p.User.ID, org.ID)
	if err != nil {
		return orgCall{}, err
	}
	if !sub.InstanceAdmin && sub.OrgRole == "" {
		return orgCall{}, fmt.Errorf("api: org %s: %w", org.Slug, apperr.ErrNotFound)
	}
	asAdmin := sub.InstanceAdmin && sub.OrgRole == ""
	return orgCall{org: org, sub: sub, actor: audit.Actor{UserID: p.User.ID, AsInstanceAdmin: asAdmin}}, nil
}
