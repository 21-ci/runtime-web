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

// validScopes are the scopes a key may carry.
var validScopes = map[string]bool{
	"services:read": true, "services:write": true, "deploy": true, "invoke": true,
	"logs:read": true, "env:write": true, "secrets:write": true, "queue:write": true,
	"data:admin": true, "keys:write": true,
}

type tenant struct {
	id, name, plan string
	overrides      json.RawMessage
	createdAt      int64
}

func (t *tenant) view() runtime.Tenant {
	return runtime.Tenant{ID: t.id, Name: t.name, Plan: t.plan, Overrides: t.overrides, CreatedAt: t.createdAt}
}

// apiKey is a tenant key. parent is the creator's id for keys minted through
// POST /v1/keys; revoking a parent revokes its descendants.
type apiKey struct {
	id, tenantID, name, secret, parent string
	scopes                             []string
	serviceIDs                         []string
	createdAt                          int64
	expiresAt                          *time.Time
	revoked                            bool
}

func (k *apiKey) hasScope(scope string) bool { return contains(k.scopes, scope) }

func (k *apiKey) active(now time.Time) bool {
	return !k.revoked && (k.expiresAt == nil || now.Before(*k.expiresAt))
}

func (k *apiKey) view() runtime.Key {
	v := runtime.Key{ID: k.id, Scopes: k.scopes, ServiceIDs: k.serviceIDs, CreatedAt: k.createdAt}
	if v.ServiceIDs == nil {
		v.ServiceIDs = []string{}
	}
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
	f.route(mux, "POST /v1/tenants", operatorScope, f.createTenant)
	f.route(mux, "DELETE /v1/tenants/{t}", operatorScope, f.deleteTenant)
	f.route(mux, "POST /v1/tenants/{t}/keys", operatorScope, f.createTenantKey)
	f.route(mux, "DELETE /v1/tenants/{t}/keys/{key}", operatorScope, f.revokeTenantKey)
	f.route(mux, "GET /v1/tenants/{t}/usage", "logs:read", f.tenantUsage)
	f.route(mux, "POST /v1/keys", "keys:write", f.createOwnKey)
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
	for id, s := range f.services {
		if s.tenantID == t.id {
			delete(f.services, id)
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

// createOwnKey is POST /v1/keys: a key with keys:write mints a narrower child key.
func (f *Fake) createOwnKey(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	if p.tenant == "" {
		return invalid("x-rt-tenant is required")
	}
	var in runtime.KeyCreate
	if e := decode(r, &in); e != nil {
		return e
	}
	k, e := f.issueKey(p.tenant, in, p.key)
	if e != nil {
		return e
	}
	writeJSON(w, http.StatusCreated, k.created())
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
	services, e := f.keyServices(tenantID, in.Services, creator)
	if e != nil {
		return nil, e
	}
	expires, e := keyExpiry(in.ExpiresAt, creator)
	if e != nil {
		return nil, e
	}
	k := &apiKey{
		id:         newID("key_"),
		tenantID:   tenantID,
		name:       in.Name,
		secret:     randHex(16),
		scopes:     slices.Clone(in.Scopes),
		serviceIDs: services,
		createdAt:  nowMS(),
		expiresAt:  expires,
	}
	if creator != nil {
		k.parent = creator.id
	}
	f.keys[k.id] = k
	return k, nil
}

func (f *Fake) keyServices(tenantID string, asked []string, creator *apiKey) ([]string, *apiError) {
	if creator != nil && len(creator.serviceIDs) > 0 {
		if len(asked) == 0 {
			return slices.Clone(creator.serviceIDs), nil
		}
		for _, id := range asked {
			if !contains(creator.serviceIDs, id) {
				return nil, escalation()
			}
		}
		return slices.Clone(asked), nil
	}
	for _, id := range asked {
		if s := f.services[id]; s == nil || s.tenantID != tenantID {
			return nil, invalid("service %s is not in this tenant", id)
		}
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
	out := runtime.Me{Principal: "operator", Scopes: []string{}, ServiceIDs: []string{}, Version: fakeVersion}
	if p.key != nil {
		kid := p.key.id
		out.Principal = "tenant"
		out.KeyID = &kid
		out.Scopes = p.key.scopes
		out.ServiceIDs = p.key.serviceIDs
		if out.ServiceIDs == nil {
			out.ServiceIDs = []string{}
		}
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
