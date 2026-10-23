package admin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
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

type fixture struct {
	t     *testing.T
	ctx   context.Context
	fake  *runtimetest.Fake
	st    *store.Store
	orgs  *orgs.Service
	svc   *Service
	admin authz.Subject
	owner string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	ctx := context.Background()
	fake := runtimetest.NewServer(t)
	fake.SetPlan("standard", runtimetest.FakePlan{MaxServices: 10, MaxSchedules: 3, Triggers: []string{"http"}})
	st, err := store.Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	owner := store.NewID("usr_")
	if err := st.Q().CreateUser(ctx, db.CreateUserParams{ID: owner, Email: "o@example.com", Name: "O", CreatedAt: 1, UpdatedAt: 1}); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	rt := runtime.New(fake.URL, http.DefaultClient)
	root := runtime.RootCred{Token: fake.RootToken}
	var key [32]byte
	for i := range key {
		key[i] = byte(i + 1)
	}
	oc := orgs.New(st, rt, root, seal.New(key), "standard")
	return &fixture{
		t: t, ctx: ctx, fake: fake, st: st, orgs: oc,
		svc:   New(st, rt, root, oc),
		admin: authz.Subject{UserID: store.NewID("usr_"), InstanceAdmin: true},
		owner: owner,
	}
}

func (f *fixture) createOrg(slug string) orgs.Org {
	f.t.Helper()
	org, err := f.orgs.Create(f.ctx, audit.Actor{UserID: "cli"}, slug, "Org "+slug, f.owner)
	if err != nil {
		f.t.Fatalf("Create(%s): %v", slug, err)
	}
	return org
}

func (f *fixture) ownerSub(orgID string) authz.Subject {
	f.t.Helper()
	sub, err := f.orgs.Subject(f.ctx, f.owner, orgID)
	if err != nil {
		f.t.Fatalf("Subject: %v", err)
	}
	return sub
}

func TestNonAdminForbidden(t *testing.T) {
	f := newFixture(t)
	org := f.createOrg("acme")
	plain := f.ownerSub(org.ID) // org owner, not an instance admin
	plain.OrgRole = authz.RoleOwner
	mode := "degraded"
	tests := []struct {
		name string
		call func() error
	}{
		{"NodeStatus", func() error { _, err := f.svc.NodeStatus(f.ctx, plain); return err }},
		{"NodeConfig", func() error { _, err := f.svc.NodeConfig(f.ctx, plain); return err }},
		{"SetNodeConfig", func() error {
			_, err := f.svc.SetNodeConfig(f.ctx, plain, NodeConfigPatch{DegradationMode: &mode})
			return err
		}},
		{"Scheduler", func() error { _, err := f.svc.Scheduler(f.ctx, plain); return err }},
		{"Cache", func() error { _, err := f.svc.Cache(f.ctx, plain); return err }},
		{"Drain", func() error { return f.svc.Drain(f.ctx, plain) }},
		{"Version", func() error { _, err := f.svc.Version(f.ctx, plain); return err }},
		{"Domains", func() error { _, err := f.svc.Domains(f.ctx, plain); return err }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.call(); !errors.Is(err, apperr.ErrForbidden) {
				t.Fatalf("err = %v, want ErrForbidden", err)
			}
		})
	}
}

func TestSetNodeConfigAudited(t *testing.T) {
	f := newFixture(t)
	profile := "fast"
	limit := RateLimit(`{"per_minute":100}`)
	got, err := f.svc.SetNodeConfig(f.ctx, f.admin, NodeConfigPatch{DefaultProfile: &profile, RateLimit: &limit})
	if err != nil {
		t.Fatalf("SetNodeConfig: %v", err)
	}
	if !contains(got.Applied, "default_profile") {
		t.Fatalf("applied = %v, want default_profile", got.Applied)
	}
	if !contains(got.PendingRestart, "rate_limit") {
		t.Fatalf("pending_restart = %v, want rate_limit", got.PendingRestart)
	}
	entries := f.auditRows(t, "node.config.update")
	if len(entries) != 2 {
		t.Fatalf("audit entries = %d, want intent and outcome", len(entries))
	}
	for _, e := range entries {
		if e.ActorUserID != f.admin.UserID || !e.AsInstanceAdmin || e.OrgID != nil {
			t.Fatalf("audit entry = %+v, want instance-wide entry by admin", e)
		}
		if !strings.Contains(e.Detail, `"default_profile":"fast"`) {
			t.Fatalf("audit detail = %s, want default_profile", e.Detail)
		}
	}
	if got := statuses(entries); got != "applied,pending" {
		t.Fatalf("statuses = %s, want applied,pending", got)
	}
}

