package domains

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/apps"
	"github.com/21cloud/runtime-web/internal/audit"
	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/orgs"
	"github.com/21cloud/runtime-web/internal/runtime"
	"github.com/21cloud/runtime-web/internal/runtime/runtimetest"
	"github.com/21cloud/runtime-web/internal/seal"
	"github.com/21cloud/runtime-web/internal/store"
	"github.com/21cloud/runtime-web/internal/store/db"
)

const (
	testPlan    = "standard"
	baseDomain  = "apps.example.net"
	consoleHost = "console.example.org"
	runtimeHost = "rt.example.io"
)

var owner = authz.Subject{UserID: "usr_owner", OrgRole: authz.RoleOwner}

// fakeDNS is an in-memory Resolver.
type fakeDNS struct {
	mu  sync.Mutex
	txt map[string][]string
}

func (d *fakeDNS) LookupTXT(_ context.Context, name string) ([]string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	v, ok := d.txt[name]
	if !ok {
		return nil, errors.New("no such host")
	}
	return v, nil
}

func (d *fakeDNS) set(name string, vals ...string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if vals == nil {
		delete(d.txt, name)
		return
	}
	d.txt[name] = vals
}

type fixture struct {
	fake *runtimetest.Fake
	rt   *runtime.Client
	root runtime.RootCred
	st   *store.Store
	apps *apps.Service
	dns  *fakeDNS
	svc  *Service
	now  time.Time
	orgs *orgs.Service
	orgA orgs.Org
	orgB orgs.Org
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	ctx := context.Background()
	fake := runtimetest.NewServer(t)
	fake.SetPlan(testPlan, runtimetest.FakePlan{MaxServices: 20, MaxSchedules: 3, Triggers: []string{"http"}})
	st, err := store.Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	uid := store.NewID("usr_")
	if err := st.Q().CreateUser(ctx, db.CreateUserParams{ID: uid, Email: "o@example.com", Name: "O", CreatedAt: 1, UpdatedAt: 1}); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	rt := runtime.New(fake.URL, http.DefaultClient)
	root := runtime.RootCred{Token: fake.RootToken}
	var key [32]byte
	for i := range key {
		key[i] = byte(i + 5)
	}
	o := orgs.New(st, rt, root, seal.New(key), testPlan)
	f := &fixture{orgs: o, fake: fake, rt: rt, root: root, st: st, apps: apps.New(rt, o, st), dns: &fakeDNS{txt: map[string][]string{}}}
	f.now = time.UnixMilli(1_800_000_000_000)
	f.svc = New(st, rt, root, f.apps, Options{
		BaseDomain:  baseDomain,
		ConsoleHost: consoleHost,
		RuntimeHost: runtimeHost,
		CNAMETarget: "router.example.org",
		Resolver:    f.dns,
		Now:         func() time.Time { return f.now },
	})
	for i, slug := range []string{"orga", "orgb"} {
		org, err := o.Create(ctx, audit.Actor{UserID: uid}, slug, slug, uid)
		if err != nil {
			t.Fatalf("orgs.Create: %v", err)
		}
		if i == 0 {
			f.orgA = org
		} else {
			f.orgB = org
		}
	}
	return f
}

func (f *fixture) app(t *testing.T, orgID, slug string) apps.AppView {
	t.Helper()
	v, err := f.apps.Create(context.Background(), owner, orgID, "default", "production", slug, "http")
	if err != nil {
		t.Fatalf("apps.Create(%s): %v", slug, err)
	}
	return v
}

func (f *fixture) add(t *testing.T, orgID, slug, host string) Domain {
	t.Helper()
	d, err := f.svc.Add(context.Background(), owner, orgID, slug, host)
	if err != nil {
		t.Fatalf("Add(%s): %v", host, err)
	}
	return d
}

func (f *fixture) runtimeHosts(t *testing.T, svcID string) map[string]bool {
	t.Helper()
	hs, err := f.rt.With(f.root).ListHosts(context.Background(), svcID)
	if err != nil {
		t.Fatalf("ListHosts: %v", err)
	}
	out := map[string]bool{}
	for _, h := range hs {
		out[h.Host] = h.Status == "active"
	}
	return out
}

