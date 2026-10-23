package apps

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/audit"
	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/orgs"
	"github.com/21cloud/runtime-web/internal/runtime"
	"github.com/21cloud/runtime-web/internal/runtime/runtimetest"
	"github.com/21cloud/runtime-web/internal/seal"
	"github.com/21cloud/runtime-web/internal/store"
	"github.com/21cloud/runtime-web/internal/store/db"
)

const testPlan = "standard"

var owner = authz.Subject{UserID: "usr_owner", OrgRole: authz.RoleOwner}

type fixture struct {
	fake *runtimetest.Fake
	rt   *runtime.Client
	root runtime.RootCred
	orgs *orgs.Service
	svc  *Service
	org  orgs.Org
	uid  string
	// rec records requests sent to the fake.
	rec *recorder
}

type recorder struct {
	mu   sync.Mutex
	reqs []recorded
}

type recorded struct {
	method, path, query, ifMatch, ctype string
	body                                []byte
}

func (r *recorder) RoundTrip(req *http.Request) (*http.Response, error) {
	var body []byte
	if req.Body != nil {
		body, _ = io.ReadAll(req.Body)
		req.Body = io.NopCloser(strings.NewReader(string(body)))
	}
	r.mu.Lock()
	r.reqs = append(r.reqs, recorded{req.Method, req.URL.Path, req.URL.RawQuery, req.Header.Get("If-Match"), req.Header.Get("Content-Type"), body})
	r.mu.Unlock()
	return http.DefaultTransport.RoundTrip(req)
}

func (r *recorder) last(method, pathSuffix string) (recorded, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := len(r.reqs) - 1; i >= 0; i-- {
		if r.reqs[i].method == method && strings.HasSuffix(r.reqs[i].path, pathSuffix) {
			return r.reqs[i], true
		}
	}
	return recorded{}, false
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	ctx := context.Background()
	fake := runtimetest.NewServer(t)
	fake.SetPlan(testPlan, runtimetest.FakePlan{MaxServices: 20, MaxSchedules: 3, Triggers: []string{"http", "cron", "interval", "queue", "call"}})
	st, err := store.Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	uid := store.NewID("usr_")
	if err := st.Q().CreateUser(ctx, db.CreateUserParams{ID: uid, Email: "o@example.com", Name: "O", CreatedAt: 1, UpdatedAt: 1}); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	rec := &recorder{}
	rt := runtime.New(fake.URL, &http.Client{Transport: rec})
	root := runtime.RootCred{Token: fake.RootToken}
	var key [32]byte
	for i := range key {
		key[i] = byte(i + 3)
	}
	o := orgs.New(st, rt, root, seal.New(key), testPlan)
	f := &fixture{fake: fake, rt: rt, root: root, orgs: o, svc: New(rt, o), rec: rec, uid: uid}
	f.org = f.newOrg(t, "acme", uid)
	return f
}

func (f *fixture) newOrg(t *testing.T, slug, uid string) orgs.Org {
	t.Helper()
	org, err := f.orgs.Create(context.Background(), audit.Actor{UserID: uid}, slug, slug, uid)
	if err != nil {
		t.Fatalf("orgs.Create: %v", err)
	}
	return org
}

func (f *fixture) project(t *testing.T, orgID, slug string, envs ...string) {
	t.Helper()
	if _, err := f.svc.CreateProject(context.Background(), owner, orgID, slug, "", envs); err != nil {
		t.Fatalf("CreateProject(%s): %v", slug, err)
	}
}

func (f *fixture) app(t *testing.T, orgID, project, env, slug string) AppView {
	t.Helper()
	v, err := f.svc.Create(context.Background(), owner, orgID, project, env, slug, "http")
	if err != nil {
		t.Fatalf("Create(%s): %v", slug, err)
	}
	return v
}

