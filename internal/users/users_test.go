package users

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/audit"
	"github.com/21cloud/runtime-web/internal/auth"
	"github.com/21cloud/runtime-web/internal/store"
)

// plainHasher is a fast test Hasher; it is not a real password hash.
type plainHasher struct{}

func (plainHasher) Hash(p string) (string, error) { return "plain$" + p, nil }
func (plainHasher) Verify(hash, p string) bool    { return hash == "plain$"+p }

type fixture struct {
	st   *store.Store
	svc  *Service
	sess *auth.Sessions
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	st, err := store.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	sess := &auth.Sessions{Q: st.Q()}
	return &fixture{st: st, svc: New(st, plainHasher{}), sess: sess}
}

var cli = audit.Actor{UserID: "cli"}

func (f *fixture) mustCreate(t *testing.T, email string, admin bool) User {
	t.Helper()
	u, _, err := f.svc.Create(context.Background(), cli, email, "Name", admin)
	if err != nil {
		t.Fatalf("Create(%s): %v", email, err)
	}
	return u
}

func wantConflict(t *testing.T, err error, code string) {
	t.Helper()
	got, ok := apperr.ConflictCode(err)
	if !ok || got != code {
		t.Fatalf("err = %v, want conflict %q", err, code)
	}
}

func TestTempPasswordForcesChange(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	u, temp, err := f.svc.Create(ctx, cli, "Ann@Example.com", "Ann", false)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if len(temp) != 20 {
		t.Errorf("temp password length = %d, want 20", len(temp))
	}
	if u.Email != "ann@example.com" {
		t.Errorf("Email = %q, want normalized lowercase", u.Email)
	}
	if !u.MustChangePassword {
		t.Errorf("MustChangePassword = false, want true")
	}
	row, err := f.st.Q().GetUserByID(ctx, u.ID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if !(plainHasher{}).Verify(row.PasswordHash, temp) {
		t.Errorf("stored hash does not match the returned temp password")
	}
	if row.MustChangePassword != 1 {
		t.Errorf("must_change_password = %d, want 1", row.MustChangePassword)
	}
}

func TestCreateValidation(t *testing.T) {
	tests := []struct {
		name, email, display string
	}{
		{"empty email", "", "A"},
		{"no at sign", "nope", "A"},
		{"empty name", "a@example.com", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			_, _, err := f.svc.Create(context.Background(), cli, tt.email, tt.display, false)
			if !errors.Is(err, apperr.ErrInvalid) {
				t.Fatalf("err = %v, want ErrInvalid", err)
			}
		})
	}
}

func TestCreateDuplicateEmail(t *testing.T) {
	f := newFixture(t)
	f.mustCreate(t, "dup@example.com", false)
	_, _, err := f.svc.Create(context.Background(), cli, "DUP@example.com", "Again", false)
	wantConflict(t, err, "email_taken")
}

func TestLastAdminProtected(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	only := f.mustCreate(t, "root@example.com", true)

	if err := f.svc.Disable(ctx, cli, only.ID); err == nil {
		t.Fatal("Disable(last admin) succeeded")
	} else {
		wantConflict(t, err, "last_admin")
	}
	if err := f.svc.SetAdmin(ctx, cli, only.ID, false); err == nil {
		t.Fatal("SetAdmin(last admin, false) succeeded")
	} else {
		wantConflict(t, err, "last_admin")
	}

	second := f.mustCreate(t, "second@example.com", true)
	if err := f.svc.SetAdmin(ctx, cli, only.ID, false); err != nil {
		t.Fatalf("SetAdmin(first, false) with a second admin: %v", err)
	}
	if err := f.svc.Disable(ctx, cli, second.ID); err == nil {
		t.Fatal("Disable(now last admin) succeeded")
	} else {
		wantConflict(t, err, "last_admin")
	}
}

func TestDisableUserRevokesSessions(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	u := f.mustCreate(t, "bob@example.com", false)
	cookie, _, err := f.sess.Create(ctx, u.ID, "10.0.0.1", "ua")
	if err != nil {
		t.Fatalf("Sessions.Create: %v", err)
	}
	if _, _, err := f.sess.Lookup(ctx, cookie); err != nil {
		t.Fatalf("Lookup before disable: %v", err)
	}
	if err := f.svc.Disable(ctx, cli, u.ID); err != nil {
		t.Fatalf("Disable: %v", err)
	}
	if _, _, err := f.sess.Lookup(ctx, cookie); err == nil {
		t.Fatal("Lookup after disable succeeded, session not revoked")
	}
	row, err := f.st.Q().GetUserByID(ctx, u.ID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if row.Disabled != 1 {
		t.Errorf("disabled = %d, want 1", row.Disabled)
	}
}

func TestResetPasswordRevokesSessionsAndForcesChange(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	u := f.mustCreate(t, "carl@example.com", false)
	cookie, _, err := f.sess.Create(ctx, u.ID, "10.0.0.1", "ua")
	if err != nil {
		t.Fatalf("Sessions.Create: %v", err)
	}
	temp, err := f.svc.ResetPassword(ctx, cli, u.ID)
	if err != nil {
		t.Fatalf("ResetPassword: %v", err)
	}
	if _, _, err := f.sess.Lookup(ctx, cookie); err == nil {
		t.Fatal("session survived ResetPassword")
	}
	row, err := f.st.Q().GetUserByID(ctx, u.ID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if !(plainHasher{}).Verify(row.PasswordHash, temp) || row.MustChangePassword != 1 {
		t.Errorf("reset did not store temp password with must_change_password")
	}
}

func TestAuditWritten(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	u := f.mustCreate(t, "dee@example.com", false)
	if err := f.svc.Disable(ctx, audit.Actor{UserID: "usr_op", AsInstanceAdmin: true}, u.ID); err != nil {
		t.Fatalf("Disable: %v", err)
	}
	entries, _, err := audit.List(ctx, f.st.Q(), audit.Filter{})
	if err != nil {
		t.Fatalf("audit.List: %v", err)
	}
	seen := map[string]audit.Entry{}
	for _, e := range entries {
		seen[e.Action] = e
	}
	if e, ok := seen["user.create"]; !ok || e.ActorUserID != "cli" || e.Target != u.ID {
		t.Errorf("user.create entry = %+v (present %v)", e, ok)
	}
	if e, ok := seen["user.disable"]; !ok || e.ActorUserID != "usr_op" || !e.AsInstanceAdmin || !strings.Contains(e.Target, u.ID) {
		t.Errorf("user.disable entry = %+v (present %v)", e, ok)
	}
}

func TestWritesRollBackWithSessionRevoke(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	u := f.mustCreate(t, "eve@example.com", false)
	cookie, _, err := f.sess.Create(ctx, u.ID, "10.0.0.1", "ua")
	if err != nil {
		t.Fatalf("Sessions.Create: %v", err)
	}
	f.svc.hookAfterWrite = func() error { return errors.New("boom") }
	if err := f.svc.Disable(ctx, cli, u.ID); err == nil {
		t.Fatal("Disable succeeded despite failing write")
	}
	if _, _, err := f.sess.Lookup(ctx, cookie); err != nil {
		t.Errorf("session revoked although the disable tx rolled back: %v", err)
	}
	row, err := f.st.Q().GetUserByID(ctx, u.ID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if row.Disabled != 0 {
		t.Errorf("user disabled although the tx rolled back")
	}
}

func TestListReturnsAllUsers(t *testing.T) {
	f := newFixture(t)
	f.mustCreate(t, "x@example.com", true)
	f.mustCreate(t, "y@example.com", false)
	got, err := f.svc.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
}