func TestDomainValidation(t *testing.T) {
	f := newFixture(t)
	f.app(t, f.orgA.ID, "shop")
	long := strings.Repeat("a.", 126) + "ab" // 254 chars
	tests := []struct {
		name, host, want string
		ok               bool
	}{
		{"normalized", "Shop.Example.com.", "shop.example.com", true},
		{"idna", "bücher.de", "xn--bcher-kva.de", true},
		{"ipv4", "1.2.3.4", "", false},
		{"ipv6", "[::1]", "", false},
		{"wildcard", "*.x.com", "", false},
		{"port", "x.com:443", "", false},
		{"base apex", baseDomain, "", false},
		{"base sub", "a." + baseDomain, "", false},
		{"console", consoleHost, "", false},
		{"runtime", runtimeHost, "", false},
		{"too long", long, "", false},
		{"single label", "localhost", "", false},
		{"empty", "", "", false},
		{"underscore", "_rtweb.x.com", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d, err := f.svc.Add(context.Background(), owner, f.orgA.ID, "shop", tt.host)
			if !tt.ok {
				if !errors.Is(err, apperr.ErrInvalid) {
					t.Fatalf("Add(%q) err = %v, want ErrInvalid", tt.host, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("Add(%q): %v", tt.host, err)
			}
			if d.Host != tt.want || d.Status != "pending" || d.App != "shop" {
				t.Fatalf("domain = %+v, want host %s pending", d, tt.want)
			}
			if d.TXTName != "_rtweb."+tt.want || len(d.TXTValue) != 32 {
				t.Fatalf("txt = %s=%s", d.TXTName, d.TXTValue)
			}
		})
	}
}

func TestDomainConflict(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.app(t, f.orgA.ID, "a1")
	f.app(t, f.orgB.ID, "b1")
	da := f.add(t, f.orgA.ID, "a1", "shop.example.com")
	dB := f.add(t, f.orgB.ID, "b1", "shop.example.com")
	f.dns.set("_rtweb.shop.example.com", da.TXTValue, dB.TXTValue)

	got, err := f.svc.Verify(ctx, owner, f.orgA.ID, da.ID)
	if err != nil || got.Status != "active" {
		t.Fatalf("Verify A = %+v, %v", got, err)
	}
	_, err = f.svc.Verify(ctx, owner, f.orgB.ID, dB.ID)
	var c apperr.Conflict
	if !errors.As(err, &c) || c.Code != "host_taken" {
		t.Fatalf("Verify B err = %v, want host_taken", err)
	}
	if _, err := f.svc.Add(ctx, owner, f.orgB.ID, "b1", "shop.example.com."); !errors.As(err, &c) || c.Code != "host_taken" {
		t.Fatalf("Add after active err = %v, want host_taken", err)
	}
	list, err := f.svc.List(ctx, owner, f.orgB.ID, "b1")
	if err != nil || len(list) != 1 || list[0].Status != "failed" {
		t.Fatalf("org B list = %+v, %v; want one failed", list, err)
	}
	// Org B cannot touch org A's domain.
	if _, err := f.svc.Verify(ctx, owner, f.orgB.ID, da.ID); !errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("cross-org Verify err = %v, want ErrNotFound", err)
	}
	if err := f.svc.Remove(ctx, owner, f.orgB.ID, da.ID); !errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("cross-org Remove err = %v, want ErrNotFound", err)
	}
}

