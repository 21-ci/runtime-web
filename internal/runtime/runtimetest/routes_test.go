package runtimetest_test

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"github.com/21cloud/runtime-web/internal/runtime"
	"github.com/21cloud/runtime-web/internal/runtime/runtimetest"
)

func TestFakeSelfServiceKeys(t *testing.T) {
	f := runtimetest.NewServer(t)
	ctx := context.Background()
	op := operator(f)
	ten := newTenant(t, op, "acme", "free")
	admin := newKey(t, op, ten.ID, "keys:write", "services:read", "services:write")
	ac := withKey(f, admin.Secret)

	child, err := ac.CreateKey(ctx, runtime.KeyCreate{Name: "ci", Scopes: []string{"services:read"}})
	must(t, err)
	if child.Secret == "" {
		t.Fatal("self-service key returned no secret")
	}
	keys, err := ac.ListKeys(ctx)
	must(t, err)
	if len(keys) != 2 {
		t.Fatalf("ListKeys %d keys, want 2 (admin and child)", len(keys))
	}

	_, err = withKey(f, child.Secret).CreateKey(ctx, runtime.KeyCreate{Scopes: []string{"services:read"}})
	wantAPIErr(t, err, 403, "insufficient_scope")
	_, err = ac.CreateKey(ctx, runtime.KeyCreate{Scopes: []string{"deploy"}})
	wantAPIErr(t, err, 403, "insufficient_scope")

	strong := newKey(t, op, ten.ID, "keys:write", "deploy")
	wantAPIErr(t, ac.RevokeKey(ctx, strong.ID), 403, "insufficient_scope")

	mid, err := ac.CreateKey(ctx, runtime.KeyCreate{Scopes: []string{"keys:write", "services:read"}})
	must(t, err)
	leaf, err := withKey(f, mid.Secret).CreateKey(ctx, runtime.KeyCreate{Scopes: []string{"services:read"}})
	must(t, err)
	must(t, ac.RevokeKey(ctx, mid.ID))
	for _, s := range []string{mid.Secret, leaf.Secret} {
		_, err := withKey(f, s).Me(ctx)
		wantAPIErr(t, err, 401, "unauthorized")
	}

	must(t, ac.RevokeKey(ctx, child.ID))
	wantAPIErr(t, ac.RevokeKey(ctx, child.ID), 404, "not_found")
}

func TestFakeRestrictedKeyScope(t *testing.T) {
	f := runtimetest.NewServer(t)
	ctx := context.Background()
	op := operator(f)
	ten := newTenant(t, op, "acme", "free")
	def, err := asTenant(f, ten.ID).GetProject(ctx, "default")
	must(t, err)
	admin := newKey(t, op, ten.ID, "keys:write", "services:read")
	restricted, err := op.CreateTenantKey(ctx, ten.ID, runtime.KeyCreate{Scopes: []string{"keys:write", "services:read"}, ProjectIDs: []string{def.ID}, Environments: []string{"production"}})
	must(t, err)
	if len(restricted.ProjectIDs) != 1 || restricted.ProjectIDs[0] != def.ID || len(restricted.Environments) != 1 {
		t.Fatalf("restricted key = %+v", restricted.Key)
	}
	_, err = withKey(f, restricted.Secret).CreateKey(ctx, runtime.KeyCreate{Scopes: []string{"services:read"}, Environments: []string{"staging"}})
	wantAPIErr(t, err, 403, "insufficient_scope")
	child, err := withKey(f, restricted.Secret).CreateKey(ctx, runtime.KeyCreate{Scopes: []string{"services:read"}})
	must(t, err)
	if len(child.ProjectIDs) != 1 || len(child.Environments) != 1 {
		t.Fatalf("child key does not inherit restriction: %+v", child.Key)
	}
	must(t, withKey(f, restricted.Secret).RevokeKey(ctx, child.ID))

	keys, err := withKey(f, restricted.Secret).ListKeys(ctx)
	must(t, err)
	if len(keys) != 1 || keys[0].ID != restricted.ID {
		t.Fatalf("restricted caller lists %d keys, want only itself", len(keys))
	}
	wantAPIErr(t, withKey(f, restricted.Secret).RevokeKey(ctx, admin.ID), 404, "not_found")
}

