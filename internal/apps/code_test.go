package apps

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/runtime"
	"github.com/21cloud/runtime-web/internal/store/db"
)

// saver is the org owner who uploads in these tests; it must exist as a user for version_authors.
func saver(f *fixture) authz.Subject {
	return authz.Subject{UserID: f.uid, OrgRole: authz.RoleOwner}
}

func editFiles(src string) Files {
	return Files{Entry: "main.ts", Files: map[string]string{"main.ts": src}, Kind: "ts"}
}

func TestFilesReturnsLiveSource(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.app(t, f.org.ID, "default", "production", "a1")
	got, err := f.svc.Files(ctx, owner, f.org.ID, "a1", 0)
	if err != nil {
		t.Fatalf("Files: %v", err)
	}
	if got.Entry != "main.ts" || !strings.Contains(got.Files["main.ts"], "fetch") || got.ReadOnly {
		t.Fatalf("live files = %+v", got)
	}
	if _, err := f.svc.Files(ctx, owner, f.org.ID, "a1", 9); !errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("missing version err = %v, want ErrNotFound", err)
	}
}

func TestSaveEagerThenLive(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	app := f.app(t, f.org.ID, "default", "production", "a1")
	v, err := f.svc.Save(ctx, saver(f), f.org.ID, "a1", editFiles("export default {};"), app.ETag)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if v.Version != 2 || !v.Live || v.ETag == "" {
		t.Fatalf("Save = %+v", v)
	}
	up, ok := f.rec.last(http.MethodPost, "/versions")
	if !ok || !strings.Contains(up.query, "compile=eager") || strings.Contains(up.query, "activate") {
		t.Fatalf("upload query = %q, want eager without activate", up.query)
	}
	if up.ctype != "application/json" {
		t.Fatalf("upload ctype = %q", up.ctype)
	}
	var body bundleBody
	if err := json.Unmarshal(up.body, &body); err != nil || body.Entry != "main.ts" || body.Files["main.ts"] != "export default {};" {
		t.Fatalf("upload body = %s (%v)", up.body, err)
	}
	live, ok := f.rec.last(http.MethodPut, "/live")
	if !ok || live.ifMatch != app.ETag {
		t.Fatalf("live request = %+v, want If-Match %q", live, app.ETag)
	}
	got, err := f.svc.Get(ctx, owner, f.org.ID, "a1")
	if err != nil || got.Raw.LiveVersion == nil || *got.Raw.LiveVersion != 2 {
		t.Fatalf("live after save = %v (%v)", got.Raw.LiveVersion, err)
	}
}

func TestSaveFailedBuildNotActivated(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	app := f.app(t, f.org.ID, "default", "production", "a1")
	f.fake.FailBuild(app.Raw.ID, json.RawMessage(`[{"file":"main.ts","line":1,"col":2,"message":"bad"}]`))
	_, err := f.svc.Save(ctx, saver(f), f.org.ID, "a1", editFiles("broken"), app.ETag)
	wantErr(t, err, apperr.ErrInvalid)
	var inv Invalid
	if !errors.As(err, &inv) || !strings.Contains(string(inv.Err.Details), `"message":"bad"`) {
		t.Fatalf("err = %v, want build diagnostics kept", err)
	}
	if _, ok := f.rec.last(http.MethodPut, "/live"); ok {
		t.Fatal("failed build was made live")
	}
	got, err := f.svc.Get(ctx, owner, f.org.ID, "a1")
	if err != nil || got.Raw.LiveVersion == nil || *got.Raw.LiveVersion != 1 {
		t.Fatalf("live after failed save = %v (%v)", got.Raw.LiveVersion, err)
	}
}

func TestSave422KeepsDetails(t *testing.T) {
	details := json.RawMessage(`{"diagnostics":[{"file":"main.ts","line":3,"col":1,"message":"x"}]}`)
	err := mapErr("upload", &runtime.Error{Status: http.StatusUnprocessableEntity, Code: "validation_failed", Message: "bad", Details: details})
	wantErr(t, err, apperr.ErrInvalid)
	var inv Invalid
	if !errors.As(err, &inv) || string(inv.Err.Details) != string(details) {
		t.Fatalf("details not passed through: %v", err)
	}
}

func TestSaveFilesStaleEtag409(t *testing.T) {
	f := newFixture(t)
	f.app(t, f.org.ID, "default", "production", "a1")
	_, err := f.svc.Save(context.Background(), saver(f), f.org.ID, "a1", editFiles("x"), `W/"stale"`)
	wantConflict(t, err, "stale")
}

