// Package orgs provisions and manages organizations. Each org is one runtime tenant plus a sealed
// default tenant key that the console uses for every call on the org's behalf.
package orgs

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/audit"
	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/runtime"
	"github.com/21cloud/runtime-web/internal/seal"
	"github.com/21cloud/runtime-web/internal/store"
	"github.com/21cloud/runtime-web/internal/store/db"
)

const (
	defaultKeyName = "rtweb-default"
	credTTL        = 60 * time.Second
)

// Org is an organization.
type Org struct {
	ID        string
	Slug      string
	Name      string
	TenantID  string
	CreatedAt int64
}

type cachedCred struct {
	cred runtime.TenantKeyCred
	exp  time.Time
}

// Service provisions orgs against the runtime control API.
type Service struct {
	st     *store.Store
	rt     *runtime.Client
	root   runtime.RootCred
	sealer *seal.Sealer
	plan   string
	now    func() time.Time
	// hookInsert is a test seam run inside the org insert tx before the insert; an error rolls back.
	hookInsert func(*db.Queries) error

	mu    sync.Mutex
	cache map[string]cachedCred
}

// New returns an orgs Service. plan is the runtime plan given to new tenants.
func New(st *store.Store, rt *runtime.Client, root runtime.RootCred, sealer *seal.Sealer, plan string) *Service {
	return &Service{
		st: st, rt: rt, root: root, sealer: sealer, plan: plan,
		now: time.Now, cache: map[string]cachedCred{},
	}
}

// Create provisions a runtime tenant and default key, then records the org with ownerUserID as owner.
// A DB failure after the tenant exists deletes the tenant again.
func (s *Service) Create(ctx context.Context, actor audit.Actor, slug, name, ownerUserID string) (Org, error) {
	slug = strings.ToLower(strings.TrimSpace(slug))
	name = strings.TrimSpace(name)
	if slug == "" || name == "" {
		return Org{}, fmt.Errorf("orgs: create: slug and name required: %w", apperr.ErrInvalid)
	}
	q := s.st.Q()
	if _, err := q.GetOrgBySlug(ctx, slug); err == nil {
		return Org{}, apperr.Conflict{Code: "slug_taken"}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return Org{}, fmt.Errorf("orgs: create: %w", err)
	}
	owner, err := q.GetUserByID(ctx, ownerUserID)
	if errors.Is(err, sql.ErrNoRows) {
		return Org{}, fmt.Errorf("orgs: create: owner %s: %w", ownerUserID, apperr.ErrNotFound)
	} else if err != nil {
		return Org{}, fmt.Errorf("orgs: create: %w", err)
	}
	if owner.Disabled != 0 {
		return Org{}, fmt.Errorf("orgs: create: owner %s is disabled: %w", ownerUserID, apperr.ErrInvalid)
	}

	root := s.rt.With(s.root)
	tenant, err := root.CreateTenant(ctx, runtime.TenantCreate{Name: name, Plan: s.plan})
	if err != nil {
		return Org{}, fmt.Errorf("orgs: create tenant: %w", err)
	}
	key, err := root.CreateTenantKey(ctx, tenant.ID, runtime.KeyCreate{Name: defaultKeyName, Scopes: authz.DefaultKeyScopes()})
	if err != nil {
		return Org{}, s.compensate(ctx, tenant.ID, fmt.Errorf("orgs: create default key: %w", err))
	}
	sealed, err := s.sealer.Seal([]byte(key.Secret))
	if err != nil {
		return Org{}, s.compensate(ctx, tenant.ID, fmt.Errorf("orgs: seal default key: %w", err))
	}

	org := Org{ID: store.NewID("org_"), Slug: slug, Name: name, TenantID: tenant.ID, CreatedAt: s.now().UnixMilli()}
	err = s.st.Tx(ctx, func(tx *db.Queries) error {
		if s.hookInsert != nil {
			if err := s.hookInsert(tx); err != nil {
				return err
			}
		}
		if err := tx.CreateOrg(ctx, db.CreateOrgParams{
			ID: org.ID, Slug: org.Slug, Name: org.Name, TenantID: org.TenantID,
			DefaultKeyID: key.ID, DefaultKeySealed: sealed, CreatedAt: org.CreatedAt,
		}); err != nil {
			if isSlugUnique(err) {
				return apperr.Conflict{Code: "slug_taken"}
			}
			return err
		}
		if err := tx.AddMember(ctx, db.AddMemberParams{OrgID: org.ID, UserID: ownerUserID, Role: "owner"}); err != nil {
			return err
		}
		return s.log().Log(ctx, tx, actor, org.ID, "org.create", org.ID, map[string]string{"slug": slug})
	})
	if err != nil {
		return Org{}, s.compensate(ctx, tenant.ID, fmt.Errorf("orgs: create: %w", err))
	}
	return org, nil
}

