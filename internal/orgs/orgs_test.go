package orgs

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/audit"
	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/runtime"
	"github.com/21cloud/runtime-web/internal/runtime/runtimetest"
	"github.com/21cloud/runtime-web/internal/seal"
	"github.com/21cloud/runtime-web/internal/store"
	"github.com/21cloud/runtime-web/internal/store/db"
)

const testPlan = "standard"

type fixture struct {
	fake  *runtimetest.Fake
	rt    *runtime.Client
	root  runtime.RootCred
	st    *store.Store
	svc   *Service
	owner string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	ctx := context.Background()
	fake := runtimetest.NewServer(t)
	fake.SetPlan(testPlan, runtimetest.FakePlan{MaxServices: 10, MaxSchedules: 3, Triggers: []string{"http"}})
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
	svc := New(st, rt, root, seal.New(key), testPlan)
	return &fixture{fake: fake, rt: rt, root: root, st: st, svc: svc, owner: owner}
}

var cli = audit.Actor{UserID: "cli"}

func (f *fixture) create(t *testing.T, slug string) Org {
	t.Helper()
	org, err := f.svc.Create(context.Background(), cli, slug, "Org "+slug, f.owner)
	if err != nil {
		t.Fatalf("Create(%s): %v", slug, err)
	}
	return org
}

func (f *fixture) tenantCount(t *testing.T) int {
	t.Helper()
	page, err := f.rt.With(f.root).ListTenants(context.Background(), "")
	if err != nil {
		t.Fatalf("ListTenants: %v", err)
	}
	return len(page.Items)
}

func TestCreateOrgProvisionsTenantAndKey(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	org := f.create(t, "acme")

	tenant, err := f.rt.With(f.root).GetTenant(ctx, org.TenantID)
	if err != nil {
		t.Fatalf("GetTenant: %v", err)
	}
	if tenant.Plan != testPlan {
		t.Errorf("tenant plan = %q, want %q", tenant.Plan, testPlan)
	}

	cred, err := f.svc.DefaultCred(ctx, org.ID)
	if err != nil {
		t.Fatalf("DefaultCred: %v", err)
	}
	me, err := f.rt.With(cred).Me(ctx)
	if err != nil {
		t.Fatalf("Me with default key: %v", err)
	}
	for _, sc := range authz.DefaultKeyScopes() {
		if !contains(me.Scopes, sc) {
			t.Errorf("default key lacks scope %q; scopes = %v", sc, me.Scopes)
		}
	}
	if contains(me.Scopes, "keys:write") {
		t.Errorf("default key has keys:write; scopes = %v", me.Scopes)
	}

	keys, err := f.rt.With(runtime.RootCred{Token: f.root.Token, Tenant: org.TenantID}).ListKeys(ctx)
	if err != nil {
		t.Fatalf("ListKeys: %v", err)
	}
	if len(keys) != 1 || keys[0].Name == nil || *keys[0].Name != "rtweb-default" {
		t.Errorf("tenant keys = %+v, want one named rtweb-default", keys)
	}

	m, err := f.st.Q().GetMember(ctx, db.GetMemberParams{OrgID: org.ID, UserID: f.owner})
	if err != nil {
		t.Fatalf("GetMember: %v", err)
	}
	if m.Role != "owner" {
		t.Errorf("owner role = %q, want owner", m.Role)
	}
}

func TestCreateOrgCompensatesOnDBError(t *testing.T) {
	f := newFixture(t)
	before := f.tenantCount(t)
	f.svc.hookInsert = func(*db.Queries) error { return errors.New("disk full") }

	_, err := f.svc.Create(context.Background(), cli, "acme", "Acme", f.owner)
	if err == nil {
		t.Fatal("Create succeeded despite DB failure")
	}
	if after := f.tenantCount(t); after != before {
		t.Errorf("tenants = %d after failed create, want %d (compensation missing)", after, before)
	}
	orgs, err := f.svc.List(context.Background(), "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(orgs) != 0 {
		t.Errorf("orgs = %d after failed create, want 0", len(orgs))
	}
}

