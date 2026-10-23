package apps

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/audit"
	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/orgs"
	"github.com/21cloud/runtime-web/internal/runtime"
	"github.com/21cloud/runtime-web/internal/seal"
)

// developer holds the default project as a developer: env and queue writes, but not secrets.
var developer = authz.Subject{UserID: "usr_dev", OrgRole: authz.RoleMember, ProjectRoles: map[string]string{"default": authz.RoleDeveloper}}

func TestEnvReplacesMap(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.app(t, f.org.ID, "default", "production", "e1")
	if _, err := f.svc.SetEnv(ctx, owner, f.org.ID, "e1", map[string]string{"A": "1"}); err != nil {
		t.Fatalf("SetEnv: %v", err)
	}
	if _, err := f.svc.SetEnv(ctx, owner, f.org.ID, "e1", map[string]string{"B": "2"}); err != nil {
		t.Fatalf("SetEnv: %v", err)
	}
	got, err := f.svc.Env(ctx, owner, f.org.ID, "e1")
	if err != nil {
		t.Fatalf("Env: %v", err)
	}
	if len(got) != 1 || got["B"] != "2" {
		t.Fatalf("env = %v, want only B=2", got)
	}
}

func TestDeveloperCannotWriteSecrets(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.app(t, f.org.ID, "default", "production", "s1")
	if err := f.svc.SetSecret(ctx, developer, f.org.ID, "s1", "TOKEN", "v"); !errors.Is(err, apperr.ErrForbidden) {
		t.Fatalf("SetSecret by developer err = %v, want ErrForbidden", err)
	}
	if err := f.svc.DeleteSecret(ctx, developer, f.org.ID, "s1", "TOKEN"); !errors.Is(err, apperr.ErrForbidden) {
		t.Fatalf("DeleteSecret by developer err = %v, want ErrForbidden", err)
	}
	if _, err := f.svc.SetEnv(ctx, developer, f.org.ID, "s1", map[string]string{"A": "1"}); err != nil {
		t.Fatalf("SetEnv by developer: %v", err)
	}
}

func TestSecretsListNamesOnly(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.app(t, f.org.ID, "default", "production", "s2")
	const value = "s3cret-value-xyz"
	if err := f.svc.SetSecret(ctx, owner, f.org.ID, "s2", "API_KEY", value); err != nil {
		t.Fatalf("SetSecret: %v", err)
	}
	items, err := f.svc.Secrets(ctx, owner, f.org.ID, "s2")
	if err != nil {
		t.Fatalf("Secrets: %v", err)
	}
	if len(items) != 1 || items[0].Name != "API_KEY" || items[0].UpdatedAt == 0 {
		t.Fatalf("secrets = %+v, want one API_KEY", items)
	}
	b, err := json.Marshal(items)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(b), value) {
		t.Fatalf("secret value leaked in list: %s", b)
	}
	if err := f.svc.DeleteSecret(ctx, owner, f.org.ID, "s2", "API_KEY"); err != nil {
		t.Fatalf("DeleteSecret: %v", err)
	}
	items, err = f.svc.Secrets(ctx, owner, f.org.ID, "s2")
	if err != nil || len(items) != 0 {
		t.Fatalf("after delete secrets = %+v, %v; want empty", items, err)
	}
}

func TestCronTemplateOnConfiguredPlan(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	cron := "0 * * * *"
	body := runtime.ScheduleBody{Kind: "cron", Cron: &cron}

	// The fixture org is on the standard plan, which allows cron.
	if _, err := f.svc.Create(ctx, owner, f.org.ID, "default", "production", "cron1", "cron"); err != nil {
		t.Fatalf("Create cron template: %v", err)
	}
	sc, err := f.svc.CreateSchedule(ctx, owner, f.org.ID, "cron1", body)
	if err != nil {
		t.Fatalf("CreateSchedule on standard: %v", err)
	}
	if sc.Kind != "cron" || sc.ID == "" {
		t.Fatalf("schedule = %+v", sc)
	}

	// A free-plan org refuses cron as plan_limit.
	key := [32]byte{9, 8, 7}
	free := orgs.New(f.st, f.rt, f.root, seal.New(key), "free")
	org, err := free.Create(ctx, audit.Actor{UserID: f.uid}, "freeorg", "freeorg", f.uid)
	if err != nil {
		t.Fatalf("orgs.Create free: %v", err)
	}
	svc := New(f.rt, free, f.st)
	if _, err := svc.Create(ctx, owner, org.ID, "default", "production", "cron2", "cron"); err != nil {
		t.Fatalf("Create on free: %v", err)
	}
	_, err = svc.CreateSchedule(ctx, owner, org.ID, "cron2", body)
	if !errors.Is(err, apperr.ErrForbidden) {
		t.Fatalf("CreateSchedule on free err = %v, want ErrForbidden", err)
	}
	if code, ok := apperr.ForbiddenCode(err); !ok || code != "plan_limit" {
		t.Fatalf("CreateSchedule on free err = %v, want forbidden plan_limit", err)
	}
}

