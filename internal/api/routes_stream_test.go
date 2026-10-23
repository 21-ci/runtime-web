package api

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/21cloud/runtime-web/internal/apps"
	"github.com/21cloud/runtime-web/internal/audit"
	"github.com/21cloud/runtime-web/internal/authz"
)

// sseEvent is one block of an SSE stream.
type sseEvent struct {
	id, event, data, comment string
}

// readSSE reads the next block of an event stream, failing the test on a read error.
func readSSE(t *testing.T, r *bufio.Reader) sseEvent {
	t.Helper()
	var ev sseEvent
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			t.Fatalf("read sse: %v (partial %+v)", err, ev)
		}
		line = strings.TrimRight(line, "\r\n")
		switch {
		case line == "":
			return ev
		case strings.HasPrefix(line, ":"):
			ev.comment = strings.TrimSpace(line[1:])
		case strings.HasPrefix(line, "id: "):
			ev.id = line[4:]
		case strings.HasPrefix(line, "event: "):
			ev.event = line[7:]
		case strings.HasPrefix(line, "data: "):
			ev.data = line[6:]
		}
	}
}

// streamEnv returns a test env with one app ("web") in org "acme", a real HTTP server for it with a
// 1 s write timeout (production sets none on SSE routes), and the owner's session cookie.
func streamEnv(t *testing.T) (*testEnv, *httptest.Server, string, string) {
	t.Helper()
	e := newTestEnv(t)
	ownerID := e.mkUser("owner@example.com", testPassword)
	org := e.mkOrg("acme", ownerID)
	cookie, _ := e.session("owner@example.com")
	ctx := context.Background()
	sub, err := e.orgs.Subject(ctx, ownerID, org.ID)
	if err != nil {
		t.Fatalf("Subject: %v", err)
	}
	v, err := e.appSvc.Create(ctx, sub, org.ID, "default", "production", "web", "http")
	if err != nil {
		t.Fatalf("Create app: %v", err)
	}
	ts := httptest.NewUnstartedServer(e.srv)
	ts.Config.WriteTimeout = time.Second
	ts.Start()
	t.Cleanup(ts.Close)
	return e, ts, cookie, v.Raw.ID
}

// openLogs opens the app's log stream over HTTP. The body closes at the end of t.
func openLogs(t *testing.T, ts *httptest.Server, cookie, query, lastID string) *http.Response {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/api/orgs/acme/apps/web/logs"+query, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Accept", "text/event-stream")
	req.AddCookie(&http.Cookie{Name: "rtw_session", Value: cookie})
	if lastID != "" {
		req.Header.Set("Last-Event-ID", lastID)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET logs: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

func TestLogsSSEResume(t *testing.T) {
	e, ts, cookie, svc := streamEnv(t)
	for _, msg := range []string{"one", "two", "three"} {
		e.fake.EmitLog(svc, msg)
	}
	resp := openLogs(t, ts, cookie, "", "")
	if got := resp.Header.Get("Content-Type"); got != "text/event-stream" {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := resp.Header.Get("Cache-Control"); got != "no-cache" {
		t.Errorf("Cache-Control = %q", got)
	}
	if got := resp.Header.Get("X-Accel-Buffering"); got != "no" {
		t.Errorf("X-Accel-Buffering = %q", got)
	}
	r := bufio.NewReader(resp.Body)
	first := readSSE(t, r)
	second := readSSE(t, r)
	if first.event != "log" || !strings.Contains(first.data, `"msg":"one"`) {
		t.Fatalf("first event = %+v", first)
	}
	if !strings.Contains(second.data, `"msg":"two"`) {
		t.Fatalf("second event = %+v", second)
	}
	_ = resp.Body.Close()

	// Reconnect with the id of the first event: the stream resumes at the second one.
	resp = openLogs(t, ts, cookie, "", first.id)
	resumed := readSSE(t, bufio.NewReader(resp.Body))
	if resumed.id != second.id || !strings.Contains(resumed.data, `"msg":"two"`) {
		t.Fatalf("resumed event = %+v, want id %s", resumed, second.id)
	}
}

func TestLogsNoWriteDeadline(t *testing.T) {
	e, ts, cookie, svc := streamEnv(t)
	resp := openLogs(t, ts, cookie, "", "")
	r := bufio.NewReader(resp.Body)
	e.fake.EmitLog(svc, "warm")
	_ = readSSE(t, r)
	// The server write timeout is 1 s; the stream must still deliver after 3 s.
	time.Sleep(3 * time.Second)
	e.fake.EmitLog(svc, "late")
	if got := readSSE(t, r); !strings.Contains(got.data, `"msg":"late"`) {
		t.Fatalf("event after 3 s = %+v", got)
	}
}

func TestLogsHeartbeat(t *testing.T) {
	e, ts, cookie, _ := streamEnv(t)
	e.srv.sseHeartbeat = 20 * time.Millisecond
	resp := openLogs(t, ts, cookie, "", "")
	if ev := readSSE(t, bufio.NewReader(resp.Body)); ev.comment != "ping" {
		t.Fatalf("heartbeat = %+v, want comment ping", ev)
	}
}

func TestLogsLevelParam(t *testing.T) {
	_, ts, cookie, _ := streamEnv(t)
	resp := openLogs(t, ts, cookie, "?level=loud", "")
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", resp.StatusCode)
	}
}

func TestLevelAtLeast(t *testing.T) {
	tests := []struct {
		name  string
		event string
		data  string
		min   string
		want  bool
	}{
		{"no filter", "log", `{"level":"debug"}`, "", true},
		{"below minimum", "log", `{"level":"info"}`, "warn", false},
		{"at minimum", "log", `{"level":"warn"}`, "warn", true},
		{"above minimum", "log", `{"level":"error"}`, "info", true},
		{"gap always passes", "gap", `{"from":5}`, "error", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ev := apps.LogEvent{Event: tt.event, Data: json.RawMessage(tt.data)}
			if got := keepLevel(ev, tt.min); got != tt.want {
				t.Fatalf("keepLevel = %v, want %v", got, tt.want)
			}
		})
	}
}