func TestVerifyActivatesViaRoot(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.app(t, f.orgA.ID, "shop")
	d := f.add(t, f.orgA.ID, "shop", "shop.example.com")

	got, err := f.svc.Verify(ctx, owner, f.orgA.ID, d.ID)
	if err != nil || got.Status != "pending" || got.LastCheckedAt == nil {
		t.Fatalf("Verify without TXT = %+v, %v; want pending and checked", got, err)
	}
	f.dns.set("_rtweb.shop.example.com", "wrong")
	if got, _ := f.svc.Verify(ctx, owner, f.orgA.ID, d.ID); got.Status != "pending" {
		t.Fatalf("Verify wrong TXT status = %s", got.Status)
	}
	if len(f.runtimeHosts(t, v.Raw.ID)) != 0 {
		t.Fatal("runtime host mapped before verification")
	}
	f.dns.set("_rtweb.shop.example.com", d.TXTValue)
	got, err = f.svc.Verify(ctx, owner, f.orgA.ID, d.ID)
	if err != nil || got.Status != "active" || got.VerifiedAt == nil {
		t.Fatalf("Verify = %+v, %v", got, err)
	}
	if active, ok := f.runtimeHosts(t, v.Raw.ID)["shop.example.com"]; !ok || !active {
		t.Fatalf("runtime host not active: %v", f.runtimeHosts(t, v.Raw.ID))
	}

	if err := f.svc.Remove(ctx, owner, f.orgA.ID, d.ID); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if len(f.runtimeHosts(t, v.Raw.ID)) != 0 {
		t.Fatal("runtime host still mapped after Remove")
	}
	if list, _ := f.svc.List(ctx, owner, f.orgA.ID, "shop"); len(list) != 0 {
		t.Fatalf("list after remove = %+v", list)
	}
}

func TestVerifyRuntimeHostTakenReverts(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.app(t, f.orgA.ID, "shop")
	other := f.app(t, f.orgB.ID, "other")
	// Another service holds the host on the runtime (outside the web DB).
	if _, err := f.rt.With(f.root).PutHost(ctx, other.Raw.ID, "shop.example.com"); err != nil {
		t.Fatalf("PutHost: %v", err)
	}
	d := f.add(t, f.orgA.ID, "shop", "shop.example.com")
	f.dns.set("_rtweb.shop.example.com", d.TXTValue)
	_, err := f.svc.Verify(ctx, owner, f.orgA.ID, d.ID)
	var c apperr.Conflict
	if !errors.As(err, &c) || c.Code != "host_taken" {
		t.Fatalf("Verify err = %v, want host_taken", err)
	}
	r, _, _ := f.svc.Routes(ctx)
	if len(r.Hosts) != 0 {
		t.Fatalf("routes = %+v, want none", r.Hosts)
	}
}

func TestPendingExpiresAfter24h(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.app(t, f.orgA.ID, "shop")
	d := f.add(t, f.orgA.ID, "shop", "shop.example.com")
	late := f.add(t, f.orgA.ID, "shop", "late.example.com")

	f.now = f.now.Add(23 * time.Hour)
	f.dns.set("_rtweb.late.example.com", late.TXTValue)
	f.svc.CheckOnce(ctx)
	if got := f.get(t, late.ID); got.Status != "active" {
		t.Fatalf("checker did not activate late: %s", got.Status)
	}
	if got := f.get(t, d.ID); got.Status != "pending" {
		t.Fatalf("status at 23h = %s", got.Status)
	}
	f.now = f.now.Add(2 * time.Hour)
	f.svc.CheckOnce(ctx)
	if got := f.get(t, d.ID); got.Status != "failed" {
		t.Fatalf("status at 25h = %s, want failed", got.Status)
	}
}

func (f *fixture) get(t *testing.T, id string) db.Domain {
	t.Helper()
	d, err := f.st.Q().GetDomain(context.Background(), id)
	if err != nil {
		t.Fatalf("GetDomain: %v", err)
	}
	return d
}