func TestSetNodeConfigRuntimeFailureAudited(t *testing.T) {
	f := newFixture(t)
	f.fake.FailNext(http.StatusUnprocessableEntity, "invalid", 0)
	profile := "fast"
	if _, err := f.svc.SetNodeConfig(f.ctx, f.admin, NodeConfigPatch{DefaultProfile: &profile}); err == nil {
		t.Fatal("SetNodeConfig: want runtime error")
	}
	entries := f.auditRows(t, "node.config.update")
	if got := statuses(entries); got != "failed,pending" {
		t.Fatalf("statuses = %s, want failed,pending", got)
	}
	if !strings.Contains(entries[0].Detail, `"error_code":"invalid"`) {
		t.Fatalf("failed detail = %s, want error_code invalid", entries[0].Detail)
	}
}

func TestDrainRuntimeFailureAudited(t *testing.T) {
	f := newFixture(t)
	f.fake.FailNext(http.StatusConflict, "busy", 0)
	if err := f.svc.Drain(f.ctx, f.admin); err == nil {
		t.Fatal("Drain: want runtime error")
	}
	if got := statuses(f.auditRows(t, "node.drain")); got != "failed,pending" {
		t.Fatalf("statuses = %s, want failed,pending", got)
	}
}

func (f *fixture) auditRows(t *testing.T, action string) []audit.Entry {
	t.Helper()
	entries, _, err := audit.List(f.ctx, f.st.Q(), audit.Filter{Action: action})
	if err != nil {
		t.Fatalf("audit.List: %v", err)
	}
	return entries
}

// statuses lists the status of each row, newest first, from the audit detail JSON.
func statuses(entries []audit.Entry) string {
	var out []string
	for _, e := range entries {
		var d struct {
			Status string `json:"status"`
		}
		_ = json.Unmarshal([]byte(e.Detail), &d)
		out = append(out, d.Status)
	}
	return strings.Join(out, ",")
}