func TestSaveRequiresEtag(t *testing.T) {
	f := newFixture(t)
	f.app(t, f.org.ID, "default", "production", "a1")
	_, err := f.svc.Save(context.Background(), saver(f), f.org.ID, "a1", editFiles("x"), "")
	wantErr(t, err, apperr.ErrPreconditionRequired)
}

func TestSaveRejectsBadBundle(t *testing.T) {
	f := newFixture(t)
	app := f.app(t, f.org.ID, "default", "production", "a1")
	bad := Files{Entry: "missing.ts", Files: map[string]string{"main.ts": "x"}}
	_, err := f.svc.Save(context.Background(), saver(f), f.org.ID, "a1", bad, app.ETag)
	wantErr(t, err, apperr.ErrInvalid)
	if _, ok := f.rec.last(http.MethodPost, "/versions"); !ok {
		t.Fatal("setup upload missing") // the template upload from f.app
	}
	if n := f.rec.count(http.MethodPost, "/versions"); n != 1 {
		t.Fatalf("bad bundle reached runtime: %d uploads", n)
	}
	_, err = f.svc.Save(context.Background(), saver(f), f.org.ID, "a1", Files{Entry: "main.ts", Files: map[string]string{"main.ts": "x"}, ReadOnly: true, Kind: "wasm"}, app.ETag)
	wantErr(t, err, apperr.ErrInvalid)
}

func TestVersionAuthorRecorded(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	app := f.app(t, f.org.ID, "default", "production", "a1")
	if _, err := f.svc.Save(ctx, saver(f), f.org.ID, "a1", editFiles("x"), app.ETag); err != nil {
		t.Fatalf("Save: %v", err)
	}
	a, err := f.st.Q().GetVersionAuthor(ctx, db.GetVersionAuthorParams{ServiceID: app.Raw.ID, Version: 2})
	if err != nil || a.UserID != f.uid {
		t.Fatalf("author row = %+v (%v)", a, err)
	}
	vs, err := f.svc.Versions(ctx, saver(f), f.org.ID, "a1")
	if err != nil {
		t.Fatalf("Versions: %v", err)
	}
	// Newest first: v2 (saved here, live) then v1 (made outside the web).
	if len(vs) != 2 || vs[0].Version != 2 || vs[1].Version != 1 {
		t.Fatalf("versions = %+v", vs)
	}
	if vs[0].Author == nil || vs[0].Author.UserID != f.uid || vs[0].Author.Name != "O" || vs[1].Author != nil {
		t.Fatalf("authors = %+v / %+v", vs[0].Author, vs[1].Author)
	}
	if !vs[0].Live || vs[1].Live {
		t.Fatalf("live flags = %v %v, want v2 live", vs[0].Live, vs[1].Live)
	}
}

func TestViewerCannotSave(t *testing.T) {
	f := newFixture(t)
	app := f.app(t, f.org.ID, "default", "production", "a1")
	_, err := f.svc.Save(context.Background(), viewerSub(f), f.org.ID, "a1", editFiles("x"), app.ETag)
	wantErr(t, err, apperr.ErrForbidden)
	if n := f.rec.count(http.MethodPost, "/versions"); n != 1 {
		t.Fatalf("viewer save reached runtime: %d uploads", n)
	}
}

func TestRebuildFailedVersion(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	app := f.app(t, f.org.ID, "default", "production", "a1")
	f.fake.FailBuild(app.Raw.ID, json.RawMessage(`[]`))
	if _, err := f.svc.Save(ctx, saver(f), f.org.ID, "a1", editFiles("x"), app.ETag); !errors.Is(err, apperr.ErrInvalid) {
		t.Fatalf("Save: %v", err)
	}
	v, err := f.svc.Rebuild(ctx, saver(f), f.org.ID, "a1", 2)
	if err != nil {
		t.Fatalf("Rebuild: %v", err)
	}
	if v.Version != 2 || v.BuildState != "building" {
		t.Fatalf("Rebuild = %+v, want building v2", v)
	}
	if _, ok := f.rec.last(http.MethodPost, "/rebuild"); !ok {
		t.Fatal("no rebuild request")
	}
	if _, err := f.svc.Rebuild(ctx, viewerSub(f), f.org.ID, "a1", 2); !errors.Is(err, apperr.ErrForbidden) {
		t.Fatalf("viewer rebuild err = %v, want ErrForbidden", err)
	}
}

// viewerSub is an org member with a viewer grant on project default: it can read apps but not deploy.
func viewerSub(f *fixture) authz.Subject {
	return authz.Subject{UserID: f.uid, OrgRole: authz.RoleMember, ProjectRoles: map[string]string{"default": authz.RoleViewer}}
}

