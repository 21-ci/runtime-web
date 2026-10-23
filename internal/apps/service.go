// Package apps manages an org's projects and apps on the runtime. Every app is addressed by its slug,
// which Resolve maps to the runtime id within the org's tenant. Calls use the org's default key, so a
// slug that belongs to another tenant is simply not found. Callers are authorised with authz.Can: an
// app or project outside the caller's reach is apperr.ErrNotFound, a visible one with too low a role is
// apperr.ErrForbidden.
package apps

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/runtime"
)

// resolveTTL is how long a resolved slug is cached.
const resolveTTL = 30 * time.Second

// Creds yields an org's default runtime key (orgs.Service implements it).
type Creds interface {
	DefaultCred(ctx context.Context, orgID string) (runtime.TenantKeyCred, error)
}

// Service manages projects and apps.
type Service struct {
	rt    *runtime.Client
	creds Creds
	now   func() time.Time

	mu    sync.Mutex
	cache map[cacheKey]cachedApp
}

type cacheKey struct{ org, slug string }

type cachedApp struct {
	app App
	exp time.Time
}

// New returns an apps Service.
func New(rt *runtime.Client, creds Creds) *Service {
	return &Service{rt: rt, creds: creds, now: time.Now, cache: map[cacheKey]cachedApp{}}
}

// client returns a runtime client acting with orgID's default key.
func (s *Service) client(ctx context.Context, orgID string) (*runtime.Scoped, error) {
	cred, err := s.creds.DefaultCred(ctx, orgID)
	if err != nil {
		return nil, err
	}
	return s.rt.With(cred), nil
}

// authorize checks a on project: invisible → ErrNotFound, visible but too low → ErrForbidden.
// read is the action that makes the project visible.
func authorize(sub authz.Subject, a, read authz.Action, project string) error {
	if authz.Can(sub, a, project) {
		return nil
	}
	if authz.Can(sub, read, project) {
		return fmt.Errorf("apps: %s on %s: %w", a, project, apperr.ErrForbidden)
	}
	return fmt.Errorf("apps: %s: %w", project, apperr.ErrNotFound)
}

// member reports ErrNotFound unless sub belongs to the org (or is an instance admin).
func member(sub authz.Subject) error {
	if !authz.Can(sub, authz.OrgRead, "") {
		return fmt.Errorf("apps: not a member: %w", apperr.ErrNotFound)
	}
	return nil
}

// mapErr turns runtime errors into apperr values: 404 → ErrNotFound, 412 → Conflict{stale},
// 409 → Conflict{code}. Others are wrapped unchanged so the HTTP layer can pass them through.
func mapErr(op string, err error) error {
	var re *runtime.Error
	if !errors.As(err, &re) {
		return fmt.Errorf("apps: %s: %w", op, err)
	}
	switch re.Status {
	case http.StatusNotFound:
		return fmt.Errorf("apps: %s: %w", op, apperr.ErrNotFound)
	case http.StatusPreconditionFailed:
		return fmt.Errorf("apps: %s: %w", op, apperr.Conflict{Code: "stale"})
	case http.StatusConflict:
		code := re.Code
		if code == "project_slug_taken" {
			code = "slug_taken"
		}
		return fmt.Errorf("apps: %s: %w", op, apperr.Conflict{Code: code})
	}
	return fmt.Errorf("apps: %s: %w", op, err)
}