// TestAppRouteGrants: a member with only a grant on project a sees apps in a and gets 404 for apps in b.
// Export follows authz: a viewer is forbidden, an admin allowed.
func TestAppRouteGrants(t *testing.T) {
	e := newTestEnv(t)
	ownerID := e.mkUser("owner@example.com", testPassword)
	org := e.mkOrg("acme", ownerID)
	ctx := context.Background()
	owner, err := e.orgs.Subject(ctx, ownerID, org.ID)
	if err != nil {
		t.Fatalf("Subject: %v", err)
	}
	for _, p := range []string{"alpha", "beta"} {
		if _, err := e.appSvc.CreateProject(ctx, owner, org.ID, p, "", []string{"production"}); err != nil {
			t.Fatalf("CreateProject %s: %v", p, err)
		}
		if _, err := e.appSvc.Create(ctx, owner, org.ID, p, "production", "app-"+p, "http"); err != nil {
			t.Fatalf("Create app-%s: %v", p, err)
		}
	}
	viewerID := e.mkUser("viewer@example.com", testPassword)
	adminID := e.mkUser("admin@example.com", testPassword)
	e.addMember(org.ID, viewerID, "member")
	e.addMember(org.ID, adminID, "member")
	setter := authz.Subject{InstanceAdmin: true}
	if err := e.orgs.SetGrant(ctx, audit.Actor{UserID: "cli"}, setter, org.ID, viewerID, "alpha", authz.RoleViewer); err != nil {
		t.Fatalf("SetGrant viewer: %v", err)
	}
	if err := e.orgs.SetGrant(ctx, audit.Actor{UserID: "cli"}, setter, org.ID, adminID, "alpha", authz.RoleAdmin); err != nil {
		t.Fatalf("SetGrant admin: %v", err)
	}
	viewerCookie, _ := e.session("viewer@example.com")
	adminCookie, _ := e.session("admin@example.com")
	ts := httptest.NewServer(e.srv)
	t.Cleanup(ts.Close)

	tests := []struct {
		name   string
		path   string
		cookie string
		want   int
	}{
		{"viewer streams logs of app in a", "/api/orgs/acme/apps/app-alpha/logs", viewerCookie, http.StatusOK},
		{"viewer gets 404 for app in b", "/api/orgs/acme/apps/app-beta/logs", viewerCookie, http.StatusNotFound},
		{"viewer export forbidden", "/api/orgs/acme/apps/app-alpha/export", viewerCookie, http.StatusForbidden},
		{"admin export allowed", "/api/orgs/acme/apps/app-alpha/export", adminCookie, http.StatusOK},
		{"admin gets 404 for app in b", "/api/orgs/acme/apps/app-beta/export", adminCookie, http.StatusNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if strings.HasSuffix(tt.path, "/logs") {
				if got := streamStatus(t, ts, tt.cookie, tt.path); got != tt.want {
					t.Fatalf("status = %d, want %d", got, tt.want)
				}
				return
			}
			rec := e.send(http.MethodGet, tt.path, nil, withCookie(tt.cookie))
			if rec.Code != tt.want {
				t.Fatalf("status = %d, want %d; body %s", rec.Code, tt.want, rec.Body.String())
			}
		})
	}
}

// streamStatus returns the status of a stream request, then drops the connection.
func streamStatus(t *testing.T, ts *httptest.Server, cookie, path string) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+path, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Accept", "text/event-stream")
	req.AddCookie(&http.Cookie{Name: "rtw_session", Value: cookie})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}

func TestLogsAfterHubClosed(t *testing.T) {
	e, ts, cookie, _ := streamEnv(t)
	e.logs.Close()
	resp := openLogs(t, ts, cookie, "", "")
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status after hub close = %d, want 503", resp.StatusCode)
	}
}

func TestExportFilename(t *testing.T) {
	tests := []struct{ app, want string }{
		{"web", "web.sqlite"},
		{"my-app-2", "my-app-2.sqlite"},
		{`we"b;x`, "webx.sqlite"},
		{"Ünï\r\n", "n.sqlite"},
		{"***", "app.sqlite"},
	}
	for _, tt := range tests {
		t.Run(tt.app, func(t *testing.T) {
			if got := exportFilename(tt.app); got != tt.want {
				t.Fatalf("exportFilename(%q) = %q, want %q", tt.app, got, tt.want)
			}
		})
	}
}

func TestExportStreams(t *testing.T) {
	e, _, _, _ := streamEnv(t)
	cookie, csrf := e.session("owner@example.com")
	rec := e.send(http.MethodGet, "/api/orgs/acme/apps/web/export", nil, withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusOK)
	if got := rec.Header().Get("Content-Type"); got != "application/vnd.sqlite3" {
		t.Errorf("Content-Type = %q", got)
	}
	if got := rec.Header().Get("Content-Disposition"); got != `attachment; filename="web.sqlite"` {
		t.Errorf("Content-Disposition = %q", got)
	}
	if rec.Body.Len() == 0 {
		t.Error("empty export body")
	}
}