// compensate deletes a tenant created for a failed org create. The tenant is brand new, so it is purged.
// If the purge fails the orphan is logged at ERROR with its tenant_id for manual cleanup.
func (s *Service) compensate(ctx context.Context, tenantID string, cause error) error {
	if err := s.rt.With(s.root).DeleteTenant(ctx, tenantID, true); err != nil {
		slog.Error("orgs: compensate tenant failed, orphan tenant left behind", "tenant_id", tenantID, "err", err)
		return errors.Join(cause, fmt.Errorf("orgs: compensate tenant %s: %w", tenantID, err))
	}
	return cause
}

// isSlugUnique reports whether err is the unique-index violation on orgs.slug (a lost create race).
func isSlugUnique(err error) bool {
	msg := err.Error()
	return strings.Contains(msg, "UNIQUE constraint failed") && strings.Contains(msg, "orgs.slug")
}

func (s *Service) log() audit.Writer { return audit.Writer{Now: s.now} }

// Get returns one org, or apperr.ErrNotFound.
func (s *Service) Get(ctx context.Context, orgID string) (Org, error) {
	row, err := s.st.Q().GetOrgByID(ctx, orgID)
	if errors.Is(err, sql.ErrNoRows) {
		return Org{}, fmt.Errorf("orgs: %s: %w", orgID, apperr.ErrNotFound)
	}
	if err != nil {
		return Org{}, fmt.Errorf("orgs: get: %w", err)
	}
	return orgFrom(row), nil
}

// List returns the orgs forUser belongs to, or every org when forUser is empty.
func (s *Service) List(ctx context.Context, forUser string) ([]Org, error) {
	var out []Org
	if forUser == "" {
		rows, err := s.st.Q().ListOrgs(ctx)
		if err != nil {
			return nil, fmt.Errorf("orgs: list: %w", err)
		}
		for _, r := range rows {
			out = append(out, orgFrom(r))
		}
		return out, nil
	}
	rows, err := s.st.Q().ListOrgsForUser(ctx, forUser)
	if err != nil {
		return nil, fmt.Errorf("orgs: list: %w", err)
	}
	for _, r := range rows {
		out = append(out, orgFrom(r))
	}
	return out, nil
}

// Rename changes an org's display name. The slug is immutable.
func (s *Service) Rename(ctx context.Context, actor audit.Actor, orgID, name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("orgs: rename: name required: %w", apperr.ErrInvalid)
	}
	err := s.st.Tx(ctx, func(q *db.Queries) error {
		n, err := q.UpdateOrgName(ctx, db.UpdateOrgNameParams{Name: name, ID: orgID})
		if err != nil {
			return err
		}
		if n == 0 {
			return fmt.Errorf("orgs: %s: %w", orgID, apperr.ErrNotFound)
		}
		return s.log().Log(ctx, q, actor, orgID, "org.rename", orgID, map[string]string{"name": name})
	})
	if err != nil {
		return fmt.Errorf("orgs: rename: %w", err)
	}
	return nil
}

