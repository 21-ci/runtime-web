package runtimetest_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/21cloud/runtime-web/internal/runtime"
	"github.com/21cloud/runtime-web/internal/runtime/runtimetest"
)

func TestFakeSlugGlobal(t *testing.T) {
	f := runtimetest.NewServer(t)
	ctx := context.Background()
	op := operator(f)
	a := newTenant(t, op, "a", "free")
	b := newTenant(t, op, "b", "free")

	shopA, err := asTenant(f, a.ID).CreateService(ctx, runtime.ServiceCreate{Slug: "shop", Runtime: "deno"})
	must(t, err)
	_, err = asTenant(f, b.ID).CreateService(ctx, runtime.ServiceCreate{Slug: "shop", Runtime: "deno"})
	wantAPIErr(t, err, 409, "slug_taken")

	_, err = asTenant(f, a.ID).CreateService(ctx, runtime.ServiceCreate{Slug: "Bad_Slug", Runtime: "deno"})
	wantAPIErr(t, err, 422, "validation_failed")

	must(t, asTenant(f, a.ID).DeleteService(ctx, shopA.ID, false))
	_, err = asTenant(f, b.ID).CreateService(ctx, runtime.ServiceCreate{Slug: "shop", Runtime: "deno"})
	must(t, err) // a deleted slug is free again
}

func TestFakeSourceRoundTrip(t *testing.T) {
	f := runtimetest.NewServer(t)
	ctx := context.Background()
	ten := newTenant(t, operator(f), "acme", "free")
	cl := asTenant(f, ten.ID)
	svc, err := cl.CreateService(ctx, runtime.ServiceCreate{Slug: "src", Runtime: "deno"})
	must(t, err)

	tests := []struct {
		name  string
		ctype string
		body  []byte
	}{
		{"typescript", "application/typescript", []byte("export default () => new Response(\"héllo\")\n")},
		{"json bundle", "application/json", []byte(`{"entry":"main.ts","files":{"main.ts":"export default 1"}}`)},
	}
	for i, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			v, err := cl.UploadVersion(ctx, svc.ID, bytes.NewReader(tt.body), tt.ctype, runtime.UploadOpts{Activate: true, Compile: "lazy"})
			must(t, err)
			if v.Version != i+1 {
				t.Fatalf("version %d, want %d", v.Version, i+1)
			}
			got, ctype, err := cl.VersionSource(ctx, svc.ID, v.Version)
			must(t, err)
			if !bytes.Equal(got, tt.body) {
				t.Fatalf("source %q, want %q", got, tt.body)
			}
			if ctype != tt.ctype {
				t.Fatalf("content type %q, want %q", ctype, tt.ctype)
			}
		})
	}

	live, _, err := cl.GetService(ctx, svc.ID)
	must(t, err)
	if live.LiveVersion == nil || *live.LiveVersion != 2 {
		t.Fatalf("live version %v, want 2", live.LiveVersion)
	}
	versions, err := cl.ListVersions(ctx, svc.ID)
	must(t, err)
	if len(versions) != 2 {
		t.Fatalf("%d versions, want 2", len(versions))
	}
}

