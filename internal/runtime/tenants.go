package runtime

import (
	"context"
	"net/http"
	"net/url"
)

// CreateTenant: POST /v1/tenants (operator).
func (s *Scoped) CreateTenant(ctx context.Context, in TenantCreate) (Tenant, error) {
	var out Tenant
	err := s.doJSON(ctx, http.MethodPost, "/v1/tenants", in, &out)
	return out, err
}

// DeleteTenant: DELETE /v1/tenants/{t}?purge=1 when purge.
func (s *Scoped) DeleteTenant(ctx context.Context, tenantID string, purge bool) error {
	q := url.Values{}
	if purge {
		q.Set("purge", "1")
	}
	_, err := s.do(ctx, req{method: http.MethodDelete, path: "/v1/tenants/" + seg(tenantID), query: q}, nil)
	return err
}

// CreateTenantKey: POST /v1/tenants/{t}/keys.
func (s *Scoped) CreateTenantKey(ctx context.Context, tenantID string, in KeyCreate) (KeyCreated, error) {
	var out KeyCreated
	err := s.doJSON(ctx, http.MethodPost, "/v1/tenants/"+seg(tenantID)+"/keys", in, &out)
	return out, err
}

// RevokeTenantKey: DELETE /v1/tenants/{t}/keys/{key}.
func (s *Scoped) RevokeTenantKey(ctx context.Context, tenantID, keyID string) error {
	return s.doJSON(ctx, http.MethodDelete, "/v1/tenants/"+seg(tenantID)+"/keys/"+seg(keyID), nil, nil)
}

// TenantUsage: GET /v1/tenants/{t}/usage.
func (s *Scoped) TenantUsage(ctx context.Context, tenantID string) ([]Usage, error) {
	var out []Usage
	err := s.doJSON(ctx, http.MethodGet, "/v1/tenants/"+seg(tenantID)+"/usage", nil, &out)
	return out, err
}

// Limits: GET /v1/limits (operator needs x-rt-tenant).
func (s *Scoped) Limits(ctx context.Context) (Limits, error) {
	var out Limits
	err := s.doJSON(ctx, http.MethodGet, "/v1/limits", nil, &out)
	return out, err
}

// Me: GET /v1/me.
func (s *Scoped) Me(ctx context.Context) (Me, error) {
	var out Me
	err := s.doJSON(ctx, http.MethodGet, "/v1/me", nil, &out)
	return out, err
}

// ListProjects: GET /v1/projects?cursor=.
func (s *Scoped) ListProjects(ctx context.Context, cursor string) (Page[Project], error) {
	var out Page[Project]
	_, err := s.do(ctx, req{method: http.MethodGet, path: "/v1/projects", query: pageQuery(cursor)}, &out)
	return out, err
}

// CreateProject: POST /v1/projects.
func (s *Scoped) CreateProject(ctx context.Context, in ProjectCreate) (Project, error) {
	var out Project
	err := s.doJSON(ctx, http.MethodPost, "/v1/projects", in, &out)
	return out, err
}

// UpdateProject: PATCH /v1/projects/{p} (slug or prj_ id).
func (s *Scoped) UpdateProject(ctx context.Context, project string, in ProjectPatch) (Project, error) {
	var out Project
	err := s.doJSON(ctx, http.MethodPatch, "/v1/projects/"+seg(project), in, &out)
	return out, err
}

// DeleteProject: DELETE /v1/projects/{p}.
func (s *Scoped) DeleteProject(ctx context.Context, project string) error {
	return s.doJSON(ctx, http.MethodDelete, "/v1/projects/"+seg(project), nil, nil)
}