func wantErr(t *testing.T, err, target error) {
	t.Helper()
	if !errors.Is(err, target) {
		t.Fatalf("err = %v, want %v", err, target)
	}
}

func wantConflict(t *testing.T, err error, code string) {
	t.Helper()
	if got, ok := apperr.ConflictCode(err); !ok || got != code {
		t.Fatalf("err = %v, want conflict %s", err, code)
	}
}

func TestResolveBySlug(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.project(t, f.org.ID, "web", "production", "staging")
	v := f.app(t, f.org.ID, "web", "staging", "hello")
	app, err := f.svc.Resolve(ctx, f.org.ID, "hello")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	want := App{SvcID: v.Raw.ID, Slug: "hello", ProjectSlug: "web", Environment: "staging"}
	if app != want {
		t.Fatalf("Resolve = %+v, want %+v", app, want)
	}
	if !strings.HasPrefix(app.SvcID, "svc_") {
		t.Fatalf("SvcID = %q", app.SvcID)
	}
	if _, err := f.svc.Resolve(ctx, f.org.ID, "missing"); !errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("Resolve(missing) = %v", err)
	}
}

func TestResolveCachesAndEvictsOnDelete(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.app(t, f.org.ID, "default", "production", "cached")
	if _, err := f.svc.Resolve(ctx, f.org.ID, "cached"); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	n := len(f.rec.reqs)
	if _, err := f.svc.Resolve(ctx, f.org.ID, "cached"); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(f.rec.reqs) != n {
		t.Fatalf("second Resolve hit the runtime")
	}
	if err := f.svc.Delete(ctx, owner, f.org.ID, "cached"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	wantErr(t, mustResolveErr(f, "cached"), apperr.ErrNotFound)
}

func mustResolveErr(f *fixture, slug string) error {
	_, err := f.svc.Resolve(context.Background(), f.org.ID, slug)
	return err
}

func TestResolveRejectsOtherTenant(t *testing.T) {
	f := newFixture(t)
	other := f.newOrg(t, "other", f.uid)
	f.app(t, other.ID, "default", "production", "theirs")
	wantErr(t, mustResolveErr(f, "theirs"), apperr.ErrNotFound)
}

func TestAppOfOtherOrgIs404(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	other := f.newOrg(t, "other", f.uid)
	f.app(t, other.ID, "default", "production", "theirs")
	_, err := f.svc.Get(ctx, owner, f.org.ID, "theirs")
	wantErr(t, err, apperr.ErrNotFound)
	_, err = f.svc.Update(ctx, owner, f.org.ID, "theirs", AppPatch{}, `"1"`)
	wantErr(t, err, apperr.ErrNotFound)
	wantErr(t, f.svc.Delete(ctx, owner, f.org.ID, "theirs"), apperr.ErrNotFound)
	// A non-member of the org sees nothing either.
	stranger := authz.Subject{UserID: "usr_s"}
	f.app(t, f.org.ID, "default", "production", "mine")
	_, err = f.svc.Get(ctx, stranger, f.org.ID, "mine")
	wantErr(t, err, apperr.ErrNotFound)
}

func TestMemberSeesOnlyGrantedProjects(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.project(t, f.org.ID, "web")
	f.project(t, f.org.ID, "ops")
	f.app(t, f.org.ID, "web", "production", "site")
	f.app(t, f.org.ID, "ops", "production", "cron-job")
	member := authz.Subject{UserID: "usr_m", OrgRole: authz.RoleMember, ProjectRoles: map[string]string{"web": authz.RoleViewer}}

	ps, err := f.svc.ListProjects(ctx, member, f.org.ID)
	if err != nil {
		t.Fatalf("ListProjects: %v", err)
	}
	if len(ps) != 1 || ps[0].Slug != "web" || ps[0].Role != authz.RoleViewer {
		t.Fatalf("ListProjects = %+v, want only web (viewer)", ps)
	}
	all, err := f.svc.ListProjects(ctx, owner, f.org.ID)
	if err != nil || len(all) != 3 {
		t.Fatalf("owner ListProjects = %+v, %v; want default, ops, web", all, err)
	}
	for _, p := range all {
		if p.Role != authz.RoleAdmin {
			t.Fatalf("owner role on %s = %s", p.Slug, p.Role)
		}
	}

	apps, err := f.svc.List(ctx, member, f.org.ID, "", "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(apps) != 1 || apps[0].Slug != "site" {
		t.Fatalf("List = %+v, want only site", apps)
	}
	_, err = f.svc.List(ctx, member, f.org.ID, "ops", "")
	wantErr(t, err, apperr.ErrNotFound)
	_, err = f.svc.Get(ctx, member, f.org.ID, "cron-job")
	wantErr(t, err, apperr.ErrNotFound)
	_, err = f.svc.ListEnvironments(ctx, member, f.org.ID, "ops")
	wantErr(t, err, apperr.ErrNotFound)
	if _, err := f.svc.Get(ctx, member, f.org.ID, "site"); err != nil {
		t.Fatalf("Get(site): %v", err)
	}
	// Visible but role too low.
	wantErr(t, f.svc.Delete(ctx, member, f.org.ID, "site"), apperr.ErrForbidden)
	_, err = f.svc.Create(ctx, member, f.org.ID, "web", "production", "nope", "http")
	wantErr(t, err, apperr.ErrForbidden)
	_, err = f.svc.CreateProject(ctx, member, f.org.ID, "mine", "", nil)
	wantErr(t, err, apperr.ErrForbidden)
}

func TestCreateSlugTakenGlobal(t *testing.T) {
	f := newFixture(t)
	other := f.newOrg(t, "other", f.uid)
	f.app(t, other.ID, "default", "production", "shared")
	_, err := f.svc.Create(context.Background(), owner, f.org.ID, "default", "production", "shared", "http")
	wantConflict(t, err, "slug_taken")
	var c apperr.Conflict
	if !errors.As(err, &c) || c.Message != "This app name is taken on this runtime" {
		t.Fatalf("conflict = %+v", c)
	}
}

func TestCreateAppUploadsTemplateV1(t *testing.T) {
	for _, tmpl := range []string{"http", "cron", "queue", "sqlite-crud"} {
		t.Run(tmpl, func(t *testing.T) {
			f := newFixture(t)
			ctx := context.Background()
			v, err := f.svc.Create(ctx, owner, f.org.ID, "default", "production", "a-"+tmpl, tmpl)
			if err != nil {
				t.Fatalf("Create: %v", err)
			}
			up, ok := f.rec.last(http.MethodPost, "/versions")
			if !ok {
				t.Fatal("no version upload")
			}
			if !strings.Contains(up.query, "compile=eager") || !strings.Contains(up.query, "activate=1") {
				t.Fatalf("upload query = %q", up.query)
			}
			if string(up.body) != templates[tmpl] || len(up.body) == 0 {
				t.Fatalf("upload body is not the %s template", tmpl)
			}
			if strings.Contains(string(up.body), "rt:") {
				t.Fatalf("template uses rt:* modules")
			}
			if v.Raw.LiveVersion == nil || *v.Raw.LiveVersion != 1 {
				t.Fatalf("live_version = %v, want 1", v.Raw.LiveVersion)
			}
			if v.ETag == "" || v.ETag != v.Raw.ETag {
				t.Fatalf("etag = %q / %q", v.ETag, v.Raw.ETag)
			}
		})
	}
	f := newFixture(t)
	_, err := f.svc.Create(context.Background(), owner, f.org.ID, "default", "production", "x", "nope")
	wantErr(t, err, apperr.ErrInvalid)
}

func TestCreateRejectsUnknownEnvironment(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.project(t, f.org.ID, "web", "production", "staging")
	_, err := f.svc.Create(ctx, owner, f.org.ID, "web", "qa", "hello", "http")
	wantErr(t, err, apperr.ErrInvalid)
	if _, ok := f.rec.last(http.MethodPost, "/v1/services"); ok {
		t.Fatal("service was created for an unknown environment")
	}
	_, err = f.svc.Create(ctx, owner, f.org.ID, "nope", "production", "hello", "http")
	wantErr(t, err, apperr.ErrNotFound)
}

func TestUpdateSendsIfMatch(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.app(t, f.org.ID, "default", "production", "hello")
	access := "key"
	got, err := f.svc.Update(ctx, owner, f.org.ID, "hello", AppPatch{Access: &access}, v.ETag)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	r, _ := f.rec.last(http.MethodPatch, "/v1/services/"+v.Raw.ID)
	if r.ifMatch != v.ETag {
		t.Fatalf("If-Match = %q, want %q", r.ifMatch, v.ETag)
	}
	if got.Raw.Access != "key" || got.ETag == v.ETag || got.ETag == "" {
		t.Fatalf("Update = access %s etag %s", got.Raw.Access, got.ETag)
	}
}

func TestPatchAppStaleEtag409(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.app(t, f.org.ID, "default", "production", "hello")
	access := "key"
	if _, err := f.svc.Update(ctx, owner, f.org.ID, "hello", AppPatch{Access: &access}, v.ETag); err != nil {
		t.Fatalf("Update: %v", err)
	}
	_, err := f.svc.Update(ctx, owner, f.org.ID, "hello", AppPatch{Access: &access}, v.ETag)
	wantConflict(t, err, "stale")
}

func TestPatchWithoutIfMatch428(t *testing.T) {
	f := newFixture(t)
	f.app(t, f.org.ID, "default", "production", "hello")
	_, err := f.svc.Update(context.Background(), owner, f.org.ID, "hello", AppPatch{}, "")
	wantErr(t, err, apperr.ErrPreconditionRequired)
	if _, ok := f.rec.last(http.MethodPatch, ""); ok {
		t.Fatal("PATCH sent without If-Match")
	}
}

func TestUpdateIngressValidatesCIDR(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.app(t, f.org.ID, "default", "production", "hello")
	tests := []struct {
		name  string
		allow []string
		ok    bool
	}{
		{"v4 and v6", []string{"10.0.0.0/8", "2001:db8::/32"}, true},
		{"bare ip", []string{"10.0.0.1"}, false},
		{"garbage", []string{"10.0.0.0/8", "nope"}, false},
	}
	etag := v.ETag
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := f.svc.Update(ctx, owner, f.org.ID, "hello", AppPatch{Ingress: &Ingress{IPAllow: tt.allow}}, etag)
			if tt.ok {
				if err != nil {
					t.Fatalf("Update: %v", err)
				}
				etag = got.ETag
				return
			}
			wantErr(t, err, apperr.ErrInvalid)
			if !strings.Contains(err.Error(), "ingress.ip_allow[") {
				t.Fatalf("err %v does not name the field", err)
			}
		})
	}
}

