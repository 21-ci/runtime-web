package orgs

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/runtime"
)

// GetBySlug returns the org with slug. An unknown slug is apperr.ErrNotFound.
func (s *Service) GetBySlug(ctx context.Context, slug string) (Org, error) {
	row, err := s.st.Q().GetOrgBySlug(ctx, slug)
	if errors.Is(err, sql.ErrNoRows) {
		return Org{}, fmt.Errorf("orgs: %s: %w", slug, apperr.ErrNotFound)
	}
	if err != nil {
		return Org{}, fmt.Errorf("orgs: get by slug: %w", err)
	}
	return orgFrom(row), nil
}

// Limits returns the runtime quota view of orgID's tenant, read with the org's default key.
func (s *Service) Limits(ctx context.Context, orgID string) (runtime.Limits, error) {
	cred, err := s.DefaultCred(ctx, orgID)
	if err != nil {
		return runtime.Limits{}, fmt.Errorf("orgs: limits: %w", err)
	}
	out, err := s.rt.With(cred).Limits(ctx)
	if err != nil {
		return runtime.Limits{}, fmt.Errorf("orgs: limits: %w", err)
	}
	return out, nil
}
