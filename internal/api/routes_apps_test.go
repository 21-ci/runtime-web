package api

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"testing"

	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/domains"
	"github.com/21cloud/runtime-web/internal/runtime"
)

// appEnv is an owner with project web/production and an app shop created over HTTP.
type appEnv struct {
	*testEnv
	org    string
	orgID  string
	cookie string
	csrf   string
	etag   string
}

func newAppEnv(t *testing.T) *appEnv {
	t.Helper()
	e := newTestEnv(t)
	ownerID := e.mkUser("owner@example.com", testPassword)
	org := e.mkOrg("acme", ownerID)
	cookie, csrf := e.session("owner@example.com")
	base := "/api/orgs/" + org.Slug
	rec := e.send(http.MethodPost, base+"/projects", map[string]any{"slug": "web", "name": "Web", "environments": []string{"production"}},
		withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusCreated)
	rec = e.send(http.MethodPost, base+"/apps", map[string]string{"project": "web", "environment": "production", "slug": "shop", "template": "http"},
		withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusCreated)
	ae := &appEnv{testEnv: e, org: org.Slug, orgID: org.ID, cookie: cookie, csrf: csrf}
	ae.etag = ae.getETag(t, "shop")
	return ae
}

func (a *appEnv) appURL(slug string) string { return "/api/orgs/" + a.org + "/apps/" + slug }

// getETag reads the app and returns its ETag header, unquoted.
func (a *appEnv) getETag(t *testing.T, slug string) string {
	t.Helper()
	rec := a.send(http.MethodGet, a.appURL(slug), nil, withCookie(a.cookie))
	expectStatus(t, rec, http.StatusOK)
	etag := rec.Header().Get("ETag")
	if etag == "" {
		t.Fatal("GET app: no ETag header")
	}
	return etag
}

func withIfMatch(v string) func(*http.Request) {
	return func(r *http.Request) { r.Header.Set("If-Match", v) }
}

func TestAppETagRoundTrip(t *testing.T) {
	a := newAppEnv(t)
	url := a.appURL("shop")
	patch := map[string]string{"access": "key"}

	rec := a.send(http.MethodPatch, url, patch, withCookie(a.cookie), withCSRF(a.csrf))
	expectStatus(t, rec, http.StatusPreconditionRequired)
	if got := errCode(t, rec); got != "precondition_required" {
		t.Fatalf("missing If-Match code = %q", got)
	}

	rec = a.send(http.MethodPatch, url, patch, withCookie(a.cookie), withCSRF(a.csrf), withIfMatch(`"stale"`))
	expectStatus(t, rec, http.StatusConflict)
	if got := errCode(t, rec); got != "stale" {
		t.Fatalf("stale code = %q, want stale", got)
	}

	rec = a.send(http.MethodPatch, url, patch, withCookie(a.cookie), withCSRF(a.csrf), withIfMatch(a.etag))
	expectStatus(t, rec, http.StatusOK)
	next := rec.Header().Get("ETag")
	if next == "" || next == a.etag {
		t.Fatalf("PATCH ETag = %q, want a new one", next)
	}

	rec = a.send(http.MethodPatch, url, patch, withCookie(a.cookie), withCSRF(a.csrf), withIfMatch(a.etag))
	expectStatus(t, rec, http.StatusConflict)
}

func TestSlugTaken409(t *testing.T) {
	a := newAppEnv(t)
	rec := a.send(http.MethodPost, "/api/orgs/"+a.org+"/apps",
		map[string]string{"project": "web", "environment": "production", "slug": "shop", "template": "http"},
		withCookie(a.cookie), withCSRF(a.csrf))
	expectStatus(t, rec, http.StatusConflict)
	if got := errCode(t, rec); got != "slug_taken" {
		t.Fatalf("code = %q, want slug_taken", got)
	}
}

func TestSaveRequiresIfMatch(t *testing.T) {
	a := newAppEnv(t)
	body := map[string]any{"entry": "main.ts", "files": map[string]string{"main.ts": "export default 1"}}
	rec := a.send(http.MethodPut, a.appURL("shop")+"/files", body, withCookie(a.cookie), withCSRF(a.csrf))
	expectStatus(t, rec, http.StatusPreconditionRequired)
}

func TestSaveDiagnostics422(t *testing.T) {
	a := newAppEnv(t)
	ctx := context.Background()
	app, err := a.srv.deps.Apps.Resolve(ctx, a.orgID, "shop")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	a.fake.FailBuild(app.SvcID, []byte(`[{"file":"main.ts","line":1,"column":2,"message":"bad"}]`))
	body := map[string]any{"entry": "main.ts", "files": map[string]string{"main.ts": "broken"}}
	rec := a.send(http.MethodPut, a.appURL("shop")+"/files", body, withCookie(a.cookie), withCSRF(a.csrf), withIfMatch(a.etag))
	expectStatus(t, rec, http.StatusUnprocessableEntity)
	if got := errCode(t, rec); got != "build_failed" {
		t.Fatalf("code = %q, want build_failed", got)
	}
	details, _ := decode(t, rec)["error"].(map[string]any)["details"].(map[string]any)
	if _, ok := details["diagnostics"]; !ok {
		t.Fatalf("details = %v, want diagnostics", details)
	}
}