func TestFakeOnceSchedules(t *testing.T) {
	f := runtimetest.NewServer(t)
	ctx := context.Background()
	ten := newTenant(t, operator(f), "acme", "free")
	cl := asTenant(f, ten.ID)
	svc, err := cl.CreateService(ctx, runtime.ServiceCreate{Slug: "api", Runtime: "deno"})
	must(t, err)
	page, err := cl.ListOnceSchedules(ctx, svc.ID, "")
	must(t, err)
	if page.Items == nil || len(page.Items) != 0 {
		t.Fatalf("empty once page = %+v", page)
	}
	id := f.AddOnceSchedule(svc.ID, 42)
	page, err = cl.ListOnceSchedules(ctx, svc.ID, "")
	must(t, err)
	if len(page.Items) != 1 || page.Items[0].ID != id || page.Items[0].Kind != "once" || page.Items[0].RunAt != 42 {
		t.Fatalf("once page = %+v", page)
	}
}

func TestFakeSelfServiceKeyQuota(t *testing.T) {
	f := runtimetest.NewServer(t)
	ctx := context.Background()
	op := operator(f)
	ten := newTenant(t, op, "acme", "free")
	ac := withKey(f, newKey(t, op, ten.ID, "keys:write", "services:read").Secret)

	var last runtime.KeyCreated
	for i := 0; i < 200; i++ {
		k, err := ac.CreateKey(ctx, runtime.KeyCreate{Scopes: []string{"services:read"}})
		must(t, err)
		last = k
	}
	_, err := ac.CreateKey(ctx, runtime.KeyCreate{Scopes: []string{"services:read"}})
	wantAPIErr(t, err, 403, "quota_exceeded")
	must(t, ac.RevokeKey(ctx, last.ID))
	_, err = ac.CreateKey(ctx, runtime.KeyCreate{Scopes: []string{"services:read"}})
	must(t, err)
}

func TestFakeProjects(t *testing.T) {
	f := runtimetest.NewServer(t)
	ctx := context.Background()
	op := operator(f)
	ten := newTenant(t, op, "acme", "free")
	cl := asTenant(f, ten.ID)

	def, err := cl.GetProject(ctx, "default")
	must(t, err)
	if len(def.Environments) != 1 || def.Environments[0] != "production" {
		t.Fatalf("default project %+v, want environments [production]", def)
	}

	web, err := cl.CreateProject(ctx, runtime.ProjectCreate{Slug: "web", Environments: []string{"staging", "production"}})
	must(t, err)
	_, err = cl.CreateProject(ctx, runtime.ProjectCreate{Slug: "web"})
	wantAPIErr(t, err, 409, "project_slug_taken")
	byID, err := cl.GetProject(ctx, web.ID)
	must(t, err)
	if byID.Slug != "web" {
		t.Fatalf("GetProject by id returned %q", byID.Slug)
	}
	envs, err := cl.GetProjectEnvironments(ctx, "web")
	must(t, err)
	if envs.Project != "web" || len(envs.Environments) != 2 {
		t.Fatalf("environments %+v", envs)
	}
	name := "Web"
	_, err = cl.UpdateProject(ctx, "web", runtime.ProjectPatch{Name: &name})
	must(t, err)

	site, err := cl.CreateService(ctx, runtime.ServiceCreate{Slug: "site", Runtime: "deno", Project: strp("web"), Environment: strp("staging")})
	must(t, err)
	if site.Project != "web" || site.Environment != "staging" {
		t.Fatalf("service placed in %s/%s", site.Project, site.Environment)
	}
	_, err = cl.CreateService(ctx, runtime.ServiceCreate{Slug: "dev1", Runtime: "deno", Project: strp("web"), Environment: strp("dev")})
	wantAPIErr(t, err, 422, "validation_failed")
	_, err = cl.CreateService(ctx, runtime.ServiceCreate{Slug: "dev2", Runtime: "deno", Project: strp("missing")})
	wantAPIErr(t, err, 422, "validation_failed")
	_, err = cl.PatchService(ctx, site.ID, runtime.ServicePatch{Environment: strp("dev")}, "")
	wantAPIErr(t, err, 422, "validation_failed")

	_, err = cl.UpdateProject(ctx, "web", runtime.ProjectPatch{Environments: []string{"production"}})
	wantAPIErr(t, err, 409, "environment_in_use")
	wantAPIErr(t, cl.DeleteProject(ctx, "web"), 409, "project_not_empty")

	_, err = cl.CreateProject(ctx, runtime.ProjectCreate{Slug: "tmp"})
	must(t, err)
	must(t, cl.DeleteProject(ctx, "tmp"))
	_, err = cl.GetProject(ctx, "tmp")
	wantAPIErr(t, err, 404, "not_found")
}

