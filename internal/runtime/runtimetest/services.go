package runtimetest

import (
	"encoding/json"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/21cloud/runtime-web/internal/runtime"
)

var (
	slugRE   = regexp.MustCompile(`^[a-z][a-z0-9-]{1,62}$`)
	envRE    = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
	secretRE = regexp.MustCompile(`^[A-Z_][A-Z0-9_]*$`)
)

// triggerKinds are the keys of a service's triggers block.
var triggerKinds = []string{"http", "interval", "cron", "queue", "call"}

const (
	maxEnvEntries = 100
	maxValueBytes = 32 << 10
	minIntervalS  = 60
	maxDelayS     = 7 * 24 * 3600
)

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

	versions  []*version
	env       map[string]string
	secrets   map[string]int64 // name -> updated_at; values are write-only and not kept
	schedules []*schedule
	queue     []*message
	dlq       []*message
	dedup     map[string]string // dedup_id -> message id
	events    []runtime.Event
	logs      []logLine
	logSeq    int64
	notify    chan struct{} // closed and replaced on every log append and on removal

	failArmed bool // FailBuild: the next build to settle fails
	failDiag  json.RawMessage
}

type schedule struct {
	id      string
	kind    string
	cron    *string
	every   *int64
	tz      *string
	payload json.RawMessage
	enabled bool
	nextDue *int64
}

func (sc *schedule) view() runtime.Schedule {
	return runtime.Schedule{
		ID: sc.id, Kind: sc.kind, Cron: sc.cron, EverySeconds: sc.every, Timezone: sc.tz,
		Payload: sc.payload, Enabled: sc.enabled, NextDue: sc.nextDue,
	}
}

type message struct {
	id         string
	body       json.RawMessage
	enqueuedAt int64
	attempts   int
	failedAt   int64
}

func (s *service) etagValue() string { return `"` + strconv.Itoa(s.etag) + `"` }

func (s *service) view() runtime.Service {
	st := runtime.ServiceStatus{Tier: "T1"}
	if s.liveVersion != nil && *s.liveVersion >= 1 && *s.liveVersion <= len(s.versions) {
		st.BuildState = s.versions[*s.liveVersion-1].state
	}
	return runtime.Service{
		ID: s.id, TenantID: s.tenantID, Slug: s.slug, Runtime: s.runtime,
		Name: s.name, Profile: s.profile, Project: s.project, Environment: s.environment,
		LiveVersion: s.liveVersion, ETag: s.etagValue(), Access: s.access,
		Limits: s.limits, Scaling: s.scaling, Triggers: s.triggers,
		Ingress: s.ingress, Egress: s.egress, Call: s.call, Deno: s.deno, Wasm: s.wasm,
		Status: st,
	}
}

// addEvent appends an audit event; data nil records JSON null.
func (s *service) addEvent(kind string, data map[string]any) {
	raw, _ := json.Marshal(data)
	s.events = append(s.events, runtime.Event{ID: newID("evt_"), TS: nowMS(), Kind: kind, Data: raw})
}

func (s *service) schedule(id string) (int, *schedule) {
	for i, sc := range s.schedules {
		if sc.id == id {
			return i, sc
		}
	}
	return -1, nil
}

func (f *Fake) serviceRoutes(mux *http.ServeMux) {
	f.route(mux, "POST /v1/services", "services:write", f.createService)
	f.route(mux, "GET /v1/services", "services:read", f.listServices)
	f.route(mux, "GET /v1/services/{s}", "services:read", f.getService)
	f.route(mux, "PATCH /v1/services/{s}", "services:write", f.patchService)
	f.route(mux, "DELETE /v1/services/{s}", "services:write", f.deleteService)
	f.route(mux, "GET /v1/services/{s}/events", "services:read", f.listEvents)

	f.route(mux, "GET /v1/services/{s}/env", "services:read", f.getEnv)
	f.route(mux, "PUT /v1/services/{s}/env", "env:write", f.putEnv)
	f.route(mux, "GET /v1/services/{s}/secrets", "services:read", f.listSecrets)
	f.route(mux, "PUT /v1/services/{s}/secrets/{name}", "secrets:write", f.putSecret)
	f.route(mux, "DELETE /v1/services/{s}/secrets/{name}", "secrets:write", f.deleteSecret)

	f.route(mux, "GET /v1/services/{s}/schedules", "services:read", f.listSchedules)
	f.route(mux, "POST /v1/services/{s}/schedules", "services:write", f.createSchedule)
	f.route(mux, "PATCH /v1/services/{s}/schedules/{id}", "services:write", f.updateSchedule)
	f.route(mux, "DELETE /v1/services/{s}/schedules/{id}", "services:write", f.deleteSchedule)

	f.route(mux, "GET /v1/services/{s}/queue", "services:read", f.queueStats)
	f.route(mux, "POST /v1/services/{s}/queue", "queue:write", f.enqueue)
	f.route(mux, "GET /v1/services/{s}/dlq", "services:read", f.listDLQ)
	f.route(mux, "DELETE /v1/services/{s}/dlq", "queue:write", f.purgeDLQ)
	f.route(mux, "POST /v1/services/{s}/dlq/redrive", "queue:write", f.redriveDLQ)
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
	slices.SortFunc(out, func(a, b *service) int { return strings.Compare(a.slug, b.slug) })
	return out
}

