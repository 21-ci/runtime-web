package runtime

import (
	"context"
	"encoding/json"
	"net/http"
)

// VersionInfo is GET /v1/version.
type VersionInfo struct {
	Version string `json:"version"`
	API     string `json:"api"`
}

// TenantPatch is PatchTenantBody; nil fields are unchanged.
type TenantPatch struct {
	Name      *string         `json:"name,omitempty"`
	Plan      *string         `json:"plan,omitempty"`
	Overrides json.RawMessage `json:"overrides,omitempty"`
	Disabled  *bool           `json:"disabled,omitempty"`
}

// ProjectEnvironments is GET /v1/projects/{p}/environments.
type ProjectEnvironments struct {
	Project      string   `json:"project"`
	Environments []string `json:"environments"`
}

// ListKeys: GET /v1/keys (keys:write; the caller's own tenant, no secrets).
func (s *Scoped) ListKeys(ctx context.Context) ([]Key, error) {
	var out []Key
	err := s.doJSON(ctx, http.MethodGet, "/v1/keys", nil, &out)
	return out, err
}

// CreateKey: POST /v1/keys (keys:write); the secret is returned once.
func (s *Scoped) CreateKey(ctx context.Context, in KeyCreate) (KeyCreated, error) {
	var out KeyCreated
	err := s.doJSON(ctx, http.MethodPost, "/v1/keys", in, &out)
	return out, err
}

// RevokeKey: DELETE /v1/keys/{key} (keys:write).
func (s *Scoped) RevokeKey(ctx context.Context, keyID string) error {
	return s.doJSON(ctx, http.MethodDelete, "/v1/keys/"+seg(keyID), nil, nil)
}

// ListTenants: GET /v1/tenants (operator).
func (s *Scoped) ListTenants(ctx context.Context, cursor string) (Page[Tenant], error) {
	var out Page[Tenant]
	_, err := s.do(ctx, req{method: http.MethodGet, path: "/v1/tenants", query: pageQuery(cursor)}, &out)
	return out, err
}

// GetTenant: GET /v1/tenants/{t} (operator).
func (s *Scoped) GetTenant(ctx context.Context, tenantID string) (Tenant, error) {
	var out Tenant
	err := s.doJSON(ctx, http.MethodGet, "/v1/tenants/"+seg(tenantID), nil, &out)
	return out, err
}

// UpdateTenant: PATCH /v1/tenants/{t} (operator).
func (s *Scoped) UpdateTenant(ctx context.Context, tenantID string, in TenantPatch) (Tenant, error) {
	var out Tenant
	err := s.doJSON(ctx, http.MethodPatch, "/v1/tenants/"+seg(tenantID), in, &out)
	return out, err
}

// ListPlans: GET /v1/plans (operator).
func (s *Scoped) ListPlans(ctx context.Context) ([]Plan, error) {
	var out []Plan
	err := s.doJSON(ctx, http.MethodGet, "/v1/plans", nil, &out)
	return out, err
}

// RuntimeVersion: GET /v1/version.
func (s *Scoped) RuntimeVersion(ctx context.Context) (VersionInfo, error) {
	var out VersionInfo
	err := s.doJSON(ctx, http.MethodGet, "/v1/version", nil, &out)
	return out, err
}

// GetProject: GET /v1/projects/{p} (slug or prj_ id).
func (s *Scoped) GetProject(ctx context.Context, project string) (Project, error) {
	var out Project
	err := s.doJSON(ctx, http.MethodGet, "/v1/projects/"+seg(project), nil, &out)
	return out, err
}

// GetProjectEnvironments: GET /v1/projects/{p}/environments.
func (s *Scoped) GetProjectEnvironments(ctx context.Context, project string) (ProjectEnvironments, error) {
	var out ProjectEnvironments
	err := s.doJSON(ctx, http.MethodGet, "/v1/projects/"+seg(project)+"/environments", nil, &out)
	return out, err
}