func TestFakeTenantAdmin(t *testing.T) {
	f := runtimetest.NewServer(t)
	ctx := context.Background()
	op := operator(f)
	ten := newTenant(t, op, "acme", "free")

	list, err := op.ListTenants(ctx, "")
	must(t, err)
	found := false
	for _, it := range list.Items {
		found = found || it.ID == ten.ID
	}
	if !found {
		t.Fatal("ListTenants misses the created tenant")
	}
	got, err := op.GetTenant(ctx, ten.ID)
	must(t, err)
	if got.Plan != "free" {
		t.Fatalf("GetTenant plan %q", got.Plan)
	}
	_, err = withKey(f, newKey(t, op, ten.ID, "services:read").Secret).GetTenant(ctx, ten.ID)
	wantAPIErr(t, err, 403, "insufficient_scope")

	f.SetPlan("tiny", runtimetest.FakePlan{MaxServices: 1, Triggers: []string{"http"}})
	cl := asTenant(f, ten.ID)
	_, err = cl.CreateService(ctx, runtime.ServiceCreate{Slug: "one", Runtime: "deno"})
	must(t, err)
	tiny := "tiny"
	patched, err := op.UpdateTenant(ctx, ten.ID, runtime.TenantPatch{Plan: &tiny})
	must(t, err)
	if patched.Plan != "tiny" {
		t.Fatalf("plan after PATCH %q", patched.Plan)
	}
	_, err = cl.CreateService(ctx, runtime.ServiceCreate{Slug: "two", Runtime: "deno"})
	wantAPIErr(t, err, 403, "quota_exceeded")

	bad := "nope"
	_, err = op.UpdateTenant(ctx, ten.ID, runtime.TenantPatch{Plan: &bad})
	wantAPIErr(t, err, 422, "validation_failed")
	off := true
	disabled, err := op.UpdateTenant(ctx, ten.ID, runtime.TenantPatch{Disabled: &off})
	must(t, err)
	if !disabled.Disabled {
		t.Fatal("disabled flag not stored")
	}

	plans, err := op.ListPlans(ctx)
	must(t, err)
	if len(plans) < 2 {
		t.Fatalf("ListPlans %d plans, want at least free and tiny", len(plans))
	}
	info, err := op.RuntimeVersion(ctx)
	must(t, err)
	if info.Version == "" || info.API == "" {
		t.Fatalf("version %+v", info)
	}
	limits, err := asTenant(f, ten.ID).Limits(ctx)
	must(t, err)
	if limits.Plan != "tiny" || limits.Services.Limit == nil || *limits.Services.Limit != 1 {
		t.Fatalf("limits %+v", limits)
	}
}