func TestEndToEndAppDeploy(t *testing.T) {
	a := newAppEnv(t)
	body := map[string]any{"entry": "main.ts", "files": map[string]string{"main.ts": "export default () => new Response('ok')"}}
	rec := a.send(http.MethodPut, a.appURL("shop")+"/files", body, withCookie(a.cookie), withCSRF(a.csrf), withIfMatch(a.etag))
	expectStatus(t, rec, http.StatusOK)
	version, _ := decode(t, rec)["version"].(map[string]any)
	if version["version"] != float64(2) {
		t.Fatalf("saved version = %v, want 2", version["version"])
	}

	rec = a.send(http.MethodGet, a.appURL("shop")+"/versions", nil, withCookie(a.cookie))
	expectStatus(t, rec, http.StatusOK)
	items, _ := decode(t, rec)["items"].([]any)
	if len(items) < 2 {
		t.Fatalf("versions = %d, want >= 2", len(items))
	}
	if first, _ := items[0].(map[string]any); first["version"] != float64(2) || first["live"] != true {
		t.Fatalf("newest version = %v, want live v2", first)
	}
}

func TestDomainsIncludeCertStatus(t *testing.T) {
	a := newAppEnv(t)
	rt := runtime.New(a.fake.URL, http.DefaultClient)
	a.srv.deps.Domains = domains.New(a.st, rt, runtime.RootCred{Token: a.fake.RootToken}, a.srv.deps.Apps, domains.Options{
		BaseDomain: "apps.example.test", ConsoleHost: "console.example.test",
		RuntimeHost: "runtime.example.test", CNAMETarget: "router.example.test",
	})
	rec := a.send(http.MethodPost, a.appURL("shop")+"/domains", map[string]string{"host": "shop.customer.test"},
		withCookie(a.cookie), withCSRF(a.csrf))
	expectStatus(t, rec, http.StatusCreated)
	rec = a.send(http.MethodGet, a.appURL("shop")+"/domains", nil, withCookie(a.cookie))
	expectStatus(t, rec, http.StatusOK)
	items, _ := decode(t, rec)["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("domains = %d, want 1", len(items))
	}
	if d, _ := items[0].(map[string]any); d["cert_status"] != "none" {
		t.Fatalf("domain = %v, want cert_status none", d)
	}
}

func TestDeleteAppRemovesDomains(t *testing.T) {
	a := newAppEnv(t)
	ctx := context.Background()
	rt := runtime.New(a.fake.URL, http.DefaultClient)
	a.srv.deps.Domains = domains.New(a.st, rt, runtime.RootCred{Token: a.fake.RootToken}, a.srv.deps.Apps, domains.Options{
		BaseDomain: "apps.example.test", ConsoleHost: "console.example.test",
		RuntimeHost: "runtime.example.test", CNAMETarget: "router.example.test",
	})
	rec := a.send(http.MethodPost, a.appURL("shop")+"/domains", map[string]string{"host": "shop.customer.test"},
		withCookie(a.cookie), withCSRF(a.csrf))
	expectStatus(t, rec, http.StatusCreated)
	id, _ := decode(t, rec)["id"].(string)

	rec = a.send(http.MethodDelete, a.appURL("shop"), nil, withCookie(a.cookie), withCSRF(a.csrf))
	expectStatus(t, rec, http.StatusNoContent)
	if _, err := a.st.Q().GetDomain(ctx, id); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("domain after app delete: err = %v, want no rows", err)
	}
}

func TestProjectOnlyViewerScopedToProject(t *testing.T) {
	a := newAppEnv(t)
	base := "/api/orgs/" + a.org
	rec := a.send(http.MethodPost, base+"/projects", map[string]any{"slug": "blog", "name": "Blog", "environments": []string{"production"}},
		withCookie(a.cookie), withCSRF(a.csrf))
	expectStatus(t, rec, http.StatusCreated)
	rec = a.send(http.MethodPost, base+"/apps", map[string]string{"project": "blog", "environment": "production", "slug": "news", "template": "http"},
		withCookie(a.cookie), withCSRF(a.csrf))
	expectStatus(t, rec, http.StatusCreated)

	viewerID := a.mkUser("viewer@example.com", testPassword)
	a.addMember(a.orgID, viewerID, authz.RoleMember)
	rec = a.send(http.MethodPut, base+"/members/"+viewerID+"/grants/web", map[string]string{"role": authz.RoleViewer},
		withCookie(a.cookie), withCSRF(a.csrf))
	if rec.Code >= 300 {
		t.Fatalf("grant status = %d: %s", rec.Code, rec.Body.String())
	}
	vcookie, _ := a.session("viewer@example.com")

	rec = a.send(http.MethodGet, a.appURL("shop"), nil, withCookie(vcookie))
	expectStatus(t, rec, http.StatusOK)
	rec = a.send(http.MethodGet, a.appURL("news"), nil, withCookie(vcookie))
	expectStatus(t, rec, http.StatusNotFound)
}

func TestPlanTriggersForbidden403(t *testing.T) {
	a := newAppEnv(t)
	base := a.appURL("shop")
	rec := a.send(http.MethodPost, base+"/schedules", map[string]any{"kind": "cron", "cron": "0 * * * *", "timezone": "UTC"},
		withCookie(a.cookie), withCSRF(a.csrf))
	expectStatus(t, rec, http.StatusForbidden)
	if got := errCode(t, rec); got != "plan_limit" {
		t.Fatalf("schedule code = %q, want plan_limit", got)
	}
	rec = a.send(http.MethodPost, base+"/queue", map[string]any{"body": map[string]int{"n": 1}},
		withCookie(a.cookie), withCSRF(a.csrf))
	expectStatus(t, rec, http.StatusForbidden)
	if got := errCode(t, rec); got != "plan_limit" {
		t.Fatalf("queue code = %q, want plan_limit", got)
	}
}
