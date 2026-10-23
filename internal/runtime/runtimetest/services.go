package runtimetest

import (
	"encoding/json"
	"net/http"
	"regexp"
	"slices"
	"strconv"

	"github.com/21cloud/runtime-web/internal/runtime"
)

var (
	slugRE = regexp.MustCompile(`^[a-z][a-z0-9-]{1,62}$`)
	envRE  = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
)

// triggerKinds are the keys of a service's triggers block.
var triggerKinds = []string{"http", "interval", "cron", "queue", "call"}

type service struct {
	id, tenantID, slug, runtime string
	name, profile               *string
	project, environment        string
	access                      string
	etag                        int
	liveVersion                 *int
	limits, scaling, triggers   json.RawMessage
	ingress, egress, call       json.RawMessage
	deno, wasm                  json.RawMessage
}

func (s *service) etagValue() string { return `"` + strconv.Itoa(s.etag) + `"` }

func (s *service) view() runtime.Service {
	return runtime.Service{
		ID: s.id, TenantID: s.tenantID, Slug: s.slug, Runtime: s.runtime,
		Name: s.name, Profile: s.profile, Project: s.project, Environment: s.environment,
		LiveVersion: s.liveVersion, ETag: s.etagValue(), Access: s.access,
		Limits: s.limits, Scaling: s.scaling, Triggers: s.triggers,
		Ingress: s.ingress, Egress: s.egress, Call: s.call, Deno: s.deno, Wasm: s.wasm,
		Status: runtime.ServiceStatus{Tier: "T1"},
	}
}

func (f *Fake) serviceRoutes(mux *http.ServeMux) {
	f.route(mux, "POST /v1/services", "services:write", f.createService)
	f.route(mux, "GET /v1/services", "services:read", f.listServices)
	f.route(mux, "GET /v1/services/{s}", "services:read", f.getService)
	f.route(mux, "PATCH /v1/services/{s}", "services:write", f.patchService)
	f.route(mux, "DELETE /v1/services/{s}", "services:write", f.deleteService)
}

// serviceFor resolves svc id for p; another tenant's or an out-of-reach service is 404.
func (f *Fake) serviceFor(p principal, id string) (*service, *apiError) {
	s := f.services[id]
	if s == nil || !p.sees(s) {
		return nil, notFound()
	}
	return s, nil
}

func (f *Fake) countServices(tenantID string) int {
	n := 0
	for _, s := range f.services {
		if s.tenantID == tenantID {
			n++
		}
	}
	return n
}

// serviceList returns the services sorted by slug.
func (f *Fake) serviceList() []*service {
	out := make([]*service, 0, len(f.services))
	for _, s := range f.services {
		out = append(out, s)
	}
	slices.SortFunc(out, func(a, b *service) int {
		switch {
		case a.slug < b.slug:
			return -1
		case a.slug > b.slug:
			return 1
		}
		return 0
	})
	return out
}

func writeService(w http.ResponseWriter, status int, s *service) {
	w.Header().Set("ETag", s.etagValue())
	writeJSON(w, status, s.view())
}

func (f *Fake) createService(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	var in runtime.ServiceCreate
	if e := decode(r, &in); e != nil {
		return e
	}
	if p.tenant == "" {
		return invalid("x-rt-tenant is required to create a service")
	}
	if !slugRE.MatchString(in.Slug) {
		return invalid("slug %q is not valid", in.Slug)
	}
	if in.Runtime != "deno" && in.Runtime != "wasm" {
		return invalid("runtime must be deno or wasm")
	}
	access := orDefault(in.Access, "public")
	environment := orDefault(in.Environment, "production")
	if !validAccess(access) {
		return invalid("access must be public, key or internal")
	}
	if !envRE.MatchString(environment) {
		return invalid("environment %q is not valid", environment)
	}
	for _, s := range f.services {
		if s.slug == in.Slug {
			return conflict("slug_taken", "service slug is already in use on this node")
		}
	}
	plan := f.plans[f.tenants[p.tenant].plan]
	if err := checkTriggers(plan.Triggers, in.Triggers); err != nil {
		return err
	}
	if plan.MaxServices > 0 && f.countServices(p.tenant) >= plan.MaxServices {
		return forbidden("quota_exceeded", "plan service limit reached", map[string]any{"quota": "services"})
	}
	s := &service{
		id: newID("svc_"), tenantID: p.tenant, slug: in.Slug, runtime: in.Runtime,
		name: in.Name, profile: in.Profile,
		project: orDefault(in.Project, "default"), environment: environment, access: access,
		etag:   1,
		limits: in.Limits, scaling: in.Scaling, triggers: in.Triggers,
		ingress: in.Ingress, egress: in.Egress, call: in.Call, deno: in.Deno, wasm: in.Wasm,
	}
	f.services[s.id] = s
	writeService(w, http.StatusCreated, s)
	return nil
}

