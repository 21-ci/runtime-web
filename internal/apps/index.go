package apps

import (
	"context"
	"fmt"

	"github.com/21cloud/runtime-web/internal/authz"
)

// SlugsByServiceID maps the runtime service id of each app in orgID that sub may read to its app
// slug. Usage rows carry service ids; the console shows slugs. Deleted apps are absent.
func (s *Service) SlugsByServiceID(ctx context.Context, sub authz.Subject, orgID string) (map[string]string, error) {
	list, err := s.List(ctx, sub, orgID, "", "")
	if err != nil {
		return nil, fmt.Errorf("apps: slugs by service id: %w", err)
	}
	out := make(map[string]string, len(list))
	for _, sum := range list {
		v, err := s.Get(ctx, sub, orgID, sum.Slug)
		if err != nil {
			return nil, fmt.Errorf("apps: slugs by service id: %s: %w", sum.Slug, err)
		}
		out[v.Raw.ID] = sum.Slug
	}
	return out, nil
}
