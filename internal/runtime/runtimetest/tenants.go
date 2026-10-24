package runtimetest

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"slices"
	"time"

	"github.com/21cloud/runtime-web/internal/runtime"
)

// maxSelfServiceKeys is the live self-service key cap per tenant.
const maxSelfServiceKeys = 200

// validScopes are the scopes a key may carry.
var validScopes = map[string]bool{
	"services:read": true, "services:write": true, "deploy": true, "invoke": true,
	"logs:read": true, "env:write": true, "secrets:write": true, "queue:write": true,
	"data:admin": true, "keys:write": true, "sockets:write": true,
}

type tenant struct {
	id, name, plan string
	overrides      json.RawMessage
	createdAt      int64
	disabled       bool
}

func (t *tenant) view() runtime.Tenant {
	return runtime.Tenant{
		ID: t.id, Name: t.name, Plan: t.plan, Overrides: t.overrides,
		CreatedAt: t.createdAt, Disabled: t.disabled,
	}
}

// apiKey is a tenant key. parent is the creator's id for keys minted through
// POST /v1/keys; revoking a parent revokes its descendants. selfService marks
// keys counted against the self-service cap.
type apiKey struct {
	id, tenantID, name, secret, parent string
	scopes                             []string
	projectIDs, environments           []string // nil = all
	createdAt                          int64
	expiresAt                          *time.Time
	revoked                            bool
	selfService                        bool
}

func (k *apiKey) hasScope(scope string) bool { return contains(k.scopes, scope) }

func (k *apiKey) active(now time.Time) bool {
	return !k.revoked && (k.expiresAt == nil || now.Before(*k.expiresAt))
}

// restricted reports whether k is limited to some projects or environments. A nil key
// (the operator) is not.
func (k *apiKey) restricted() bool {
	return k != nil && (k.projectIDs != nil || k.environments != nil)
}

// allows reports whether k may touch a service in projectID and environment. A nil key allows all.
func (k *apiKey) allows(projectID, environment string) bool {
	if k == nil {
		return true
	}
	return (k.projectIDs == nil || contains(k.projectIDs, projectID)) &&
		(k.environments == nil || contains(k.environments, environment))
}

// canManage reports whether p may see or revoke k: a restricted key manages only keys
// whose projects and environments are subsets of its own.
func (p principal) canManage(k *apiKey) bool {
	if p.key == nil {
		return true
	}
	return subset(k.projectIDs, p.key.projectIDs) && subset(k.environments, p.key.environments)
}

// subset reports whether child ⊆ parent, where nil means all.
func subset(child, parent []string) bool {
	if parent == nil {
		return true
	}
	if child == nil {
		return false
	}
	for _, v := range child {
		if !contains(parent, v) {
			return false
		}
	}
	return true
}

func (k *apiKey) view() runtime.Key {
	v := runtime.Key{ID: k.id, Scopes: k.scopes, ProjectIDs: k.projectIDs, Environments: k.environments, CreatedAt: k.createdAt}
	if k.name != "" {
		name := k.name
		v.Name = &name
	}
	if k.expiresAt != nil {
		ms := k.expiresAt.UnixMilli()
		v.ExpiresAt = &ms
	}
	return v
}

func (k *apiKey) created() runtime.KeyCreated {
	return runtime.KeyCreated{Key: k.view(), Secret: "rtk_" + k.id + "_" + k.secret}
}

func (f *Fake) tenantRoutes(mux *http.ServeMux) {
	f.route(mux, "GET /v1/tenants", operatorScope, f.listTenants)
	f.route(mux, "POST /v1/tenants", operatorScope, f.createTenant)
	f.route(mux, "GET /v1/tenants/{t}", operatorScope, f.getTenant)
	f.route(mux, "PATCH /v1/tenants/{t}", operatorScope, f.patchTenant)
	f.route(mux, "DELETE /v1/tenants/{t}", operatorScope, f.deleteTenant)
	f.route(mux, "POST /v1/tenants/{t}/keys", operatorScope, f.createTenantKey)
	f.route(mux, "DELETE /v1/tenants/{t}/keys/{key}", operatorScope, f.revokeTenantKey)
	f.route(mux, "GET /v1/tenants/{t}/usage", "logs:read", f.tenantUsage)
	f.route(mux, "GET /v1/plans", operatorScope, f.listPlans)
	f.route(mux, "GET /v1/version", "", f.version)
	f.route(mux, "GET /v1/keys", "keys:write", f.listOwnKeys)
	f.route(mux, "POST /v1/keys", "keys:write", f.createOwnKey)
	f.route(mux, "DELETE /v1/keys/{key}", "keys:write", f.revokeOwnKey)
	f.route(mux, "GET /v1/me", "", f.me)
	f.route(mux, "GET /v1/limits", "", f.limits)
}