func TestCreateOrgValidationAndSlugTaken(t *testing.T) {
	tests := []struct {
		name, slug, display string
		wantInvalid         bool
		wantConflict        string
	}{
		{name: "empty slug", slug: "", display: "A", wantInvalid: true},
		{name: "empty name", slug: "a", display: "", wantInvalid: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			_, err := f.svc.Create(context.Background(), cli, tt.slug, tt.display, f.owner)
			if !errors.Is(err, apperr.ErrInvalid) {
				t.Fatalf("err = %v, want ErrInvalid", err)
			}
		})
	}
	t.Run("slug taken", func(t *testing.T) {
		f := newFixture(t)
		f.create(t, "acme")
		_, err := f.svc.Create(context.Background(), cli, "acme", "Again", f.owner)
		if code, ok := apperr.ConflictCode(err); !ok || code != "slug_taken" {
			t.Fatalf("err = %v, want conflict slug_taken", err)
		}
	})
	t.Run("unknown owner", func(t *testing.T) {
		f := newFixture(t)
		_, err := f.svc.Create(context.Background(), cli, "acme", "Acme", "usr_missing")
		if !errors.Is(err, apperr.ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
		if n := f.tenantCount(t); n != 0 {
			t.Errorf("tenants = %d, want 0 (no tenant for unknown owner)", n)
		}
	})
}

