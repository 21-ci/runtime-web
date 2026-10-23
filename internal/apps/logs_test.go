package apps

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/authz"
)

// viewer reads the default project: logs and stats, but no data export.
var viewer = authz.Subject{UserID: "usr_view", OrgRole: authz.RoleMember, ProjectRoles: map[string]string{"default": authz.RoleViewer}}

// newHub returns a LogHub with test timings, closed at the end of t.
func newHub(t *testing.T, f *fixture) *LogHub {
	t.Helper()
	h := NewLogHub(f.svc)
	h.grace = 50 * time.Millisecond
	h.minBackoff = 10 * time.Millisecond
	h.maxBackoff = 50 * time.Millisecond
	t.Cleanup(h.Close)
	return h
}

// keyID is the runtime key id of the org's default key ("rtk_<id>_<secret>").
func (f *fixture) keyID(t *testing.T, orgID string) string {
	t.Helper()
	cred, err := f.orgs.DefaultCred(context.Background(), orgID)
	if err != nil {
		t.Fatalf("DefaultCred: %v", err)
	}
	rest := strings.TrimPrefix(cred.Secret, "rtk_")
	return rest[:strings.LastIndexByte(rest, '_')]
}

// subscribe opens a log subscription that is cancelled at the end of t.
func subscribe(t *testing.T, h *LogHub, sub authz.Subject, orgID, slug, last string) <-chan LogEvent {
	t.Helper()
	ch, cancel, err := h.Subscribe(context.Background(), sub, orgID, slug, last)
	if err != nil {
		t.Fatalf("Subscribe(%s): %v", slug, err)
	}
	t.Cleanup(cancel)
	return ch
}

// next reads one event from ch within 2 s.
func next(t *testing.T, ch <-chan LogEvent) LogEvent {
	t.Helper()
	select {
	case ev, ok := <-ch:
		if !ok {
			t.Fatal("log channel closed")
		}
		return ev
	case <-time.After(2 * time.Second):
		t.Fatal("no log event within 2s")
	}
	return LogEvent{}
}

// wantLogs reads len(msgs) log events and checks their messages in order.
func wantLogs(t *testing.T, ch <-chan LogEvent, msgs ...string) {
	t.Helper()
	for _, m := range msgs {
		ev := next(t, ch)
		var l LogLine
		if err := json.Unmarshal(ev.Data, &l); err != nil {
			t.Fatalf("data %s: %v", ev.Data, err)
		}
		if ev.Event != "log" || l.Msg != m || ev.ID != fmt.Sprint(l.Seq) {
			t.Fatalf("event = %s %s %s, want log %q", ev.Event, ev.ID, ev.Data, m)
		}
	}
}

// eventually polls cond for up to 2 s.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if cond() {
			return
		}
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestLogFanoutOneUpstream(t *testing.T) {
	f := newFixture(t)
	h := newHub(t, f)
	v := f.app(t, f.org.ID, "default", "production", "l1")
	var chans []<-chan LogEvent
	for range 5 {
		chans = append(chans, subscribe(t, h, viewer, f.org.ID, "l1", ""))
	}
	key := f.keyID(t, f.org.ID)
	eventually(t, "one upstream", func() bool { return f.fake.OpenStreams(key) == 1 })
	f.fake.EmitLog(v.Raw.ID, "hello")
	for _, ch := range chans {
		wantLogs(t, ch, "hello")
	}
	if n := f.fake.OpenStreams(key); n != 1 {
		t.Fatalf("open streams = %d, want 1", n)
	}
}

func TestLogLineDropsServiceID(t *testing.T) {
	f := newFixture(t)
	h := newHub(t, f)
	v := f.app(t, f.org.ID, "default", "production", "l9")
	ch := subscribe(t, h, viewer, f.org.ID, "l9", "")
	f.fake.EmitLog(v.Raw.ID, "x")
	ev := next(t, ch)
	if strings.Contains(string(ev.Data), "service_id") || strings.Contains(string(ev.Data), "svc_") {
		t.Fatalf("data leaks the runtime service id: %s", ev.Data)
	}
}

func TestLogResumeLastEventID(t *testing.T) {
	f := newFixture(t)
	h := newHub(t, f)
	v := f.app(t, f.org.ID, "default", "production", "l2")
	svc := v.Raw.ID
	first := subscribe(t, h, viewer, f.org.ID, "l2", "")
	for i := 1; i <= 5; i++ {
		f.fake.EmitLog(svc, fmt.Sprint("m", i))
	}
	wantLogs(t, first, "m1", "m2", "m3", "m4", "m5")
	resumed := subscribe(t, h, viewer, f.org.ID, "l2", "3")
	wantLogs(t, resumed, "m4", "m5")
	f.fake.EmitLog(svc, "m6")
	wantLogs(t, resumed, "m6")
}