func TestActiveDeactivatedWhenTXTGone(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.app(t, f.orgA.ID, "shop")
	d := f.add(t, f.orgA.ID, "shop", "shop.example.com")
	f.dns.set("_rtweb.shop.example.com", d.TXTValue)
	if _, err := f.svc.Verify(ctx, owner, f.orgA.ID, d.ID); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	f.dns.set("_rtweb.shop.example.com")

	// Checks within 6 h do not count.
	f.now = f.now.Add(time.Hour)
	f.svc.CheckOnce(ctx)
	if got := f.get(t, d.ID); got.TxtMisses != 0 {
		t.Fatalf("misses after 1h = %d", got.TxtMisses)
	}
	for i := 1; i <= 3; i++ {
		f.now = f.now.Add(6 * time.Hour)
		f.svc.CheckOnce(ctx)
		got := f.get(t, d.ID)
		if i < 3 && (got.Status != "active" || got.TxtMisses != int64(i)) {
			t.Fatalf("check %d: %s misses=%d", i, got.Status, got.TxtMisses)
		}
		if i == 3 && got.Status != "failed" {
			t.Fatalf("after 3 misses status = %s", got.Status)
		}
	}
	if len(f.runtimeHosts(t, v.Raw.ID)) != 0 {
		t.Fatal("runtime host still mapped after deactivation")
	}
	entries, _, err := audit.List(ctx, f.st.Q(), audit.Filter{OrgID: &f.orgA.ID, Action: "domain.deactivate"})
	if err != nil || len(entries) != 1 {
		t.Fatalf("audit = %+v, %v; want one domain.deactivate", entries, err)
	}
}

func TestActiveTXTMissResetsOnHit(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.app(t, f.orgA.ID, "shop")
	d := f.add(t, f.orgA.ID, "shop", "shop.example.com")
	f.dns.set("_rtweb.shop.example.com", d.TXTValue)
	if _, err := f.svc.Verify(ctx, owner, f.orgA.ID, d.ID); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	f.dns.set("_rtweb.shop.example.com")
	for range 2 {
		f.now = f.now.Add(6 * time.Hour)
		f.svc.CheckOnce(ctx)
	}
	f.dns.set("_rtweb.shop.example.com", d.TXTValue)
	f.now = f.now.Add(6 * time.Hour)
	f.svc.CheckOnce(ctx)
	if got := f.get(t, d.ID); got.Status != "active" || got.TxtMisses != 0 {
		t.Fatalf("after hit: %s misses=%d", got.Status, got.TxtMisses)
	}
}

func TestDomainReconcile(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.app(t, f.orgA.ID, "shop")
	d := f.add(t, f.orgA.ID, "shop", "shop.example.com")
	f.dns.set("_rtweb.shop.example.com", d.TXTValue)
	if _, err := f.svc.Verify(ctx, owner, f.orgA.ID, d.ID); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	rc := f.rt.With(f.root)
	// A services:write token removed the host directly; another host was added outside the web.
	if err := rc.DeleteHost(ctx, v.Raw.ID, "shop.example.com"); err != nil {
		t.Fatalf("DeleteHost: %v", err)
	}
	if _, err := rc.PutHost(ctx, v.Raw.ID, "stray.example.com"); err != nil {
		t.Fatalf("PutHost: %v", err)
	}
	f.svc.CheckOnce(ctx)
	hs := f.runtimeHosts(t, v.Raw.ID)
	if !hs["shop.example.com"] {
		t.Fatalf("active host not re-PUT: %v", hs)
	}
	if _, ok := hs["stray.example.com"]; !ok {
		t.Fatalf("stray runtime host was removed: %v", hs)
	}
	r, _, _ := f.svc.Routes(ctx)
	if _, ok := r.Hosts["stray.example.com"]; ok {
		t.Fatal("stray host routed")
	}
}

func TestRoutesOnlyActive(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.app(t, f.orgA.ID, "shop")
	d := f.add(t, f.orgA.ID, "shop", "shop.example.com")
	f.add(t, f.orgA.ID, "shop", "pending.example.com")
	r1, e1, _ := f.svc.Routes(ctx)
	if len(r1.Hosts) != 0 || r1.ConsoleHost != consoleHost || r1.BaseDomain != baseDomain || e1 == "" {
		t.Fatalf("routes = %+v etag %q", r1, e1)
	}
	f.dns.set("_rtweb.shop.example.com", d.TXTValue)
	if _, err := f.svc.Verify(ctx, owner, f.orgA.ID, d.ID); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	r2, e2, _ := f.svc.Routes(ctx)
	if len(r2.Hosts) != 1 || r2.Hosts["shop.example.com"].Slug != "shop" {
		t.Fatalf("routes hosts = %+v", r2.Hosts)
	}
	if e2 == e1 {
		t.Fatal("etag unchanged after activation")
	}
	if _, e3, _ := f.svc.Routes(ctx); e3 != e2 {
		t.Fatal("etag not stable")
	}
}