// Delete removes an org and its runtime tenant. A tenant that still owns services is refused up front
// with apperr.Conflict{Code: "org_not_empty"}. The DB delete commits first; if the runtime tenant delete
// then fails the tenant id is logged at ERROR and recorded in an org.delete.runtime_failed audit row so an
// admin can clean up, and the error is returned. The org's audit rows cascade with the org, so the
// audit entries are instance-wide.
func (s *Service) Delete(ctx context.Context, actor audit.Actor, orgID string) error {
	org, err := s.Get(ctx, orgID)
	if err != nil {
		return err
	}
	tenantRoot := s.rt.With(runtime.RootCred{Token: s.root.Token, Tenant: org.TenantID})
	page, err := tenantRoot.ListServices(ctx, runtime.ServiceFilter{})
	switch {
	case runtime.IsNotFound(err):
		// tenant already gone; nothing to refuse
	case err != nil:
		return fmt.Errorf("orgs: delete: list services: %w", err)
	case len(page.Items) > 0:
		return apperr.Conflict{Code: "org_not_empty"}
	}

	err = s.st.Tx(ctx, func(q *db.Queries) error {
		if _, err := q.DeleteOrg(ctx, orgID); err != nil {
			return err
		}
		return s.log().Log(ctx, q, actor, "", "org.delete", orgID, map[string]string{"slug": org.Slug})
	})
	if err != nil {
		return fmt.Errorf("orgs: delete: %w", err)
	}
	s.InvalidateCred(orgID)

	err = s.rt.With(s.root).DeleteTenant(ctx, org.TenantID, false)
	if err == nil || runtime.IsNotFound(err) {
		return nil
	}
	slog.Error("orgs: runtime tenant delete failed after org row removed", "tenant_id", org.TenantID, "org_id", orgID, "err", err)
	detail := map[string]string{"org_id": orgID, "tenant_id": org.TenantID}
	if aerr := s.log().Log(ctx, s.st.Q(), actor, "", "org.delete.runtime_failed", org.TenantID, detail); aerr != nil {
		slog.Error("orgs: record runtime_failed audit", "tenant_id", org.TenantID, "err", aerr)
	}
	return fmt.Errorf("orgs: delete tenant %s: %w", org.TenantID, err)
}

// DefaultCred returns the org's default tenant key, unsealed. Results are cached for 60 seconds.
func (s *Service) DefaultCred(ctx context.Context, orgID string) (runtime.TenantKeyCred, error) {
	now := s.now()
	s.mu.Lock()
	c, ok := s.cache[orgID]
	s.mu.Unlock()
	if ok && now.Before(c.exp) {
		return c.cred, nil
	}
	row, err := s.st.Q().GetOrgByID(ctx, orgID)
	if errors.Is(err, sql.ErrNoRows) {
		return runtime.TenantKeyCred{}, fmt.Errorf("orgs: %s: %w", orgID, apperr.ErrNotFound)
	}
	if err != nil {
		return runtime.TenantKeyCred{}, fmt.Errorf("orgs: default cred: %w", err)
	}
	plain, err := s.sealer.Open(row.DefaultKeySealed)
	if err != nil {
		return runtime.TenantKeyCred{}, fmt.Errorf("orgs: open default key: %w", err)
	}
	cred := runtime.TenantKeyCred{Secret: string(plain)}
	s.mu.Lock()
	s.cache[orgID] = cachedCred{cred: cred, exp: now.Add(credTTL)}
	s.mu.Unlock()
	return cred, nil
}

// InvalidateCred drops the cached default key for orgID.
func (s *Service) InvalidateCred(orgID string) {
	s.mu.Lock()
	delete(s.cache, orgID)
	s.mu.Unlock()
}

func orgFrom(r db.Org) Org {
	return Org{ID: r.ID, Slug: r.Slug, Name: r.Name, TenantID: r.TenantID, CreatedAt: r.CreatedAt}
}