func TestSetNodeConfigRejectsOtherFields(t *testing.T) {
	tests := []struct {
		name    string
		body    string
		wantErr bool
	}{
		{"allowed profile", `{"default_profile":"fast"}`, false},
		{"allowed rate limit", `{"rate_limit":{"per_minute":5}}`, false},
		{"unknown field", `{"default_profile":"fast","mode":"drain"}`, true},
		{"deliberately disallowed field", `{"v8_sandbox":false}`, true},
		{"empty patch", `{}`, true},
		{"null rate limit is absent", `{"rate_limit":null}`, true},
		{"trailing data", `{"default_profile":"fast"} {}`, true},
		{"trailing garbage", `{"default_profile":"fast"}x`, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := DecodeNodeConfigPatch(strings.NewReader(tt.body))
			if tt.wantErr {
				if !errors.Is(err, apperr.ErrInvalid) {
					t.Fatalf("err = %v, want ErrInvalid", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("Decode: %v", err)
			}
		})
	}
	f := newFixture(t)
	if _, err := f.svc.SetNodeConfig(f.ctx, f.admin, NodeConfigPatch{}); !errors.Is(err, apperr.ErrInvalid) {
		t.Fatalf("empty SetNodeConfig err = %v, want ErrInvalid", err)
	}
}

func TestDrainAudited(t *testing.T) {
	f := newFixture(t)
	if err := f.svc.Drain(f.ctx, f.admin); err != nil {
		t.Fatalf("Drain: %v", err)
	}
	if got := statuses(f.auditRows(t, "node.drain")); got != "applied,pending" {
		t.Fatalf("statuses = %s, want applied,pending", got)
	}
}

func TestAdminDomainList(t *testing.T) {
	f := newFixture(t)
	a := f.createOrg("alpha")
	b := f.createOrg("beta")
	for _, d := range []struct {
		org  string
		host string
	}{{a.ID, "app.alpha.example"}, {b.ID, "www.beta.example"}} {
		err := f.st.Q().CreateDomain(f.ctx, db.CreateDomainParams{
			ID: store.NewID("dom_"), OrgID: d.org, ProjectSlug: "main", ServiceID: "svc_1",
			Host: d.host, Token: "tok", Status: "pending", CreatedAt: 1,
		})
		if err != nil {
			t.Fatalf("CreateDomain: %v", err)
		}
	}
	got, err := f.svc.Domains(f.ctx, f.admin)
	if err != nil {
		t.Fatalf("Domains: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("domains = %d, want 2", len(got))
	}
	byHost := map[string]DomainView{}
	for _, d := range got {
		byHost[d.Host] = d
	}
	if byHost["app.alpha.example"].Org.Slug != "alpha" || byHost["www.beta.example"].Org.Name != "Org beta" {
		t.Fatalf("domains = %+v, want org refs per host", got)
	}
}

func TestOrgOwnerSeesOwnUsageOnly(t *testing.T) {
	f := newFixture(t)
	mine := f.createOrg("mine")
	rival := store.NewID("usr_")
	if err := f.st.Q().CreateUser(f.ctx, db.CreateUserParams{ID: rival, Email: "r@example.com", Name: "R", CreatedAt: 1, UpdatedAt: 1}); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	other, err := f.orgs.Create(f.ctx, audit.Actor{UserID: "cli"}, "other", "Org other", rival)
	if err != nil {
		t.Fatalf("Create(other): %v", err)
	}
	owner := f.ownerSub(mine.ID)

	if _, err := f.svc.OrgUsage(f.ctx, owner, mine.ID); err != nil {
		t.Fatalf("owner OrgUsage(own): %v", err)
	}
	if _, err := f.svc.OrgUsage(f.ctx, owner, other.ID); !errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("owner OrgUsage(other) err = %v, want ErrNotFound", err)
	}
	memberID := store.NewID("usr_")
	if err := f.st.Q().CreateUser(f.ctx, db.CreateUserParams{ID: memberID, Email: "m@example.com", Name: "M", CreatedAt: 1, UpdatedAt: 1}); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if err := f.st.Q().AddMember(f.ctx, db.AddMemberParams{OrgID: mine.ID, UserID: memberID, Role: authz.RoleMember}); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	member := authz.Subject{UserID: memberID}
	if _, err := f.svc.OrgUsage(f.ctx, member, mine.ID); !errors.Is(err, apperr.ErrForbidden) {
		t.Fatalf("member OrgUsage err = %v, want ErrForbidden", err)
	}
	stranger := authz.Subject{UserID: store.NewID("usr_")}
	if _, err := f.svc.OrgUsage(f.ctx, stranger, mine.ID); !errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("non-member OrgUsage err = %v, want ErrNotFound", err)
	}
	if _, err := f.svc.OrgUsage(f.ctx, f.admin, mine.ID); err != nil {
		t.Fatalf("admin OrgUsage: %v", err)
	}
}

func TestAdminCacheView(t *testing.T) {
	f := newFixture(t)
	raw, err := f.svc.Cache(f.ctx, f.admin)
	if err != nil {
		t.Fatalf("Cache: %v", err)
	}
	var v map[string]any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("cache json: %v", err)
	}
	if _, ok := v["hits"]; !ok {
		t.Fatalf("cache = %s, want hits field", raw)
	}
}

func contains(s []string, want string) bool {
	for _, v := range s {
		if v == want {
			return true
		}
	}
	return false
}