func TestFakeEagerBuildStates(t *testing.T) {
	f := runtimetest.NewServer(t)
	ctx := context.Background()
	ten := newTenant(t, operator(f), "acme", "free")
	cl := asTenant(f, ten.ID)
	svc, err := cl.CreateService(ctx, runtime.ServiceCreate{Slug: "eager", Runtime: "deno"})
	must(t, err)
	eager := runtime.UploadOpts{Compile: "eager"}

	ok, err := cl.UploadVersion(ctx, svc.ID, strings.NewReader("export default 1"), "application/typescript", eager)
	must(t, err)
	if ok.BuildState != "ready" || ok.Failure != nil {
		t.Fatalf("eager upload %+v, want ready immediately", ok)
	}

	f.FailBuild(svc.ID, json.RawMessage(`[{"file":"main.ts","line":1,"col":8,"message":"unexpected token"}]`))
	bad, err := cl.UploadVersion(ctx, svc.ID, strings.NewReader("export default {"), "application/typescript", eager)
	must(t, err)
	if bad.BuildState != "failed" {
		t.Fatalf("armed eager upload state %q, want failed", bad.BuildState)
	}
	failed, err := cl.GetVersion(ctx, svc.ID, bad.Version)
	must(t, err)
	if failed.BuildState != "failed" || failed.Failure == nil || failed.Failure.Reason != "syntax" {
		t.Fatalf("settled %+v, want failed with reason syntax", failed)
	}
	if !strings.Contains(string(failed.Failure.Diagnostics), "unexpected token") {
		t.Fatalf("diagnostics %s lack the compiler message", failed.Failure.Diagnostics)
	}

	_, err = cl.SetLive(ctx, svc.ID, bad.Version, "")
	wantAPIErr(t, err, 409, "version_not_ready")

	rebuilt, err := cl.Rebuild(ctx, svc.ID, bad.Version)
	must(t, err)
	if rebuilt.BuildState != "building" || rebuilt.Failure != nil {
		t.Fatalf("rebuild %+v, want building with no failure", rebuilt)
	}
	again, err := cl.GetVersion(ctx, svc.ID, bad.Version)
	must(t, err)
	if again.BuildState != "ready" {
		t.Fatalf("rebuilt state %q, want ready", again.BuildState)
	}
	_, err = cl.SetLive(ctx, svc.ID, bad.Version, "")
	must(t, err)
}

func TestFakeIfMatch(t *testing.T) {
	f := runtimetest.NewServer(t)
	ctx := context.Background()
	ten := newTenant(t, operator(f), "acme", "free")
	cl := asTenant(f, ten.ID)
	svc, err := cl.CreateService(ctx, runtime.ServiceCreate{Slug: "etag", Runtime: "deno"})
	must(t, err)
	ver, err := cl.UploadVersion(ctx, svc.ID, strings.NewReader("export default 1"), "application/typescript", runtime.UploadOpts{})
	must(t, err)

	_, e1, err := cl.GetService(ctx, svc.ID)
	must(t, err)
	name := "renamed"
	_, err = cl.PatchService(ctx, svc.ID, runtime.ServicePatch{Name: &name}, e1)
	must(t, err)
	_, e2, err := cl.GetService(ctx, svc.ID)
	must(t, err)
	if e2 == e1 {
		t.Fatalf("etag did not change after patch: %s", e2)
	}

	_, err = cl.PatchService(ctx, svc.ID, runtime.ServicePatch{Name: &name}, e1)
	wantAPIErr(t, err, 412, "precondition_failed")
	_, err = cl.SetLive(ctx, svc.ID, ver.Version, e1)
	wantAPIErr(t, err, 412, "precondition_failed")

	_, err = cl.SetLive(ctx, svc.ID, ver.Version, e2)
	must(t, err)
	_, e3, err := cl.GetService(ctx, svc.ID)
	must(t, err)
	_, err = cl.SetLive(ctx, svc.ID, ver.Version, e2)
	wantAPIErr(t, err, 412, "precondition_failed")
	_, err = cl.SetLive(ctx, svc.ID, ver.Version, e3)
	must(t, err)
}