func TestPromoteRollsBack(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	app := f.app(t, f.org.ID, "default", "production", "a1")
	v2, err := f.svc.Save(ctx, saver(f), f.org.ID, "a1", editFiles("two"), app.ETag)
	if err != nil {
		t.Fatalf("Save v2: %v", err)
	}
	back, err := f.svc.Promote(ctx, saver(f), f.org.ID, "a1", 1, v2.ETag)
	if err != nil {
		t.Fatalf("Promote v1: %v", err)
	}
	if back.Version != 1 || !back.Live || back.ETag == "" {
		t.Fatalf("Promote = %+v", back)
	}
	cur, err := f.svc.Get(ctx, owner, f.org.ID, "a1")
	if err != nil || *cur.Raw.LiveVersion != 1 {
		t.Fatalf("live after rollback = %v (%v)", cur.Raw.LiveVersion, err)
	}
	// A failed build cannot be promoted; live stays on v1.
	f.fake.FailBuild(app.Raw.ID, json.RawMessage(`[]`))
	if _, err := f.svc.Save(ctx, saver(f), f.org.ID, "a1", editFiles("bad"), back.ETag); !errors.Is(err, apperr.ErrInvalid) {
		t.Fatalf("Save bad: %v", err)
	}
	_, err = f.svc.Promote(ctx, saver(f), f.org.ID, "a1", 3, back.ETag)
	if code, ok := apperr.ConflictCode(err); !ok || code != "version_not_ready" {
		t.Fatalf("promote failed v3 err = %v, want version_not_ready", err)
	}
	cur, _ = f.svc.Get(ctx, owner, f.org.ID, "a1")
	if *cur.Raw.LiveVersion != 1 {
		t.Fatalf("live moved to %d after refused promote", *cur.Raw.LiveVersion)
	}
	if _, err := f.svc.Promote(ctx, saver(f), f.org.ID, "a1", 1, ""); !errors.Is(err, apperr.ErrPreconditionRequired) {
		t.Fatalf("promote without etag err = %v", err)
	}
}

func TestBuildLogsParsesSSE(t *testing.T) {
	f := newFixture(t)
	app := f.app(t, f.org.ID, "default", "production", "a1")
	lines, err := f.svc.BuildLogs(context.Background(), owner, f.org.ID, "a1", 1)
	if err != nil {
		t.Fatalf("BuildLogs: %v", err)
	}
	if len(lines) != 3 || lines[0].Msg != "resolving dependencies" || lines[0].Seq != 1 || lines[2].Level != "info" {
		t.Fatalf("lines = %+v (svc %s)", lines, app.Raw.ID)
	}
}

func TestTemplatesUseStdOnly(t *testing.T) {
	imp := regexp.MustCompile(`from "([^"]+)"`)
	for name, src := range templates {
		if strings.Contains(src, "rt:") {
			t.Errorf("template %s imports rt:*", name)
		}
		if strings.Contains(src, `"val"`) {
			t.Errorf("template %s contains val", name)
		}
		for _, m := range imp.FindAllStringSubmatch(src, -1) {
			if !strings.HasPrefix(m[1], "std:") {
				t.Errorf("template %s imports %q, want std:*", name, m[1])
			}
		}
	}
}

// count returns how many recorded requests match method and path suffix.
func (r *recorder) count(method, pathSuffix string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, q := range r.reqs {
		if q.method == method && strings.HasSuffix(q.path, pathSuffix) {
			n++
		}
	}
	return n
}

func TestAwaitBuildTimeoutIs409(t *testing.T) {
	// A build that never leaves "building" must end as build_timeout (409), not hang.
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":2,"build_state":"building"}`))
	}))
	t.Cleanup(stub.Close)
	f := newFixture(t)
	ctx := context.Background()
	cred, err := f.svc.creds.DefaultCred(ctx, f.org.ID)
	if err != nil {
		t.Fatalf("DefaultCred: %v", err)
	}
	cli := runtime.New(stub.URL, stub.Client()).With(cred)

	oldTimeout, oldPoll := buildTimeout, pollInterval
	buildTimeout, pollInterval = 50*time.Millisecond, time.Millisecond
	t.Cleanup(func() { buildTimeout, pollInterval = oldTimeout, oldPoll })

	_, err = f.svc.awaitBuild(ctx, cli, "svc_x", runtime.Version{Version: 2, BuildState: "building"})
	wantConflict(t, err, "build_timeout")
}