func TestSetSecretErrorOmitsValue(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.app(t, f.org.ID, "default", "production", "s4")
	const value = "never-echo-me-123"
	if _, err := f.svc.Queue(ctx, owner, f.org.ID, "s4"); err != nil {
		t.Fatalf("Queue: %v", err)
	}
	f.fake.FailNext(http.StatusUnprocessableEntity, "invalid", 0)
	err := f.svc.SetSecret(ctx, owner, f.org.ID, "s4", "TOKEN", value)
	if !errors.Is(err, apperr.ErrInvalid) {
		t.Fatalf("SetSecret err = %v, want ErrInvalid", err)
	}
	if strings.Contains(err.Error(), value) {
		t.Fatalf("SetSecret error leaks value: %v", err)
	}
}

func TestUpdateSchedulePatchKeepsOtherFields(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.app(t, f.org.ID, "default", "production", "p1")
	expr := "0 * * * *"
	sc, err := f.svc.CreateSchedule(ctx, owner, f.org.ID, "p1", runtime.ScheduleBody{Kind: "cron", Cron: &expr})
	if err != nil {
		t.Fatalf("CreateSchedule: %v", err)
	}
	off := false
	got, err := f.svc.UpdateSchedule(ctx, owner, f.org.ID, "p1", sc.ID, SchedulePatch{Enabled: &off})
	if err != nil {
		t.Fatalf("UpdateSchedule enabled: %v", err)
	}
	if got.Kind != "cron" || got.Cron == nil || *got.Cron != expr || got.Enabled {
		t.Fatalf("after enabled patch = %+v, want cron %q disabled", got, expr)
	}
	newExpr := "5 * * * *"
	got, err = f.svc.UpdateSchedule(ctx, owner, f.org.ID, "p1", sc.ID, SchedulePatch{Cron: &newExpr})
	if err != nil {
		t.Fatalf("UpdateSchedule cron: %v", err)
	}
	if got.Kind != "cron" || got.Cron == nil || *got.Cron != newExpr || got.Enabled {
		t.Fatalf("after cron patch = %+v, want cron %q still disabled", got, newExpr)
	}
	if _, err := f.svc.UpdateSchedule(ctx, owner, f.org.ID, "p1", "sch_missing", SchedulePatch{Enabled: &off}); !errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("missing schedule err = %v, want ErrNotFound", err)
	}
}

func TestQueueFullThrottled(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.app(t, f.org.ID, "default", "production", "q1")
	// Warm the slug cache so the injected failure hits the enqueue request itself.
	if _, err := f.svc.Queue(ctx, owner, f.org.ID, "q1"); err != nil {
		t.Fatalf("Queue: %v", err)
	}
	f.fake.FailNext(http.StatusTooManyRequests, "queue_full", 3*time.Second)
	_, err := f.svc.Enqueue(ctx, owner, f.org.ID, "q1", runtime.EnqueueBody{Body: json.RawMessage(`{"n":1}`)})
	var re *runtime.Error
	if !errors.As(err, &re) || re.Status != http.StatusTooManyRequests || re.Code != "queue_full" {
		t.Fatalf("Enqueue err = %v, want runtime 429 queue_full", err)
	}
	if re.RetryAfter != 3*time.Second {
		t.Fatalf("RetryAfter = %v, want 3s", re.RetryAfter)
	}
	if !runtime.IsThrottled(err) {
		t.Fatalf("IsThrottled(%v) = false", err)
	}
	if _, err := f.svc.Enqueue(ctx, owner, f.org.ID, "q1", runtime.EnqueueBody{Body: json.RawMessage(`{"n":2}`)}); err != nil {
		t.Fatalf("Enqueue after throttle: %v", err)
	}
}

func TestDLQPurgeAndRedrive(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.app(t, f.org.ID, "default", "production", "d1")
	f.fake.DeadLetter(v.Raw.ID, json.RawMessage(`{"n":1}`))
	f.fake.DeadLetter(v.Raw.ID, json.RawMessage(`{"n":2}`))

	items, err := f.svc.DLQ(ctx, owner, f.org.ID, "d1")
	if err != nil || len(items) != 2 {
		t.Fatalf("DLQ = %+v, %v; want 2 items", items, err)
	}
	out, err := f.svc.RedriveDLQ(ctx, owner, f.org.ID, "d1")
	if err != nil || out.Redriven != 2 {
		t.Fatalf("RedriveDLQ = %+v, %v; want 2", out, err)
	}
	items, err = f.svc.DLQ(ctx, owner, f.org.ID, "d1")
	if err != nil || len(items) != 0 {
		t.Fatalf("DLQ after redrive = %+v, %v; want empty", items, err)
	}
	st, err := f.svc.Queue(ctx, owner, f.org.ID, "d1")
	if err != nil || st.Depth != 2 {
		t.Fatalf("Queue after redrive = %+v, %v; want depth 2", st, err)
	}

	f.fake.DeadLetter(v.Raw.ID, json.RawMessage(`{"n":3}`))
	if err := f.svc.PurgeDLQ(ctx, owner, f.org.ID, "d1"); err != nil {
		t.Fatalf("PurgeDLQ: %v", err)
	}
	items, err = f.svc.DLQ(ctx, owner, f.org.ID, "d1")
	if err != nil || len(items) != 0 {
		t.Fatalf("DLQ after purge = %+v, %v; want empty", items, err)
	}
}