func (f *Fake) listServices(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	q := r.URL.Query()
	items := []runtime.Service{}
	for _, s := range f.serviceList() {
		if !p.sees(s) {
			continue
		}
		if v := q.Get("slug"); v != "" && s.slug != v {
			continue
		}
		if v := q.Get("project"); v != "" && s.project != v {
			continue
		}
		if v := q.Get("environment"); v != "" && s.environment != v {
			continue
		}
		items = append(items, s.view())
	}
	writeJSON(w, http.StatusOK, runtime.Page[runtime.Service]{Items: items})
	return nil
}

func (f *Fake) getService(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	writeService(w, http.StatusOK, s)
	return nil
}

func (f *Fake) patchService(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	if ifMatch := r.Header.Get("If-Match"); ifMatch != "" && ifMatch != s.etagValue() {
		return &apiError{status: http.StatusPreconditionFailed, code: "precondition_failed", msg: "If-Match does not match the current etag"}
	}
	var in runtime.ServicePatch
	if e := decode(r, &in); e != nil {
		return e
	}
	if in.Project != nil && *in.Project != s.project {
		return invalid("project cannot change")
	}
	if in.Access != nil && !validAccess(*in.Access) {
		return invalid("access must be public, key or internal")
	}
	if in.Environment != nil && !envRE.MatchString(*in.Environment) {
		return invalid("environment %q is not valid", *in.Environment)
	}
	if err := checkTriggers(f.plans[f.tenants[s.tenantID].plan].Triggers, in.Triggers); err != nil {
		return err
	}
	if in.Name != nil {
		s.name = in.Name
	}
	if in.Profile != nil {
		s.profile = in.Profile
	}
	if in.Environment != nil {
		s.environment = *in.Environment
	}
	if in.Access != nil {
		s.access = *in.Access
	}
	// Each provided block replaces that block.
	replace(&s.limits, in.Limits)
	replace(&s.scaling, in.Scaling)
	replace(&s.triggers, in.Triggers)
	replace(&s.ingress, in.Ingress)
	replace(&s.egress, in.Egress)
	replace(&s.call, in.Call)
	replace(&s.deno, in.Deno)
	replace(&s.wasm, in.Wasm)
	s.etag++
	writeService(w, http.StatusOK, s)
	return nil
}

func (f *Fake) deleteService(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	delete(f.services, s.id)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func replace(dst *json.RawMessage, v json.RawMessage) {
	if len(v) > 0 {
		*dst = v
	}
}

// checkTriggers rejects enabling a trigger the plan does not allow. Triggers
// the request does not mention keep their defaults.
func checkTriggers(allowed []string, raw json.RawMessage) *apiError {
	if len(raw) == 0 {
		return nil
	}
	var on map[string]bool
	if err := json.Unmarshal(raw, &on); err != nil {
		return invalid("triggers must be an object of booleans")
	}
	for kind, enabled := range on {
		if !slices.Contains(triggerKinds, kind) {
			return invalid("unknown trigger %q", kind)
		}
		if enabled && !slices.Contains(allowed, kind) {
			return forbidden("trigger_not_allowed", "trigger "+kind+" is not allowed by the plan", map[string]any{"trigger": kind})
		}
	}
	return nil
}

func validAccess(a string) bool {
	return a == "public" || a == "key" || a == "internal"
}

func orDefault(p *string, def string) string {
	if p == nil || *p == "" {
		return def
	}
	return *p
}
