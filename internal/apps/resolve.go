package apps

import (
	"context"
	"fmt"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/runtime"
)

// App is a resolved app slug.
type App struct {
	SvcID       string
	Slug        string
	ProjectSlug string
	Environment string
}

// Resolve maps an app slug to its runtime id in orgID's tenant. Slugs are unique per runtime node, so a
// slug held by another tenant yields no item under the org's key and is apperr.ErrNotFound. Results
// are cached per (org, slug) for 30 seconds; Delete and Update evict them. Resolve does no
// authorisation: callers check the app's project.
func (s *Service) Resolve(ctx context.Context, orgID, slug string) (App, error) {
	k := cacheKey{orgID, slug}
	now := s.now()
	s.mu.Lock()
	c, ok := s.cache[k]
	s.mu.Unlock()
	if ok && now.Before(c.exp) {
		return c.app, nil
	}
	cli, err := s.client(ctx, orgID)
	if err != nil {
		return App{}, err
	}
	page, err := cli.ListServices(ctx, runtime.ServiceFilter{Slug: slug})
	if err != nil {
		return App{}, mapErr("resolve "+slug, err)
	}
	for _, svc := range page.Items {
		if svc.Slug == slug {
			app := App{SvcID: svc.ID, Slug: svc.Slug, ProjectSlug: svc.Project, Environment: svc.Environment}
			s.mu.Lock()
			s.cache[k] = cachedApp{app: app, exp: now.Add(resolveTTL)}
			s.mu.Unlock()
			return app, nil
		}
	}
	return App{}, fmt.Errorf("apps: app %s: %w", slug, apperr.ErrNotFound)
}

// evict drops the cached resolution of slug in orgID.
func (s *Service) evict(orgID, slug string) {
	s.mu.Lock()
	delete(s.cache, cacheKey{orgID, slug})
	s.mu.Unlock()
}
