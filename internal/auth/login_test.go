package auth

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
)

func TestLoginNoUserEnumeration(t *testing.T) {
	ctx := context.Background()
	spy := &spyHasher{}
	e := newEnv(t, spy)
	u := e.mkUser(t, "a@example.com", "password-123456")
	e.mkUser(t, "off@example.com", "password-123456")
	if err := e.svc.SetDisabled(ctx, mustUserID(t, e, "off@example.com"), true); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name, email, pw string
	}{
		{"unknown user", "nobody@example.com", "password-123456"},
		{"bad password", "a@example.com", "wrong-password-1"},
		{"disabled", "off@example.com", "password-123456"},
	}
	var msgs []string
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			spy.mu.Lock()
			spy.hashes = nil
			spy.mu.Unlock()
			_, err := e.svc.Login(ctx, tt.email, tt.pw, "1.2.3.4", "ua")
			if !errors.Is(err, ErrInvalidCredentials) {
				t.Fatalf("err = %v, want ErrInvalidCredentials", err)
			}
			msgs = append(msgs, err.Error())
			spy.mu.Lock()
			defer spy.mu.Unlock()
			if len(spy.hashes) != 1 {
				t.Fatalf("Verify calls = %d, want 1", len(spy.hashes))
			}
			if spy.hashes[0] == "" {
				t.Error("Verify got an empty hash; want a dummy hash for unknown users")
			}
		})
	}
	for _, m := range msgs[1:] {
		if m != msgs[0] {
			t.Errorf("error messages differ: %q vs %q", m, msgs[0])
		}
	}
	got, err := e.svc.Login(ctx, "A@Example.com", "password-123456", "1.2.3.4", "ua")
	if err != nil || got.User.ID != u.ID {
		t.Fatalf("Login = %+v, %v", got, err)
	}
}

func mustUserID(t *testing.T, e *env, email string) string {
	t.Helper()
	u, err := e.st.Q().GetUserByEmail(context.Background(), email)
	if err != nil {
		t.Fatal(err)
	}
	return u.ID
}

func TestLoginRateLimit(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	e.mkUser(t, "a@example.com", "password-123456")
	for i := range 10 {
		if _, err := e.svc.Login(ctx, "a@example.com", "wrong-password-1", "1.2.3.4", "ua"); !errors.Is(err, ErrInvalidCredentials) {
			t.Fatalf("attempt %d: err = %v", i, err)
		}
	}
	// The right password is now refused for this (ip, email).
	if _, err := e.svc.Login(ctx, "a@example.com", "password-123456", "1.2.3.4", "ua"); !errors.Is(err, apperr.ErrRateLimited) {
		t.Fatalf("11th: err = %v, want ErrRateLimited", err)
	}
	if _, err := e.svc.Login(ctx, "A@EXAMPLE.COM", "password-123456", "1.2.3.4", "ua"); !errors.Is(err, apperr.ErrRateLimited) {
		t.Fatalf("case variant: err = %v, want ErrRateLimited", err)
	}
	// Other ip and other email are independent.
	if _, err := e.svc.Login(ctx, "a@example.com", "password-123456", "5.6.7.8", "ua"); err != nil {
		t.Fatalf("other ip: %v", err)
	}
	if _, err := e.svc.Login(ctx, "b@example.com", "x-password-12345", "1.2.3.4", "ua"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("other email: err = %v, want ErrInvalidCredentials", err)
	}
	// The window slides.
	e.clock.Advance(15*time.Minute + time.Second)
	if _, err := e.svc.Login(ctx, "a@example.com", "password-123456", "1.2.3.4", "ua"); err != nil {
		t.Fatalf("after window: %v", err)
	}
}

func TestLoginEventsRecorded(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	u := e.mkUser(t, "a@example.com", "password-123456")

	if _, err := e.svc.Login(ctx, "a@example.com", "password-123456", "1.2.3.4", "ua-ok"); err != nil {
		t.Fatal(err)
	}
	e.clock.Advance(time.Second)
	_, _ = e.svc.Login(ctx, "a@example.com", "wrong-password-1", "1.2.3.4", "ua-bad")
	e.clock.Advance(time.Second)
	// 4b's TOTP step writes through the same recorder.
	if err := e.svc.Events.Record(ctx, LoginEvent{UserID: u.ID, Email: u.Email, IP: "1.2.3.4", UA: "ua-totp", Method: MethodPassword, Result: ResultBadTOTP}); err != nil {
		t.Fatal(err)
	}
	e.clock.Advance(time.Second)
	_, _ = e.svc.Login(ctx, "ghost@example.com", "wrong-password-1", "1.2.3.4", "ua-ghost")

	got, err := e.svc.Events.ListForUser(ctx, u.ID, 10)
	if err != nil {
		t.Fatal(err)
	}
	want := []struct{ result, ua string }{
		{ResultBadTOTP, "ua-totp"}, {ResultBadPassword, "ua-bad"}, {ResultOK, "ua-ok"},
	}
	if len(got) != len(want) {
		t.Fatalf("events = %+v, want %d", got, len(want))
	}
	for i, w := range want {
		if got[i].Result != w.result || got[i].UA != w.ua || got[i].IP != "1.2.3.4" || got[i].Method != MethodPassword || got[i].At.IsZero() {
			t.Errorf("event %d = %+v, want %+v", i, got[i], w)
		}
	}
}

// A limiter or login-event write failure must deny the login, never allow it.
func TestLoginFailsClosedOnStoreError(t *testing.T) {
	ctx := context.Background()
	for _, table := range []string{"login_failures", "login_events"} {
		t.Run(table, func(t *testing.T) {
			e := newEnv(t, plainHasher{})
			e.mkUser(t, "a@example.com", "password-123456")
			if _, err := e.st.DB().ExecContext(ctx, "DROP TABLE "+table); err != nil {
				t.Fatal(err)
			}
			if _, err := e.svc.Login(ctx, "a@example.com", "wrong-password-1", "1.2.3.4", "ua"); err == nil || errors.Is(err, ErrInvalidCredentials) {
				t.Fatalf("bad login err = %v, want a store error", err)
			}
			if _, err := e.svc.Login(ctx, "a@example.com", "password-123456", "1.2.3.4", "ua"); err == nil {
				t.Fatal("good login succeeded with a broken limiter/audit store")
			}
		})
	}
}