func TestUpdateBlockReplacesNotMerges(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.app(t, f.org.ID, "default", "production", "hello")
	v1, err := f.svc.Update(ctx, owner, f.org.ID, "hello", AppPatch{Ingress: &Ingress{
		Methods: []string{"GET", "POST"}, PathPrefixes: []string{"/api"}, RateLimit: json.RawMessage(`{"rps":5,"burst":10}`),
	}}, v.ETag)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	v2, err := f.svc.Update(ctx, owner, f.org.ID, "hello", AppPatch{Ingress: &Ingress{Methods: []string{"GET"}}}, v1.ETag)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	var ing map[string]any
	if err := json.Unmarshal(v2.Raw.Ingress, &ing); err != nil {
		t.Fatalf("ingress %s: %v", v2.Raw.Ingress, err)
	}
	if len(ing) != 1 || ing["allowed_methods"] == nil {
		t.Fatalf("ingress = %s, want only allowed_methods", v2.Raw.Ingress)
	}
	r, _ := f.rec.last(http.MethodPatch, "/v1/services/"+v.Raw.ID)
	var body map[string]json.RawMessage
	_ = json.Unmarshal(r.body, &body)
	if _, ok := body["scaling"]; ok {
		t.Fatalf("absent block was sent: %s", r.body)
	}
	// Call maps to allowed_callers.
	v3, err := f.svc.Update(ctx, owner, f.org.ID, "hello", AppPatch{Call: &Call{AllowedCallers: []string{"other"}}}, v2.ETag)
	if err != nil {
		t.Fatalf("Update call: %v", err)
	}
	if string(v3.Raw.Call) != `{"allowed_callers":["other"]}` {
		t.Fatalf("call = %s", v3.Raw.Call)
	}
}