func TestFakeNodeAndStubRoutes(t *testing.T) {
	f := runtimetest.NewServer(t)
	ctx := context.Background()
	op := operator(f)
	ten := newTenant(t, op, "acme", "free")
	svc, err := asTenant(f, ten.ID).CreateService(ctx, runtime.ServiceCreate{Slug: "stub", Runtime: "deno"})
	must(t, err)
	up, err := asTenant(f, ten.ID).UploadVersion(ctx, svc.ID, strings.NewReader("export default 1"), "application/typescript", runtime.UploadOpts{})
	must(t, err)

	st, err := op.NodeStatus(ctx)
	must(t, err)
	if st.Mode != "normal" || st.Version == "" {
		t.Fatalf("node status %+v", st)
	}
	_, err = withKey(f, newKey(t, op, ten.ID, "services:read").Secret).NodeStatus(ctx)
	wantAPIErr(t, err, 403, "insufficient_scope")

	cfg, err := op.NodeConfig(ctx)
	must(t, err)
	if len(cfg) == 0 {
		t.Fatal("empty node config")
	}
	profile := "balanced"
	applied, err := op.PutNodeConfig(ctx, runtime.NodeConfigUpdate{DefaultProfile: &profile})
	must(t, err)
	if len(applied.Applied) != 1 || applied.Applied[0] != "default_profile" {
		t.Fatalf("applied %+v", applied)
	}
	for name, call := range map[string]func() (json.RawMessage, error){
		"scheduler": func() (json.RawMessage, error) { return op.NodeScheduler(ctx) },
		"cache":     func() (json.RawMessage, error) { return op.NodeCache(ctx) },
	} {
		raw, err := call()
		must(t, err)
		if len(raw) == 0 {
			t.Fatalf("node %s returned empty body", name)
		}
	}
	must(t, op.DrainNode(ctx))

	stats, err := asTenant(f, ten.ID).Stats(ctx, svc.ID, "5m")
	must(t, err)
	if len(stats) == 0 {
		t.Fatal("empty stats")
	}
	_, err = asTenant(f, ten.ID).Stats(ctx, svc.ID, "7d")
	wantAPIErr(t, err, 422, "validation_failed")

	rc, err := asTenant(f, ten.ID).ExportData(ctx, svc.ID)
	must(t, err)
	body, err := io.ReadAll(rc)
	must(t, err)
	must(t, rc.Close())
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil || len(zr.File) == 0 {
		t.Fatalf("data export is not a zip: %v", err)
	}

	logs, err := asTenant(f, ten.ID).BuildLogs(ctx, svc.ID, up.Version)
	must(t, err)
	lines, err := io.ReadAll(logs)
	must(t, err)
	must(t, logs.Close())
	if !strings.Contains(string(lines), "event: log") {
		t.Fatalf("build logs carry no events: %q", lines)
	}
	_, err = withKey(f, newKey(t, op, ten.ID, "services:read").Secret).BuildLogs(ctx, svc.ID, up.Version)
	wantAPIErr(t, err, 403, "insufficient_scope")
}

func TestFakeLazyBuildFailAndComplete(t *testing.T) {
	f := runtimetest.NewServer(t)
	ctx := context.Background()
	ten := newTenant(t, operator(f), "acme", "free")
	cl := asTenant(f, ten.ID)
	svc, err := cl.CreateService(ctx, runtime.ServiceCreate{Slug: "lazy", Runtime: "deno"})
	must(t, err)

	pending, err := cl.UploadVersion(ctx, svc.ID, strings.NewReader("a"), "application/typescript", runtime.UploadOpts{})
	must(t, err)
	if pending.BuildState != "pending" {
		t.Fatalf("lazy upload state %q, want pending", pending.BuildState)
	}
	f.FailBuild(svc.ID, json.RawMessage(`[{"message":"boom"}]`))
	failed, err := cl.GetVersion(ctx, svc.ID, pending.Version)
	must(t, err)
	if failed.BuildState != "failed" || !strings.Contains(string(failed.Failure.Diagnostics), "boom") {
		t.Fatalf("FailBuild left pending version %+v", failed)
	}

	// FailBuild also arms the next upload; it is consumed by that upload.
	armed, err := cl.UploadVersion(ctx, svc.ID, strings.NewReader("b"), "application/typescript", runtime.UploadOpts{Compile: "eager"})
	must(t, err)
	if armed.BuildState != "failed" {
		t.Fatalf("armed upload state %q, want failed", armed.BuildState)
	}
	next, err := cl.UploadVersion(ctx, svc.ID, strings.NewReader("c"), "application/typescript", runtime.UploadOpts{Compile: "eager"})
	must(t, err)
	if next.BuildState != "ready" {
		t.Fatalf("eager upload after arm consumed: state %q, want ready", next.BuildState)
	}

	lazy, err := cl.UploadVersion(ctx, svc.ID, strings.NewReader("d"), "application/typescript", runtime.UploadOpts{})
	must(t, err)
	f.CompleteBuild(svc.ID, lazy.Version)
	done, err := cl.GetVersion(ctx, svc.ID, lazy.Version)
	must(t, err)
	if done.BuildState != "ready" || done.LockDigest == nil {
		t.Fatalf("CompleteBuild left %+v", done)
	}
	_, err = cl.SetLive(ctx, svc.ID, lazy.Version, "")
	must(t, err)
}

func strp(s string) *string { return &s }

var _ = runtimetest.FakePlan{}