func TestLogResumeOlderThanBufferSendsGap(t *testing.T) {
	f := newFixture(t)
	h := newHub(t, f)
	h.bufSize = 3
	v := f.app(t, f.org.ID, "default", "production", "l3")
	svc := v.Raw.ID
	first := subscribe(t, h, viewer, f.org.ID, "l3", "")
	for i := 1; i <= 6; i++ {
		f.fake.EmitLog(svc, fmt.Sprint("m", i))
	}
	wantLogs(t, first, "m1", "m2", "m3", "m4", "m5", "m6")
	resumed := subscribe(t, h, viewer, f.org.ID, "l3", "1")
	gap := next(t, resumed)
	if gap.Event != "gap" || string(gap.Data) != `{"from":4}` {
		t.Fatalf("first event = %s %s, want gap from 4", gap.Event, gap.Data)
	}
	wantLogs(t, resumed, "m4", "m5", "m6")
}

func TestLogUpstreamReconnect(t *testing.T) {
	f := newFixture(t)
	h := newHub(t, f)
	v := f.app(t, f.org.ID, "default", "production", "l4")
	svc := v.Raw.ID
	ch := subscribe(t, h, viewer, f.org.ID, "l4", "")
	f.fake.EmitLog(svc, "a")
	f.fake.EmitLog(svc, "b")
	wantLogs(t, ch, "a", "b")
	f.fake.DropLogStreams()
	f.fake.EmitLog(svc, "c")
	// The upstream resumes after seq 2: c arrives once, a and b are not repeated.
	wantLogs(t, ch, "c")
	key := f.keyID(t, f.org.ID)
	eventually(t, "upstream reopened", func() bool { return f.fake.OpenStreams(key) == 1 })
	f.fake.EmitLog(svc, "d")
	wantLogs(t, ch, "d")
}

func TestLogUpstreamClosedAfterIdle(t *testing.T) {
	f := newFixture(t)
	h := newHub(t, f)
	f.app(t, f.org.ID, "default", "production", "l5")
	key := f.keyID(t, f.org.ID)
	ch, cancel, err := h.Subscribe(context.Background(), viewer, f.org.ID, "l5", "")
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	eventually(t, "upstream open", func() bool { return f.fake.OpenStreams(key) == 1 })
	done := h.streamDone(f.org.ID, "l5")
	cancel()
	cancel() // idempotent
	if _, ok := <-ch; ok {
		t.Fatal("channel still open after cancel")
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream goroutine still running after the grace period")
	}
	eventually(t, "upstream closed", func() bool { return f.fake.OpenStreams(key) == 0 })
	if n := h.open(f.org.ID); n != 0 {
		t.Fatalf("hub streams = %d, want 0", n)
	}
}

func TestLogResubscribeWithinGraceKeepsUpstream(t *testing.T) {
	f := newFixture(t)
	h := newHub(t, f)
	h.grace = time.Second
	f.app(t, f.org.ID, "default", "production", "l6")
	_, cancel, err := h.Subscribe(context.Background(), viewer, f.org.ID, "l6", "")
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	done := h.streamDone(f.org.ID, "l6")
	cancel()
	subscribe(t, h, viewer, f.org.ID, "l6", "")
	if h.streamDone(f.org.ID, "l6") != done {
		t.Fatal("a new upstream was opened within the grace period")
	}
}

func TestLogContextCancelUnsubscribes(t *testing.T) {
	f := newFixture(t)
	h := newHub(t, f)
	f.app(t, f.org.ID, "default", "production", "l7")
	ctx, cancel := context.WithCancel(context.Background())
	ch, unsub, err := h.Subscribe(ctx, viewer, f.org.ID, "l7", "")
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer unsub()
	cancel()
	eventually(t, "channel closed", func() bool {
		select {
		case _, ok := <-ch:
			return !ok
		default:
			return false
		}
	})
}

func TestLogSlowSubscriberDropped(t *testing.T) {
	f := newFixture(t)
	h := newHub(t, f)
	h.subSlack = 2
	v := f.app(t, f.org.ID, "default", "production", "l8")
	svc := v.Raw.ID
	slow := subscribe(t, h, viewer, f.org.ID, "l8", "")
	fast := subscribe(t, h, viewer, f.org.ID, "l8", "")
	var want []string
	for i := 1; i <= 10; i++ {
		m := fmt.Sprint("m", i)
		want = append(want, m)
		f.fake.EmitLog(svc, m)
		wantLogs(t, fast, m)
	}
	n := 0
	for range slow {
		n++
	}
	if n > 2 {
		t.Fatalf("slow subscriber got %d events, want at most its buffer of 2", n)
	}
}