func TestGetShowsEffectiveLimitsAndStatus(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.app(t, f.org.ID, "default", "production", "hello")
	got, err := f.svc.Get(ctx, owner, f.org.ID, "hello")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.ETag != v.ETag || got.Status.Tier != "T1" || got.Status.BuildState != "ready" {
		t.Fatalf("Get = etag %s status %+v", got.ETag, got.Status)
	}
	if got.Limits.Source != "profile" || len(got.Limits.Effective) == 0 || got.Limits.Requested != nil {
		t.Fatalf("limits = %+v", got.Limits)
	}
	tests := []struct {
		name, limits, source string
	}{
		{"service", `{"cpu_ms":2000}`, "service"},
		{"plan", `{"memory_mb":4096}`, "plan"},
	}
	etag := got.ETag
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			u, err := f.svc.Update(ctx, owner, f.org.ID, "hello", AppPatch{Limits: json.RawMessage(tt.limits)}, etag)
			if err != nil {
				t.Fatalf("Update: %v", err)
			}
			etag = u.ETag
			g, err := f.svc.Get(ctx, owner, f.org.ID, "hello")
			if err != nil {
				t.Fatalf("Get: %v", err)
			}
			if g.Limits.Source != tt.source || string(g.Limits.Requested) != tt.limits {
				t.Fatalf("limits = source %s requested %s", g.Limits.Source, g.Limits.Requested)
			}
		})
	}
}