func TestFakeSSELimitAndResume(t *testing.T) {
	f := runtimetest.NewServer(t)
	f.SSELimit = 2
	op := operator(f)
	ten := newTenant(t, op, "acme", "free")
	svc, err := asTenant(f, ten.ID).CreateService(context.Background(), runtime.ServiceCreate{Slug: "logs", Runtime: "deno"})
	must(t, err)
	key := newKey(t, op, ten.ID, "logs:read")
	cl := withKey(f, key.Secret)

	for _, line := range []string{"one", "two", "three"} {
		f.EmitLog(svc.ID, line)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	first, err := cl.StreamLogs(ctx, svc.ID, "")
	must(t, err)
	defer first.Close()
	wantLogs(t, readLogs(t, first, 3), []logLine{{1, "one"}, {2, "two"}, {3, "three"}})

	resumed, err := cl.StreamLogs(ctx, svc.ID, "1")
	must(t, err)
	defer resumed.Close()
	wantLogs(t, readLogs(t, resumed, 2), []logLine{{2, "two"}, {3, "three"}})
	f.EmitLog(svc.ID, "four")
	wantLogs(t, readLogs(t, resumed, 1), []logLine{{4, "four"}})

	if n := f.OpenStreams(key.ID); n != 2 {
		t.Fatalf("open streams %d, want 2", n)
	}
	_, err = cl.StreamLogs(ctx, svc.ID, "")
	wantAPIErr(t, err, 429, "rate_limited")
	if !runtime.IsThrottled(err) {
		t.Fatalf("IsThrottled(%v) = false", err)
	}

	must(t, first.Close())
	waitFor(t, func() bool { return f.OpenStreams(key.ID) == 1 })
	third, err := cl.StreamLogs(ctx, svc.ID, "")
	must(t, err)
	must(t, third.Close())
}

func TestFakeHosts(t *testing.T) {
	f := runtimetest.NewServer(t)
	ctx := context.Background()
	op := operator(f)
	a := newTenant(t, op, "a", "free")
	b := newTenant(t, op, "b", "free")
	svcA, err := asTenant(f, a.ID).CreateService(ctx, runtime.ServiceCreate{Slug: "web", Runtime: "deno"})
	must(t, err)
	svcB, err := asTenant(f, b.ID).CreateService(ctx, runtime.ServiceCreate{Slug: "other", Runtime: "deno"})
	must(t, err)
	// Tenant claims need a tenant key; the operator token would make them active.
	keyA := withKey(f, newKey(t, op, a.ID, "services:write").Secret)
	keyB := withKey(f, newKey(t, op, b.ID, "services:write").Secret)

	active, err := keyA.PutHost(ctx, svcA.ID, "Shop.Example.com.")
	must(t, err)
	if active.Host != "shop.example.com" || active.Status != "pending_verification" || active.VerifyToken == nil {
		t.Fatalf("tenant claim %+v, want pending host with token", active)
	}
	again, err := keyA.PutHost(ctx, svcA.ID, "shop.example.com")
	must(t, err)
	if again.VerifyToken == nil || *again.VerifyToken != *active.VerifyToken {
		t.Fatal("re-PUT of own pending claim changed the token")
	}

	_, err = keyB.PutHost(ctx, svcB.ID, "shop.example.com")
	wantAPIErr(t, err, 409, "host_taken")

	op1, err := op.PutHost(ctx, svcA.ID, "api.example.com")
	must(t, err)
	if op1.Status != "active" || op1.VerifyToken != nil {
		t.Fatalf("operator claim %+v, want active with no token", op1)
	}
	hosts, err := asTenant(f, a.ID).ListHosts(ctx, svcA.ID)
	must(t, err)
	if len(hosts) != 2 {
		t.Fatalf("%d hosts, want 2", len(hosts))
	}

	_, err = keyB.PutHost(ctx, svcB.ID, "api.example.com")
	wantAPIErr(t, err, 409, "host_taken")
	wantAPIErr(t, asTenant(f, b.ID).DeleteHost(ctx, svcA.ID, "api.example.com"), 404, "not_found")
	must(t, keyA.DeleteHost(ctx, svcA.ID, "shop.example.com"))
	_, err = keyB.PutHost(ctx, svcB.ID, "shop.example.com")
	must(t, err) // a deleted claim frees the host
}

func TestFakeEnvSecretsSchedules(t *testing.T) {
	f := runtimetest.NewServer(t)
	ctx := context.Background()
	op := operator(f)
	f.SetPlan("tiny", runtimetest.FakePlan{MaxServices: 5, MaxSchedules: 1, Triggers: []string{"interval"}})
	ten := newTenant(t, op, "acme", "tiny")
	cl := asTenant(f, ten.ID)
	svc, err := cl.CreateService(ctx, runtime.ServiceCreate{Slug: "jobs", Runtime: "deno"})
	must(t, err)

	env, err := cl.PutEnv(ctx, svc.ID, map[string]string{"A": "1", "B": "2"})
	must(t, err)
	if env["B"] != "2" || len(env) != 2 {
		t.Fatalf("PutEnv returned %v", env)
	}
	got, err := cl.GetEnv(ctx, svc.ID)
	must(t, err)
	if len(got) != 2 || got["A"] != "1" {
		t.Fatalf("GetEnv %v, want A and B", got)
	}
	_, err = cl.PutEnv(ctx, svc.ID, map[string]string{"C": "3"})
	must(t, err)
	got, err = cl.GetEnv(ctx, svc.ID)
	must(t, err)
	if len(got) != 1 || got["C"] != "3" {
		t.Fatalf("PUT env replaces the whole map, got %v", got)
	}

	must(t, cl.PutSecret(ctx, svc.ID, "API_TOKEN", "s3cret"))
	wantAPIErr(t, cl.PutSecret(ctx, svc.ID, "RT_INTERNAL", "x"), 422, "validation_failed")
	names, err := cl.ListSecrets(ctx, svc.ID)
	must(t, err)
	if len(names) != 1 || names[0].Name != "API_TOKEN" {
		t.Fatalf("ListSecrets %+v, want API_TOKEN only", names)
	}
	must(t, cl.DeleteSecret(ctx, svc.ID, "API_TOKEN"))
	wantAPIErr(t, cl.DeleteSecret(ctx, svc.ID, "API_TOKEN"), 404, "not_found")

	every := int64(300)
	sch, err := cl.CreateSchedule(ctx, svc.ID, runtime.ScheduleBody{Kind: "interval", EverySeconds: &every})
	must(t, err)
	if !sch.Enabled || sch.NextDue == nil {
		t.Fatalf("schedule %+v, want enabled with next_due", sch)
	}
	_, err = cl.CreateSchedule(ctx, svc.ID, runtime.ScheduleBody{Kind: "interval", EverySeconds: &every})
	wantAPIErr(t, err, 403, "quota_exceeded")
	disabled := false
	_, err = cl.UpdateSchedule(ctx, svc.ID, sch.ID, runtime.ScheduleBody{Kind: "interval", EverySeconds: &every, Enabled: &disabled})
	must(t, err)
	list, err := cl.ListSchedules(ctx, svc.ID)
	must(t, err)
	if len(list) != 1 || list[0].Enabled {
		t.Fatalf("schedules %+v, want one disabled", list)
	}
	must(t, cl.DeleteSchedule(ctx, svc.ID, sch.ID))

	short := int64(10)
	_, err = cl.CreateSchedule(ctx, svc.ID, runtime.ScheduleBody{Kind: "interval", EverySeconds: &short})
	wantAPIErr(t, err, 422, "schedule_too_frequent")
	cron := "*/5 * * * *"
	_, err = cl.CreateSchedule(ctx, svc.ID, runtime.ScheduleBody{Kind: "cron", Cron: &cron})
	wantAPIErr(t, err, 403, "trigger_not_allowed")
}

func TestFakeQueueAndDLQ(t *testing.T) {
	f := runtimetest.NewServer(t)
	ctx := context.Background()
	op := operator(f)
	ten := newTenant(t, op, "acme", "free")
	cl := asTenant(f, ten.ID)
	svc, err := cl.CreateService(ctx, runtime.ServiceCreate{Slug: "worker", Runtime: "deno"})
	must(t, err)

	dedup := "order-1"
	first, err := cl.Enqueue(ctx, svc.ID, runtime.EnqueueBody{Body: json.RawMessage(`{"n":1}`), DedupID: &dedup})
	must(t, err)
	second, err := cl.Enqueue(ctx, svc.ID, runtime.EnqueueBody{Body: json.RawMessage(`{"n":1}`), DedupID: &dedup})
	must(t, err)
	if second.ID != first.ID {
		t.Fatalf("dedup id produced a second message: %s vs %s", second.ID, first.ID)
	}
	_, err = cl.Enqueue(ctx, svc.ID, runtime.EnqueueBody{Body: json.RawMessage(`{"n":2}`)})
	must(t, err)

	stats, err := cl.QueueStats(ctx, svc.ID)
	must(t, err)
	if stats.Depth != 2 || stats.DLQ != 0 {
		t.Fatalf("stats %+v, want depth 2 and empty DLQ", stats)
	}

	f.DeadLetter(svc.ID, json.RawMessage(`{"n":3}`))
	dlq, err := cl.ListDLQ(ctx, svc.ID)
	must(t, err)
	if len(dlq.Items) != 1 || string(dlq.Items[0].Body) != `{"n":3}` {
		t.Fatalf("DLQ %+v, want one item", dlq.Items)
	}
	redriven, err := cl.RedriveDLQ(ctx, svc.ID)
	must(t, err)
	if redriven.Redriven != 1 {
		t.Fatalf("redriven %d, want 1", redriven.Redriven)
	}
	stats, err = cl.QueueStats(ctx, svc.ID)
	must(t, err)
	if stats.Depth != 3 || stats.DLQ != 0 {
		t.Fatalf("after redrive %+v, want depth 3", stats)
	}

	f.DeadLetter(svc.ID, json.RawMessage(`{"n":4}`))
	must(t, cl.PurgeDLQ(ctx, svc.ID))
	dlq, err = cl.ListDLQ(ctx, svc.ID)
	must(t, err)
	if len(dlq.Items) != 0 {
		t.Fatalf("purge left %d items", len(dlq.Items))
	}
}

func TestFakeEvents(t *testing.T) {
	f := runtimetest.NewServer(t)
	ctx := context.Background()
	ten := newTenant(t, operator(f), "acme", "free")
	cl := asTenant(f, ten.ID)
	svc, err := cl.CreateService(ctx, runtime.ServiceCreate{Slug: "audit", Runtime: "deno"})
	must(t, err)
	ver, err := cl.UploadVersion(ctx, svc.ID, strings.NewReader("export default 1"), "application/typescript", runtime.UploadOpts{})
	must(t, err)
	_, e, err := cl.GetService(ctx, svc.ID)
	must(t, err)
	_, err = cl.SetLive(ctx, svc.ID, ver.Version, e)
	must(t, err)

	page, err := cl.Events(ctx, svc.ID, "")
	must(t, err)
	var kinds []string
	for _, ev := range page.Items {
		kinds = append(kinds, ev.Kind)
	}
	if !slices.Contains(kinds, "service.created") || !slices.Contains(kinds, "deploy") {
		t.Fatalf("event kinds %v, want service.created and deploy", kinds)
	}
}

type logLine struct {
	seq int64
	msg string
}

// readLogs reads n SSE log events from r, failing the test if fewer arrive.
func readLogs(t *testing.T, r io.Reader, n int) []logLine {
	t.Helper()
	var out []logLine
	sc := bufio.NewScanner(r)
	for len(out) < n && sc.Scan() {
		data, ok := strings.CutPrefix(sc.Text(), "data: ")
		if !ok {
			continue
		}
		var rec struct {
			Seq int64  `json:"seq"`
			Msg string `json:"msg"`
		}
		if err := json.Unmarshal([]byte(data), &rec); err != nil {
			t.Fatalf("decode log event %q: %v", data, err)
		}
		out = append(out, logLine{seq: rec.Seq, msg: rec.Msg})
	}
	if len(out) != n {
		t.Fatalf("read %d log events, want %d (%v)", len(out), n, sc.Err())
	}
	return out
}

func wantLogs(t *testing.T, got, want []logLine) {
	t.Helper()
	if !slices.Equal(got, want) {
		t.Fatalf("logs %v, want %v", got, want)
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not reached within 2s")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