func TestLogAppDeletedSendsError(t *testing.T) {
	f := newFixture(t)
	h := newHub(t, f)
	f.app(t, f.org.ID, "default", "production", "la")
	ch := subscribe(t, h, viewer, f.org.ID, "la", "")
	key := f.keyID(t, f.org.ID)
	eventually(t, "upstream open", func() bool { return f.fake.OpenStreams(key) == 1 })
	if err := f.svc.Delete(context.Background(), owner, f.org.ID, "la"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	ev := next(t, ch)
	if ev.Event != "error" || !strings.Contains(string(ev.Data), `"code":"not_found"`) {
		t.Fatalf("event = %s %s, want error not_found", ev.Event, ev.Data)
	}
	if _, ok := <-ch; ok {
		t.Fatal("channel open after terminal error")
	}
}

func TestLogSubscribeAuthz(t *testing.T) {
	f := newFixture(t)
	h := newHub(t, f)
	f.app(t, f.org.ID, "default", "production", "lb")
	other := f.newOrg(t, "other", f.uid)
	stranger := authz.Subject{UserID: "usr_x", OrgRole: authz.RoleMember}
	tests := []struct {
		name string
		sub  authz.Subject
		org  string
		want error
	}{
		{"other org", owner, other.ID, apperr.ErrNotFound},
		{"no project grant", stranger, f.org.ID, apperr.ErrNotFound},
		{"non member", authz.Subject{UserID: "usr_y"}, f.org.ID, apperr.ErrNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, _, err := h.Subscribe(context.Background(), tt.sub, tt.org, "lb", "")
			wantErr(t, err, tt.want)
		})
	}
}

func TestLogPerOrgUpstreamCap(t *testing.T) {
	f := newFixture(t)
	h := newHub(t, f)
	h.maxPerOrg = 2
	for _, s := range []string{"c1", "c2", "c3"} {
		f.app(t, f.org.ID, "default", "production", s)
	}
	subscribe(t, h, viewer, f.org.ID, "c1", "")
	subscribe(t, h, viewer, f.org.ID, "c2", "")
	subscribe(t, h, viewer, f.org.ID, "c2", "") // shares c2's upstream
	_, _, err := h.Subscribe(context.Background(), viewer, f.org.ID, "c3", "")
	wantErr(t, err, apperr.ErrRateLimited)
}

func TestStatsPassthrough(t *testing.T) {
	f := newFixture(t)
	f.app(t, f.org.ID, "default", "production", "st")
	raw, err := f.svc.Stats(context.Background(), viewer, f.org.ID, "st", "5m")
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	if !json.Valid(raw) || len(raw) < 2 || raw[0] != '{' {
		t.Fatalf("stats = %s, want an object", raw)
	}
	_, err = f.svc.Stats(context.Background(), viewer, f.org.ID, "st", "7d")
	wantErr(t, err, apperr.ErrInvalid)
}

func TestEventsPassthroughScoped(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.app(t, f.org.ID, "default", "production", "ev1")
	f.app(t, f.org.ID, "default", "production", "ev2")
	other := f.newOrg(t, "other", f.uid)
	f.app(t, other.ID, "default", "production", "ev3")

	page, err := f.svc.Events(ctx, viewer, f.org.ID, "ev1", "")
	if err != nil {
		t.Fatalf("Events: %v", err)
	}
	if len(page.Items) == 0 {
		t.Fatal("no events for ev1")
	}
	for _, e := range page.Items {
		if e.Kind == "service.created" && !strings.Contains(string(e.Data), `"ev1"`) {
			t.Fatalf("ev1 events include another app's event: %+v", e)
		}
	}
	_, err = f.svc.Events(ctx, owner, f.org.ID, "ev3", "")
	wantErr(t, err, apperr.ErrNotFound)
}

func TestExportRequiresAdmin(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.app(t, f.org.ID, "default", "production", "ex")
	admin := authz.Subject{UserID: "usr_adm", OrgRole: authz.RoleMember, ProjectRoles: map[string]string{"default": authz.RoleAdmin}}
	tests := []struct {
		name string
		sub  authz.Subject
		want error
	}{
		{"viewer", viewer, apperr.ErrForbidden},
		{"developer", developer, apperr.ErrForbidden},
		{"project admin", admin, nil},
		{"owner", owner, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rc, err := f.svc.ExportData(ctx, tt.sub, f.org.ID, "ex")
			if tt.want != nil {
				wantErr(t, err, tt.want)
				return
			}
			if err != nil {
				t.Fatalf("ExportData: %v", err)
			}
			defer rc.Close()
			b, err := io.ReadAll(rc)
			if err != nil || len(b) == 0 {
				t.Fatalf("export body = %d bytes, err %v", len(b), err)
			}
		})
	}
}