// dropService removes s with its hosts and wakes its log streams so they end.
func (f *Fake) dropService(s *service) {
	delete(f.services, s.id)
	for host, h := range f.hosts {
		if h.svcID == s.id {
			delete(f.hosts, host)
		}
	}
	close(s.notify)
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
		env:     map[string]string{},
		secrets: map[string]int64{},
		dedup:   map[string]string{},
		notify:  make(chan struct{}),
	}
	f.services[s.id] = s
	s.addEvent("service.created", map[string]any{"slug": s.slug})
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
	if e := s.checkIfMatch(r); e != nil {
		return e
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
	s.addEvent("service.updated", nil)
	writeService(w, http.StatusOK, s)
	return nil
}

// checkIfMatch enforces an If-Match header when one is sent; absent means unconditional.
func (s *service) checkIfMatch(r *http.Request) *apiError {
	if ifMatch := r.Header.Get("If-Match"); ifMatch != "" && ifMatch != s.etagValue() {
		return &apiError{status: http.StatusPreconditionFailed, code: "precondition_failed", msg: "If-Match does not match the current etag"}
	}
	return nil
}

func (f *Fake) deleteService(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	f.dropService(s)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (f *Fake) listEvents(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	writeJSON(w, http.StatusOK, runtime.Page[runtime.Event]{Items: append([]runtime.Event{}, s.events...)})
	return nil
}

func (f *Fake) getEnv(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	writeJSON(w, http.StatusOK, s.env)
	return nil
}

// putEnv replaces the whole env map.
func (f *Fake) putEnv(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	var in map[string]string
	if e := decode(r, &in); e != nil {
		return e
	}
	if len(in) > maxEnvEntries {
		return invalid("at most %d env entries", maxEnvEntries)
	}
	for k, v := range in {
		if len(v) > maxValueBytes {
			return invalid("env %s exceeds %d bytes", k, maxValueBytes)
		}
	}
	if in == nil {
		in = map[string]string{}
	}
	s.env = in
	writeJSON(w, http.StatusOK, s.env)
	return nil
}

func (f *Fake) listSecrets(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	items := []runtime.SecretName{}
	for name, at := range s.secrets {
		items = append(items, runtime.SecretName{Name: name, UpdatedAt: at})
	}
	slices.SortFunc(items, func(a, b runtime.SecretName) int { return strings.Compare(a.Name, b.Name) })
	writeJSON(w, http.StatusOK, items)
	return nil
}

func (f *Fake) putSecret(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	name := r.PathValue("name")
	if !secretRE.MatchString(name) || strings.HasPrefix(name, "RT_") {
		return invalid("secret name %q is not valid", name)
	}
	var in runtime.PutSecretBody
	if e := decode(r, &in); e != nil {
		return e
	}
	if len(in.Value) > maxValueBytes {
		return invalid("secret value exceeds %d bytes", maxValueBytes)
	}
	s.secrets[name] = nowMS()
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (f *Fake) deleteSecret(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	name := r.PathValue("name")
	if _, ok := s.secrets[name]; !ok {
		return notFound()
	}
	delete(s.secrets, name)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (f *Fake) listSchedules(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	items := []runtime.Schedule{}
	for _, sc := range s.schedules {
		items = append(items, sc.view())
	}
	writeJSON(w, http.StatusOK, items)
	return nil
}

func (f *Fake) createSchedule(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	var in runtime.ScheduleBody
	if e := decode(r, &in); e != nil {
		return e
	}
	plan := f.plans[f.tenants[s.tenantID].plan]
	sc, e := buildSchedule(s, plan, newID("sch_"), in)
	if e != nil {
		return e
	}
	if plan.MaxSchedules > 0 && len(s.schedules) >= plan.MaxSchedules {
		return forbidden("quota_exceeded", "plan schedule limit reached", map[string]any{"quota": "schedules"})
	}
	s.schedules = append(s.schedules, sc)
	writeJSON(w, http.StatusCreated, sc.view())
	return nil
}

func (f *Fake) updateSchedule(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	i, old := s.schedule(r.PathValue("id"))
	if old == nil {
		return notFound()
	}
	var in runtime.ScheduleBody
	if e := decode(r, &in); e != nil {
		return e
	}
	sc, e := buildSchedule(s, f.plans[f.tenants[s.tenantID].plan], old.id, in)
	if e != nil {
		return e
	}
	s.schedules[i] = sc
	writeJSON(w, http.StatusOK, sc.view())
	return nil
}

func (f *Fake) deleteSchedule(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	i, _ := s.schedule(r.PathValue("id"))
	if i < 0 {
		return notFound()
	}
	s.schedules = slices.Delete(s.schedules, i, i+1)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// buildSchedule validates a schedule body against the service and plan. The
// fake does not evaluate cron expressions, so cron next_due is a placeholder.
func buildSchedule(s *service, plan FakePlan, id string, in runtime.ScheduleBody) (*schedule, *apiError) {
	sc := &schedule{
		id: id, kind: in.Kind, cron: in.Cron, every: in.EverySeconds, tz: in.Timezone,
		payload: in.Payload, enabled: in.Enabled == nil || *in.Enabled,
	}
	switch in.Kind {
	case "interval":
		if in.EverySeconds == nil {
			return nil, invalid("every_seconds is required for an interval schedule")
		}
		if *in.EverySeconds < minIntervalS {
			return nil, &apiError{status: http.StatusUnprocessableEntity, code: "schedule_too_frequent", msg: "interval is below the plan minimum"}
		}
		next := nowMS() + *in.EverySeconds*1000
		sc.nextDue = &next
	case "cron":
		if in.Cron == nil || *in.Cron == "" {
			return nil, invalid("cron is required for a cron schedule")
		}
		next := nowMS() + 60_000
		sc.nextDue = &next
	default:
		return nil, invalid("kind must be interval or cron")
	}
	if !slices.Contains(plan.Triggers, in.Kind) || !triggerEnabled(s, in.Kind) {
		return nil, forbidden("trigger_not_allowed", "trigger "+in.Kind+" is not allowed", map[string]any{"trigger": in.Kind})
	}
	return sc, nil
}

func (f *Fake) queueStats(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	st := runtime.QueueStats{Depth: int64(len(s.queue)), DLQ: int64(len(s.dlq))}
	if len(s.queue) > 0 {
		st.OldestAgeMs = nowMS() - s.queue[0].enqueuedAt
	}
	writeJSON(w, http.StatusOK, st)
	return nil
}

func (f *Fake) enqueue(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	var in runtime.EnqueueBody
	if e := decode(r, &in); e != nil {
		return e
	}
	plan := f.plans[f.tenants[s.tenantID].plan]
	if !slices.Contains(plan.Triggers, "queue") || !triggerEnabled(s, "queue") {
		return forbidden("trigger_not_allowed", "trigger queue is not allowed", map[string]any{"trigger": "queue"})
	}
	if len(in.Body) == 0 {
		return invalid("body is required")
	}
	if in.DelaySeconds != nil && (*in.DelaySeconds < 0 || *in.DelaySeconds > maxDelayS) {
		return invalid("delay_seconds must be between 0 and 7 days")
	}
	if in.DedupID != nil {
		if id, ok := s.dedup[*in.DedupID]; ok {
			writeJSON(w, http.StatusAccepted, runtime.Enqueued{ID: id})
			return nil
		}
	}
	m := &message{id: newID("msg_"), body: in.Body, enqueuedAt: nowMS()}
	s.queue = append(s.queue, m)
	if in.DedupID != nil {
		s.dedup[*in.DedupID] = m.id
	}
	writeJSON(w, http.StatusAccepted, runtime.Enqueued{ID: m.id})
	return nil
}

func (f *Fake) listDLQ(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	items := []runtime.DLQItem{}
	for _, m := range s.dlq {
		items = append(items, runtime.DLQItem{ID: m.id, Body: m.body, Attempts: m.attempts, FailedAt: m.failedAt})
	}
	writeJSON(w, http.StatusOK, runtime.DLQ{Items: items})
	return nil
}

func (f *Fake) purgeDLQ(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	s.dlq = nil
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (f *Fake) redriveDLQ(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	n := len(s.dlq)
	s.queue = append(s.queue, s.dlq...)
	s.dlq = nil
	writeJSON(w, http.StatusOK, runtime.Redriven{Redriven: int64(n)})
	return nil
}

// DeadLetter parks body in svc's dead-letter queue, as a consumer failing it would.
// An unknown service is ignored.
func (f *Fake) DeadLetter(svc string, body json.RawMessage) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if s := f.services[svc]; s != nil {
		s.dlq = append(s.dlq, &message{id: newID("msg_"), body: body, attempts: 3, failedAt: nowMS()})
	}
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

// triggerEnabled reports whether the service's triggers block leaves kind on.
func triggerEnabled(s *service, kind string) bool {
	var on map[string]bool
	if len(s.triggers) == 0 || json.Unmarshal(s.triggers, &on) != nil {
		return true
	}
	v, ok := on[kind]
	return !ok || v
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