func TestCertStatusStored(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.app(t, f.orgA.ID, "shop")
	d := f.add(t, f.orgA.ID, "shop", "shop.example.com")
	f.dns.set("_rtweb.shop.example.com", d.TXTValue)
	if _, err := f.svc.Verify(ctx, owner, f.orgA.ID, d.ID); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	na := int64(1_900_000_000_000)
	msg := "rate limited"
	err := f.svc.SetCertStatus(ctx, map[string]CertStatus{
		"shop.example.com":    {Status: "issued", NotAfter: &na},
		"unknown.example.com": {Status: "error", Error: &msg},
	})
	if err != nil {
		t.Fatalf("SetCertStatus: %v", err)
	}
	list, err := f.svc.List(ctx, owner, f.orgA.ID, "shop")
	if err != nil || len(list) != 1 {
		t.Fatalf("List = %+v, %v", list, err)
	}
	got := list[0]
	if got.CertStatus != "issued" || got.CertNotAfter == nil || *got.CertNotAfter != na || got.CertError != nil {
		t.Fatalf("cert = %s %v %v", got.CertStatus, got.CertNotAfter, got.CertError)
	}
	if err := f.svc.SetCertStatus(ctx, map[string]CertStatus{"shop.example.com": {Status: "bogus"}}); err != nil {
		t.Fatalf("SetCertStatus bogus: %v", err)
	}
	if got := f.get(t, d.ID); got.CertStatus != "issued" {
		t.Fatalf("bogus status stored: %s", got.CertStatus)
	}
}

func TestDeveloperCannotManageDomains(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.app(t, f.orgA.ID, "shop")
	d := f.add(t, f.orgA.ID, "shop", "shop.example.com")
	dev := authz.Subject{UserID: "usr_dev", OrgRole: authz.RoleMember, ProjectRoles: map[string]string{"default": authz.RoleDeveloper}}
	stranger := authz.Subject{UserID: "usr_x", OrgRole: authz.RoleMember}

	if _, err := f.svc.Add(ctx, dev, f.orgA.ID, "shop", "dev.example.com"); !errors.Is(err, apperr.ErrForbidden) {
		t.Fatalf("Add by developer err = %v", err)
	}
	if _, err := f.svc.Verify(ctx, dev, f.orgA.ID, d.ID); !errors.Is(err, apperr.ErrForbidden) {
		t.Fatalf("Verify by developer err = %v", err)
	}
	if err := f.svc.Remove(ctx, dev, f.orgA.ID, d.ID); !errors.Is(err, apperr.ErrForbidden) {
		t.Fatalf("Remove by developer err = %v", err)
	}
	if list, err := f.svc.List(ctx, dev, f.orgA.ID, "shop"); err != nil || len(list) != 1 {
		t.Fatalf("List by developer = %+v, %v", list, err)
	}
	if _, err := f.svc.Add(ctx, stranger, f.orgA.ID, "shop", "x.example.com"); !errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("Add by stranger err = %v", err)
	}
	if _, err := f.svc.Verify(ctx, stranger, f.orgA.ID, d.ID); !errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("Verify by stranger err = %v", err)
	}
	projAdmin := authz.Subject{UserID: "usr_pa", OrgRole: authz.RoleMember, ProjectRoles: map[string]string{"default": authz.RoleAdmin}}
	if _, err := f.svc.Add(ctx, projAdmin, f.orgA.ID, "shop", "pa.example.com"); err != nil {
		t.Fatalf("Add by project admin: %v", err)
	}
}