func TestProjectsCRUD(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	p, err := f.svc.CreateProject(ctx, owner, f.org.ID, "web", "Web", []string{"production", "staging"})
	if err != nil || p.Slug != "web" || p.Name != "Web" {
		t.Fatalf("CreateProject = %+v, %v", p, err)
	}
	_, err = f.svc.CreateProject(ctx, owner, f.org.ID, "web", "", nil)
	wantConflict(t, err, "slug_taken")
	name := "Website"
	p, err = f.svc.UpdateProject(ctx, owner, f.org.ID, "web", &name, []string{"production"})
	if err != nil || p.Name != "Website" || len(p.Environments) != 1 {
		t.Fatalf("UpdateProject = %+v, %v", p, err)
	}
	envs, err := f.svc.ListEnvironments(ctx, owner, f.org.ID, "web")
	if err != nil || len(envs) != 1 || envs[0] != "production" {
		t.Fatalf("ListEnvironments = %v, %v", envs, err)
	}
	f.app(t, f.org.ID, "web", "production", "site")
	wantConflict(t, f.svc.DeleteProject(ctx, owner, f.org.ID, "web"), "project_not_empty")
	if err := f.svc.Delete(ctx, owner, f.org.ID, "site"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if err := f.svc.DeleteProject(ctx, owner, f.org.ID, "web"); err != nil {
		t.Fatalf("DeleteProject: %v", err)
	}
	_, err = f.svc.ListEnvironments(ctx, owner, f.org.ID, "web")
	wantErr(t, err, apperr.ErrNotFound)
}