func TestRenameAndGet(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	org := f.create(t, "acme")
	if err := f.svc.Rename(ctx, cli, org.ID, "Acme Corp"); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	got, err := f.svc.Get(ctx, org.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Name != "Acme Corp" {
		t.Errorf("Name = %q, want Acme Corp", got.Name)
	}
	if _, err := f.svc.Get(ctx, "org_missing"); !errors.Is(err, apperr.ErrNotFound) {
		t.Errorf("Get(missing) err = %v, want ErrNotFound", err)
	}
}

func TestListForUser(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.create(t, "acme")
	f.create(t, "globex")
	mine, err := f.svc.List(ctx, f.owner)
	if err != nil {
		t.Fatalf("List(owner): %v", err)
	}
	if len(mine) != 2 {
		t.Errorf("List(owner) = %d orgs, want 2", len(mine))
	}
	others, err := f.svc.List(ctx, "usr_nobody")
	if err != nil {
		t.Fatalf("List(nobody): %v", err)
	}
	if len(others) != 0 {
		t.Errorf("List(nobody) = %d orgs, want 0", len(others))
	}
}

func TestDefaultCredInvalidate(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	org := f.create(t, "acme")
	first, err := f.svc.DefaultCred(ctx, org.ID)
	if err != nil {
		t.Fatalf("DefaultCred: %v", err)
	}
	second, err := f.svc.DefaultCred(ctx, org.ID)
	if err != nil || second.Secret != first.Secret {
		t.Fatalf("cached DefaultCred differs: %v", err)
	}
	f.svc.InvalidateCred(org.ID)
	if _, ok := f.svc.cache[org.ID]; ok {
		t.Errorf("cache still holds %s after InvalidateCred", org.ID)
	}
}

func TestDeleteOrg(t *testing.T) {
	ctx := context.Background()
	t.Run("removes empty org", func(t *testing.T) {
		f := newFixture(t)
		org := f.create(t, "acme")
		if err := f.svc.Delete(ctx, cli, org.ID); err != nil {
			t.Fatalf("Delete: %v", err)
		}
		if _, err := f.svc.Get(ctx, org.ID); !errors.Is(err, apperr.ErrNotFound) {
			t.Errorf("Get after delete err = %v, want ErrNotFound", err)
		}
		if n := f.tenantCount(t); n != 0 {
			t.Errorf("tenants = %d after delete, want 0", n)
		}
	})
	t.Run("refuses non-empty tenant", func(t *testing.T) {
		f := newFixture(t)
		org := f.create(t, "acme")
		_, err := f.rt.With(runtime.RootCred{Token: f.root.Token, Tenant: org.TenantID}).CreateService(ctx, runtime.ServiceCreate{Slug: "api", Runtime: "deno"})
		if err != nil {
			t.Fatalf("CreateService: %v", err)
		}
		err = f.svc.Delete(ctx, cli, org.ID)
		if code, ok := apperr.ConflictCode(err); !ok || code != "org_not_empty" {
			t.Fatalf("Delete err = %v, want conflict org_not_empty", err)
		}
		if _, err := f.svc.Get(ctx, org.ID); err != nil {
			t.Errorf("org gone after refused delete: %v", err)
		}
	})
}

func TestOrgAuditWritten(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	org := f.create(t, "acme")
	if err := f.svc.Rename(ctx, cli, org.ID, "Acme 2"); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	entries, _, err := audit.List(ctx, f.st.Q(), audit.Filter{OrgID: &org.ID})
	if err != nil {
		t.Fatalf("audit.List: %v", err)
	}
	actions := map[string]bool{}
	for _, e := range entries {
		actions[e.Action] = true
	}
	if !actions["org.create"] || !actions["org.rename"] {
		t.Errorf("audit actions = %v, want org.create and org.rename", actions)
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// failDeletes is a transport that fails every DELETE with a runtime 500 and passes other requests through.
type failDeletes struct{}

func (failDeletes) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.Method == http.MethodDelete {
		return &http.Response{
			StatusCode: http.StatusInternalServerError,
			Header:     http.Header{"Content-Type": {"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"error":{"code":"internal","message":"boom"}}`)),
			Request:    r,
		}, nil
	}
	return http.DefaultTransport.RoundTrip(r)
}

func TestCreateOrgRejectsDisabledOwner(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	if _, err := f.st.Q().SetUserDisabled(ctx, db.SetUserDisabledParams{Disabled: 1, UpdatedAt: 2, ID: f.owner}); err != nil {
		t.Fatalf("SetUserDisabled: %v", err)
	}
	_, err := f.svc.Create(ctx, cli, "acme", "Acme", f.owner)
	if !errors.Is(err, apperr.ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	}
	if n := f.tenantCount(t); n != 0 {
		t.Errorf("tenants = %d, want 0", n)
	}
}

func TestCreateOrgSlugRaceMapsToSlugTaken(t *testing.T) {
	f := newFixture(t)
	before := f.tenantCount(t)
	// Simulate a concurrent create that commits the same slug between our check and insert.
	f.svc.hookInsert = func(q *db.Queries) error {
		return q.CreateOrg(context.Background(), db.CreateOrgParams{
			ID: store.NewID("org_"), Slug: "acme", Name: "Racer", TenantID: "tnt_racer", CreatedAt: 1,
		})
	}
	_, err := f.svc.Create(context.Background(), cli, "acme", "Acme", f.owner)
	if code, ok := apperr.ConflictCode(err); !ok || code != "slug_taken" {
		t.Fatalf("err = %v, want conflict slug_taken", err)
	}
	if after := f.tenantCount(t); after != before {
		t.Errorf("tenants = %d, want %d (losing create must purge its tenant)", after, before)
	}
}

func TestDeleteOrgRuntimeFailureAfterDBDelete(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	org := f.create(t, "acme")
	f.svc.rt = runtime.New(f.fake.URL, &http.Client{Transport: failDeletes{}})

	if err := f.svc.Delete(ctx, cli, org.ID); err == nil {
		t.Fatal("Delete succeeded although the runtime tenant delete failed")
	}
	if _, err := f.svc.Get(ctx, org.ID); !errors.Is(err, apperr.ErrNotFound) {
		t.Errorf("org row still present after DB delete: err = %v", err)
	}
	entries, _, err := audit.List(ctx, f.st.Q(), audit.Filter{Action: "org.delete.runtime_failed"})
	if err != nil {
		t.Fatalf("audit.List: %v", err)
	}
	if len(entries) != 1 || entries[0].Target != org.TenantID {
		t.Fatalf("runtime_failed entries = %+v, want one with target %s", entries, org.TenantID)
	}
}