func TestDevResolverOverride(t *testing.T) {
	env := map[string]string{"RTWEB_DEV_DNS_OVERRIDE": "_rtweb.a.test=tok1;_rtweb.a.test=tok2; _rtweb.b.test = x "}
	r := NewResolver(true, func(k string) string { return env[k] })
	got, err := r.LookupTXT(context.Background(), "_rtweb.a.test")
	if err != nil || len(got) != 2 || got[0] != "tok1" || got[1] != "tok2" {
		t.Fatalf("LookupTXT = %v, %v", got, err)
	}
	if got, _ := r.LookupTXT(context.Background(), "_rtweb.b.test"); len(got) != 1 || got[0] != "x" {
		t.Fatalf("LookupTXT b = %v", got)
	}
	if _, ok := NewResolver(false, func(k string) string { return env[k] }).(*DevResolver); ok {
		t.Fatal("non-dev resolver honours the override")
	}
}

func (f *fixture) pendingUnmaps(t *testing.T) int {
	t.Helper()
	ms, err := f.st.Q().ListPendingUnmaps(context.Background())
	if err != nil {
		t.Fatalf("ListPendingUnmaps: %v", err)
	}
	return len(ms)
}

func TestDeactivateUnmapRetried(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.app(t, f.orgA.ID, "shop")
	f.app(t, f.orgB.ID, "rival")
	d := f.add(t, f.orgA.ID, "shop", "shop.example.com")
	f.dns.set("_rtweb.shop.example.com", d.TXTValue)
	if _, err := f.svc.Verify(ctx, owner, f.orgA.ID, d.ID); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	f.dns.set("_rtweb.shop.example.com")
	for range 2 {
		f.now = f.now.Add(6 * time.Hour)
		f.svc.CheckOnce(ctx)
	}
	f.now = f.now.Add(6 * time.Hour)
	f.svc.lastReconcile = f.now // no reconcile in this pass
	f.fake.FailNext(http.StatusInternalServerError, "internal", 0)
	f.svc.CheckOnce(ctx)
	if got := f.get(t, d.ID); got.Status != "failed" {
		t.Fatalf("status = %s, want failed", got.Status)
	}
	if _, ok := f.runtimeHosts(t, v.Raw.ID)["shop.example.com"]; !ok || f.pendingUnmaps(t) != 1 {
		t.Fatalf("want host still mapped with a pending unmap; unmaps=%d", f.pendingUnmaps(t))
	}
	// Meanwhile another org cannot take the host: the runtime still maps it.
	b := f.add(t, f.orgB.ID, "rival", "shop.example.com")
	f.dns.set("_rtweb.shop.example.com", b.TXTValue)
	var c apperr.Conflict
	if _, err := f.svc.Verify(ctx, owner, f.orgB.ID, b.ID); !errors.As(err, &c) || c.Code != "host_taken" {
		t.Fatalf("Verify B before retry err = %v", err)
	}

	f.now = f.now.Add(reconcileEvery)
	f.svc.CheckOnce(ctx)
	if _, ok := f.runtimeHosts(t, v.Raw.ID)["shop.example.com"]; ok || f.pendingUnmaps(t) != 0 {
		t.Fatalf("retry did not unmap; unmaps=%d", f.pendingUnmaps(t))
	}
	if got, err := f.svc.Verify(ctx, owner, f.orgB.ID, b.ID); err != nil || got.Status != "active" {
		t.Fatalf("Verify B after retry = %+v, %v", got, err)
	}
}

func TestRemoveUnmapRetried(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.app(t, f.orgA.ID, "shop")
	d := f.add(t, f.orgA.ID, "shop", "shop.example.com")
	f.dns.set("_rtweb.shop.example.com", d.TXTValue)
	if _, err := f.svc.Verify(ctx, owner, f.orgA.ID, d.ID); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	f.fake.FailNext(http.StatusInternalServerError, "internal", 0)
	if err := f.svc.Remove(ctx, owner, f.orgA.ID, d.ID); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if r, _, _ := f.svc.Routes(ctx); len(r.Hosts) != 0 {
		t.Fatalf("removed host still routed: %+v", r.Hosts)
	}
	if f.pendingUnmaps(t) != 1 {
		t.Fatal("no pending unmap after failed DELETE")
	}
	f.svc.CheckOnce(ctx)
	if _, ok := f.runtimeHosts(t, v.Raw.ID)["shop.example.com"]; ok || f.pendingUnmaps(t) != 0 {
		t.Fatal("reconcile did not unmap removed host")
	}
}

