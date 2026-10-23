package audit

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/store"
	"github.com/21cloud/runtime-web/internal/store/db"
)

// testWriter stamps entries with a fixed clock.
var testWriter = Writer{Now: func() time.Time { return time.UnixMilli(1_700_000_000_000) }}

func newQueries(t *testing.T) (*db.Queries, string) {
	t.Helper()
	st, err := store.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	orgID := store.NewID("org_")
	err = st.Q().CreateOrg(context.Background(), db.CreateOrgParams{
		ID: orgID, Slug: "acme", Name: "Acme", TenantID: "tnt_acme", CreatedAt: 1,
	})
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	return st.Q(), orgID
}

func TestAuditStampsInjectedClock(t *testing.T) {
	q, _ := newQueries(t)
	ctx := context.Background()
	if err := testWriter.Log(ctx, q, Actor{UserID: "usr_1"}, "", "x.y", "t", nil); err != nil {
		t.Fatalf("Log: %v", err)
	}
	got, _, err := List(ctx, q, Filter{})
	if err != nil || len(got) != 1 || got[0].At != 1_700_000_000_000 {
		t.Fatalf("entries = %+v err = %v, want At from injected clock", got, err)
	}
}

func TestAuditWritten(t *testing.T) {
	q, orgID := newQueries(t)
	ctx := context.Background()
	if err := testWriter.Log(ctx, q, Actor{UserID: "usr_1"}, orgID, "org.rename", "org_x", map[string]string{"name": "New"}); err != nil {
		t.Fatalf("Log: %v", err)
	}
	got, _, err := List(ctx, q, Filter{})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1", len(got))
	}
	e := got[0]
	if e.ActorUserID != "usr_1" || e.Action != "org.rename" || e.Target != "org_x" {
		t.Errorf("entry = %+v", e)
	}
	if e.OrgID == nil || *e.OrgID != orgID {
		t.Errorf("OrgID = %v, want %s", e.OrgID, orgID)
	}
	if !strings.Contains(e.Detail, `"name":"New"`) {
		t.Errorf("Detail = %q, want JSON with name", e.Detail)
	}
	if e.AsInstanceAdmin {
		t.Errorf("AsInstanceAdmin = true, want false")
	}
}

func TestAuditMarksInstanceAdmin(t *testing.T) {
	tests := []struct {
		name  string
		actor Actor
		want  bool
	}{
		{"member", Actor{UserID: "usr_m"}, false},
		{"instance admin", Actor{UserID: "usr_a", AsInstanceAdmin: true}, true},
		{"cli", Actor{UserID: "cli", AsInstanceAdmin: true}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			q, _ := newQueries(t)
			ctx := context.Background()
			if err := testWriter.Log(ctx, q, tt.actor, "", "user.create", "usr_t", nil); err != nil {
				t.Fatalf("Log: %v", err)
			}
			got, _, err := List(ctx, q, Filter{})
			if err != nil {
				t.Fatalf("List: %v", err)
			}
			if len(got) != 1 || got[0].AsInstanceAdmin != tt.want {
				t.Fatalf("entries = %+v, want as_instance_admin=%v", got, tt.want)
			}
			if got[0].OrgID != nil {
				t.Errorf("OrgID = %v, want nil for instance-wide entry", *got[0].OrgID)
			}
		})
	}
}

func TestAuditListFilters(t *testing.T) {
	q, orgID := newQueries(t)
	ctx := context.Background()
	must := func(actor, org, action string) {
		t.Helper()
		if err := testWriter.Log(ctx, q, Actor{UserID: actor}, org, action, "t", nil); err != nil {
			t.Fatalf("Log: %v", err)
		}
	}
	must("usr_a", orgID, "member.add")
	must("usr_b", orgID, "member.add")
	must("usr_a", orgID, "app.deploy")
	must("usr_a", "", "user.create")

	org := orgID
	tests := []struct {
		name   string
		filter Filter
		want   int
	}{
		{"all", Filter{}, 4},
		{"org scoped", Filter{OrgID: &org}, 3},
		{"actor", Filter{ActorUserID: "usr_a"}, 3},
		{"action", Filter{Action: "member.add"}, 2},
		{"actor and action", Filter{ActorUserID: "usr_a", Action: "app.deploy"}, 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, next, err := List(ctx, q, tt.filter)
			if err != nil {
				t.Fatalf("List: %v", err)
			}
			if len(got) != tt.want || next != "" {
				t.Errorf("len = %d next = %q, want %d and no cursor", len(got), next, tt.want)
			}
		})
	}
}

func TestAuditCursorPagesWithoutRepeats(t *testing.T) {
	q, orgID := newQueries(t)
	ctx := context.Background()
	for i := 0; i < 5; i++ {
		if err := testWriter.Log(ctx, q, Actor{UserID: "usr_a"}, orgID, "x.y", "t", nil); err != nil {
			t.Fatalf("Log: %v", err)
		}
	}
	seen := map[string]bool{}
	cursor := ""
	pages := 0
	for {
		got, next, err := List(ctx, q, Filter{Before: cursor, Limit: 2})
		if err != nil {
			t.Fatalf("List: %v", err)
		}
		for _, e := range got {
			if seen[e.ID] {
				t.Fatalf("entry %s repeated across pages", e.ID)
			}
			seen[e.ID] = true
		}
		pages++
		if next == "" {
			break
		}
		cursor = next
		if pages > 5 {
			t.Fatal("cursor did not terminate")
		}
	}
	if len(seen) != 5 || pages != 3 {
		t.Errorf("seen = %d in %d pages, want 5 in 3", len(seen), pages)
	}
}

func TestAuditBadCursor(t *testing.T) {
	q, _ := newQueries(t)
	_, _, err := List(context.Background(), q, Filter{Before: "not-a-cursor"})
	if err == nil || !errors.Is(err, apperr.ErrInvalid) {
		t.Fatalf("err = %v, want apperr.ErrInvalid", err)
	}
}