// tenantFor resolves tenant id for p. Another tenant's id, like an unknown one, is 404.
func (f *Fake) tenantFor(p principal, id string) (*tenant, *apiError) {
	t := f.tenants[id]
	if t == nil || (p.tenant != "" && p.tenant != id) {
		return nil, notFound()
	}
	return t, nil
}

func (f *Fake) listTenants(_ principal, w http.ResponseWriter, _ *http.Request) *apiError {
	var ids []string
	for id := range f.tenants {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	items := []runtime.Tenant{}
	for _, id := range ids {
		items = append(items, f.tenants[id].view())
	}
	writeJSON(w, http.StatusOK, runtime.Page[runtime.Tenant]{Items: items})
	return nil
}

func (f *Fake) getTenant(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	t, e := f.tenantFor(p, r.PathValue("t"))
	if e != nil {
		return e
	}
	writeJSON(w, http.StatusOK, t.view())
	return nil
}

// patchTenant changes name, plan, overrides or disabled. A plan change applies
// to the tenant's limits at once.
func (f *Fake) patchTenant(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	t, e := f.tenantFor(p, r.PathValue("t"))
	if e != nil {
		return e
	}
	var in runtime.TenantPatch
	if e := decode(r, &in); e != nil {
		return e
	}
	if in.Name != nil {
		if *in.Name == "" {
			return invalid("name must not be empty")
		}
		t.name = *in.Name
	}
	if in.Plan != nil {
		if _, ok := f.plans[*in.Plan]; !ok {
			return invalid("unknown plan %q", *in.Plan)
		}
		t.plan = *in.Plan
	}
	if len(in.Overrides) > 0 {
		t.overrides = in.Overrides
	}
	if in.Disabled != nil {
		t.disabled = *in.Disabled
	}
	writeJSON(w, http.StatusOK, t.view())
	return nil
}

func (f *Fake) listPlans(_ principal, w http.ResponseWriter, _ *http.Request) *apiError {
	var names []string
	for name := range f.plans {
		names = append(names, name)
	}
	slices.Sort(names)
	out := []runtime.Plan{}
	for _, name := range names {
		out = append(out, planView(name, f.plans[name]))
	}
	writeJSON(w, http.StatusOK, out)
	return nil
}

func (f *Fake) version(_ principal, w http.ResponseWriter, _ *http.Request) *apiError {
	writeJSON(w, http.StatusOK, runtime.VersionInfo{Version: fakeVersion, API: "1"})
	return nil
}

func (f *Fake) createTenant(_ principal, w http.ResponseWriter, r *http.Request) *apiError {
	var in runtime.TenantCreate
	if e := decode(r, &in); e != nil {
		return e
	}
	if in.Name == "" {
		return invalid("name is required")
	}
	if _, ok := f.plans[in.Plan]; !ok {
		return invalid("unknown plan %q", in.Plan)
	}
	t := &tenant{id: newID("ten_"), name: in.Name, plan: in.Plan, overrides: in.Overrides, createdAt: nowMS()}
	f.tenants[t.id] = t
	def := newProject(t.id, "default", "default", []string{"production"})
	f.projects[def.id] = def
	writeJSON(w, http.StatusCreated, t.view())
	return nil
}

func (f *Fake) deleteTenant(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	t, e := f.tenantFor(p, r.PathValue("t"))
	if e != nil {
		return e
	}
	if !truthy(r.URL.Query().Get("purge")) && f.countServices(t.id) > 0 {
		return conflict("tenant_not_empty", "tenant still owns services")
	}
	for _, s := range f.services {
		if s.tenantID == t.id {
			f.dropService(s)
		}
	}
	for id, pr := range f.projects {
		if pr.tenantID == t.id {
			delete(f.projects, id)
		}
	}
	for id, k := range f.keys {
		if k.tenantID == t.id {
			delete(f.keys, id)
		}
	}
	delete(f.tenants, t.id)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (f *Fake) createTenantKey(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	t, e := f.tenantFor(p, r.PathValue("t"))
	if e != nil {
		return e
	}
	var in runtime.KeyCreate
	if e := decode(r, &in); e != nil {
		return e
	}
	k, e := f.issueKey(t.id, in, nil)
	if e != nil {
		return e
	}
	writeJSON(w, http.StatusCreated, k.created())
	return nil
}

// listOwnKeys lists the live keys of the caller's tenant that the caller may manage.
func (f *Fake) listOwnKeys(p principal, w http.ResponseWriter, _ *http.Request) *apiError {
	if p.tenant == "" {
		return invalid("x-rt-tenant is required")
	}
	now := time.Now()
	var ids []string
	for id, k := range f.keys {
		if k.tenantID == p.tenant && k.active(now) && p.canManage(k) {
			ids = append(ids, id)
		}
	}
	slices.Sort(ids)
	items := []runtime.Key{}
	for _, id := range ids {
		items = append(items, f.keys[id].view())
	}
	writeJSON(w, http.StatusOK, items)
	return nil
}

// createOwnKey is POST /v1/keys: a key with keys:write mints a narrower child key.
// A tenant holds at most maxSelfServiceKeys live keys created this way.
func (f *Fake) createOwnKey(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	if p.tenant == "" {
		return invalid("x-rt-tenant is required")
	}
	var in runtime.KeyCreate
	if e := decode(r, &in); e != nil {
		return e
	}
	now := time.Now()
	live := 0
	for _, k := range f.keys {
		if k.tenantID == p.tenant && k.selfService && k.active(now) {
			live++
		}
	}
	if live >= maxSelfServiceKeys {
		return forbidden("quota_exceeded", "tenant holds the maximum of live self-service keys", map[string]any{"quota": "keys"})
	}
	k, e := f.issueKey(p.tenant, in, p.key)
	if e != nil {
		return e
	}
	k.selfService = true
	writeJSON(w, http.StatusCreated, k.created())
	return nil
}

// revokeOwnKey is DELETE /v1/keys/{key}. Keys the caller cannot manage are
// not found; a key holding a scope the caller lacks is refused with 403.
func (f *Fake) revokeOwnKey(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	if p.tenant == "" {
		return invalid("x-rt-tenant is required")
	}
	k := f.keys[r.PathValue("key")]
	if k == nil || k.tenantID != p.tenant || k.revoked || !p.canManage(k) {
		return notFound()
	}
	if p.key != nil {
		for _, s := range k.scopes {
			if !p.key.hasScope(s) {
				return insufficientScope(map[string]any{"reason": "stronger_key", "scope": s})
			}
		}
	}
	f.revoke(k)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// issueKey creates a key in tenantID. A non-nil creator (a tenant key) caps the
// new key's scopes, services and expiry at its own; otherwise the operator
// may grant anything within the tenant.
func (f *Fake) issueKey(tenantID string, in runtime.KeyCreate, creator *apiKey) (*apiKey, *apiError) {
	if len(in.Scopes) == 0 {
		return nil, invalid("scopes must not be empty")
	}
	for _, s := range in.Scopes {
		if !validScopes[s] {
			return nil, invalid("unknown scope %q", s)
		}
		if creator != nil && !creator.hasScope(s) {
			return nil, escalation()
		}
	}
	projects, e := f.keyProjects(tenantID, in.ProjectIDs, creator)
	if e != nil {
		return nil, e
	}
	var parentEnvs []string
	if creator != nil {
		parentEnvs = creator.environments
	}
	envs, e := narrow(in.Environments, parentEnvs)
	if e != nil {
		return nil, e
	}
	expires, e := keyExpiry(in.ExpiresAt, creator)
	if e != nil {
		return nil, e
	}
	k := &apiKey{
		id:           newID("key_"),
		tenantID:     tenantID,
		name:         in.Name,
		secret:       randHex(16),
		scopes:       slices.Clone(in.Scopes),
		projectIDs:   projects,
		environments: envs,
		createdAt:    nowMS(),
		expiresAt:    expires,
	}
	if creator != nil {
		k.parent = creator.id
	}
	f.keys[k.id] = k
	return k, nil
}

// keyProjects checks asked project ids against tenantID and the creator's own restriction.
func (f *Fake) keyProjects(tenantID string, asked []string, creator *apiKey) ([]string, *apiError) {
	for _, id := range asked {
		if pr := f.projects[id]; pr == nil || pr.tenantID != tenantID {
			return nil, invalid("project %s is not in this tenant", id)
		}
	}
	var parent []string
	if creator != nil {
		parent = creator.projectIDs
	}
	return narrow(asked, parent)
}

// narrow returns the asked list capped by parent (nil = all): an empty ask inherits parent, and
// asking for anything outside parent is an escalation.
func narrow(asked, parent []string) ([]string, *apiError) {
	if len(asked) == 0 {
		return slices.Clone(parent), nil
	}
	if !subset(asked, parent) {
		return nil, escalation()
	}
	return slices.Clone(asked), nil
}

func keyExpiry(raw string, creator *apiKey) (*time.Time, *apiError) {
	var at *time.Time
	if raw != "" {
		t, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			return nil, invalid("expires_at must be RFC 3339")
		}
		if !t.After(time.Now()) {
			return nil, invalid("expires_at is in the past")
		}
		at = &t
	}
	if creator == nil || creator.expiresAt == nil {
		return at, nil
	}
	if at == nil {
		inherited := *creator.expiresAt
		return &inherited, nil
	}
	if at.After(*creator.expiresAt) {
		return nil, escalation()
	}
	return at, nil
}

func escalation() *apiError {
	return insufficientScope(map[string]any{"reason": "escalation"})
}

func (f *Fake) revokeTenantKey(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	t, e := f.tenantFor(p, r.PathValue("t"))
	if e != nil {
		return e
	}
	k := f.keys[r.PathValue("key")]
	if k == nil || k.tenantID != t.id || k.revoked {
		return notFound()
	}
	f.revoke(k)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// revoke marks k and, recursively, every key it minted as revoked.
func (f *Fake) revoke(k *apiKey) {
	k.revoked = true
	for _, c := range f.keys {
		if c.parent == k.id && !c.revoked {
			f.revoke(c)
		}
	}
}

func (f *Fake) tenantUsage(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	if _, e := f.tenantFor(p, r.PathValue("t")); e != nil {
		return e
	}
	writeJSON(w, http.StatusOK, []runtime.Usage{})
	return nil
}

func (f *Fake) me(p principal, w http.ResponseWriter, _ *http.Request) *apiError {
	out := runtime.Me{Principal: "operator", Scopes: []string{}, Version: fakeVersion}
	if p.key != nil {
		kid := p.key.id
		out.Principal = "tenant"
		out.KeyID = &kid
		out.Scopes = p.key.scopes
		out.ProjectIDs = p.key.projectIDs
		out.Environments = p.key.environments
	}
	if p.tenant != "" {
		tid := p.tenant
		out.TenantID = &tid
		if t := f.tenants[tid]; t != nil {
			plan := planView(t.plan, f.plans[t.plan])
			out.Plan = &plan
		}
	}
	writeJSON(w, http.StatusOK, out)
	return nil
}

func (f *Fake) limits(p principal, w http.ResponseWriter, _ *http.Request) *apiError {
	if p.tenant == "" {
		return invalid("x-rt-tenant is required")
	}
	t := f.tenants[p.tenant]
	plan := f.plans[t.plan]
	day := time.Now().UTC()
	out := runtime.Limits{
		Plan:         t.plan,
		Day:          day.Format("2006-01-02"),
		ResetsAt:     day.Truncate(24 * time.Hour).Add(24 * time.Hour).UnixMilli(),
		Invocations:  quota(0, 0, "day"),
		EgressBytes:  quota(0, 0, "day"),
		StorageBytes: quota(0, 0, "total"),
		Services:     quota(plan.MaxServices, f.countServices(t.id), "total"),
		Schedules:    quota(plan.MaxSchedules, 0, "per_service"),
	}
	writeJSON(w, http.StatusOK, out)
	return nil
}

// quota builds a QuotaView; a zero limit is unlimited (nil limit and remaining).
func quota(limit, used int, period string) runtime.Quota {
	q := runtime.Quota{Used: int64(used), Period: period}
	if limit > 0 {
		l := int64(limit)
		rem := max(l-int64(used), 0)
		q.Limit = &l
		q.Remaining = &rem
	}
	return q
}

func planView(name string, p FakePlan) runtime.Plan {
	settings, _ := json.Marshal(map[string]any{
		"max_services":     p.MaxServices,
		"max_schedules":    p.MaxSchedules,
		"allowed_triggers": p.Triggers,
	})
	return runtime.Plan{Name: name, Settings: settings}
}

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("runtimetest: rand: " + err.Error())
	}
	return hex.EncodeToString(b)
}