func TestActivateAfterRuntimePut(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.app(t, f.orgA.ID, "shop")
	d := f.add(t, f.orgA.ID, "shop", "shop.example.com")
	f.dns.set("_rtweb.shop.example.com", d.TXTValue)
	called := false
	f.svc.beforeActivate = func() {
		called = true
		if r, _, _ := f.svc.Routes(ctx); len(r.Hosts) != 0 {
			t.Errorf("routed before activation: %+v", r.Hosts)
		}
		if !f.runtimeHosts(t, v.Raw.ID)["shop.example.com"] {
			t.Error("runtime not mapped before activation")
		}
	}
	// A failing runtime PUT leaves the domain pending and unrouted.
	f.fake.FailNext(http.StatusInternalServerError, "internal", 0)
	if _, err := f.svc.Verify(ctx, owner, f.orgA.ID, d.ID); err == nil {
		t.Fatal("Verify with failing PUT succeeded")
	}
	if got := f.get(t, d.ID); got.Status != "pending" || called {
		t.Fatalf("after failed PUT: %s called=%v", got.Status, called)
	}
	if got, err := f.svc.Verify(ctx, owner, f.orgA.ID, d.ID); err != nil || got.Status != "active" || !called {
		t.Fatalf("Verify = %+v, %v, called=%v", got, err, called)
	}
}

func TestReconcileRuntimeStatuses(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.app(t, f.orgA.ID, "shop")
	d := f.add(t, f.orgA.ID, "shop", "shop.example.com")
	f.dns.set("_rtweb.shop.example.com", d.TXTValue)
	if _, err := f.svc.Verify(ctx, owner, f.orgA.ID, d.ID); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	// Replace the mapping with a tenant (pending_verification) claim.
	if err := f.rt.With(f.root).DeleteHost(ctx, v.Raw.ID, "shop.example.com"); err != nil {
		t.Fatalf("DeleteHost: %v", err)
	}
	key, err := f.orgs.DefaultCred(ctx, f.orgA.ID)
	if err != nil {
		t.Fatalf("DefaultCred: %v", err)
	}
	if h, err := f.rt.With(key).PutHost(ctx, v.Raw.ID, "shop.example.com"); err != nil || h.Status != "pending_verification" {
		t.Fatalf("tenant PutHost = %+v, %v", h, err)
	}
	f.svc.CheckOnce(ctx)
	if !f.runtimeHosts(t, v.Raw.ID)["shop.example.com"] {
		t.Fatal("pending_verification host not re-PUT active")
	}
}

func TestDevResolverSetIsReadOnEachLookup(t *testing.T) {
	r, ok := NewResolver(true, func(string) string { return "" }).(*DevResolver)
	if !ok {
		t.Fatal("dev resolver must be a *DevResolver even without RTWEB_DEV_DNS_OVERRIDE")
	}
	r.Next = failResolver{}
	r.Set("_rtweb.New.Test.", []string{"tok"})
	if got, err := r.LookupTXT(context.Background(), "_rtweb.new.test"); err != nil || len(got) != 1 || got[0] != "tok" {
		t.Fatalf("LookupTXT after Set = %v, %v", got, err)
	}
	r.Set("_rtweb.new.test", nil)
	if _, err := r.LookupTXT(context.Background(), "_rtweb.new.test"); err == nil {
		t.Fatal("cleared override should fall through to Next")
	}
}

type failResolver struct{}

func (failResolver) LookupTXT(context.Context, string) ([]string, error) {
	return nil, errors.New("no such host")
}
