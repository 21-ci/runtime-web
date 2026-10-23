package main

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/21cloud/runtime-web/internal/store"
	"github.com/21cloud/runtime-web/internal/store/db"
)

func TestReset2FACLI(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "rtweb.db")
	st, err := store.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	q := st.Q()
	uid := store.NewID("usr_")
	if err := q.CreateUser(ctx, db.CreateUserParams{ID: uid, Email: "a@example.com", Name: "A", PasswordHash: "x", CreatedAt: 1, UpdatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	if err := q.CreateUserTOTP(ctx, db.CreateUserTOTPParams{UserID: uid, SecretSealed: []byte("sealed"), EnabledAt: sql.NullInt64{Int64: 1, Valid: true}}); err != nil {
		t.Fatal(err)
	}
	if err := q.CreateRecoveryCode(ctx, db.CreateRecoveryCodeParams{UserID: uid, Hash: "h1"}); err != nil {
		t.Fatal(err)
	}
	if err := q.CreateSession(ctx, db.CreateSessionParams{IDHash: "s1", UserID: uid, Csrf: "c", CreatedAt: 1, LastSeenAt: 1, ExpiresAt: 1 << 60}); err != nil {
		t.Fatal(err)
	}
	_ = st.Close()

	env := map[string]string{"RTWEB_DB": path}
	getenv := func(k string) string { return env[k] }
	now := func() time.Time { return time.UnixMilli(1_700_000_000_000) }

	tests := []struct {
		name string
		args []string
		code int
		out  string
	}{
		{"no email", []string{"reset-2fa"}, 2, "--email"},
		{"unknown sub", []string{"frobnicate"}, 2, "usage"},
		{"unknown user", []string{"reset-2fa", "--email", "nobody@example.com"}, 1, "not found"},
		{"ok", []string{"reset-2fa", "--email", "A@Example.com"}, 0, "a@example.com"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var out bytes.Buffer
			if code := runAdmin(ctx, tt.args, getenv, now, &out); code != tt.code {
				t.Fatalf("exit = %d, want %d; out=%s", code, tt.code, out.String())
			}
			if !strings.Contains(out.String(), tt.out) {
				t.Fatalf("out = %q, want %q", out.String(), tt.out)
			}
		})
	}

	st, err = store.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	q = st.Q()
	if _, err := q.GetUserTOTP(ctx, uid); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("user_totp left: %v", err)
	}
	if n, _ := q.CountUnusedRecoveryCodes(ctx, uid); n != 0 {
		t.Fatalf("recovery codes left = %d", n)
	}
	if _, err := q.GetSession(ctx, "s1"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("session left: %v", err)
	}
	rows, err := q.ListAudit(ctx, 10)
	if err != nil || len(rows) != 1 {
		t.Fatalf("audit = %+v, %v", rows, err)
	}
	a := rows[0]
	if a.ActorUserID.Valid || !strings.Contains(a.Detail, "actor=cli") || a.Action != "user.reset_2fa" || a.Target != uid || a.At != 1_700_000_000_000 {
		t.Fatalf("audit row = %+v", a)
	}
}
