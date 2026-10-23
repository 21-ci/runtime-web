package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
)

func TestSessionIdleAndAbsoluteExpiry(t *testing.T) {
	ctx := context.Background()

	t.Run("idle", func(t *testing.T) {
		e := newEnv(t, plainHasher{})
		u := e.mkUser(t, "a@example.com", "password-123456")
		c, _ := e.mkSession(t, u.ID)
		e.clock.Advance(7*24*time.Hour - time.Minute)
		if _, _, err := e.svc.Sessions.Lookup(ctx, c); err != nil {
			t.Fatalf("Lookup before idle TTL: %v", err)
		}
		// The previous lookup slid the idle window forward.
		e.clock.Advance(7*24*time.Hour - time.Minute)
		if _, _, err := e.svc.Sessions.Lookup(ctx, c); err != nil {
			t.Fatalf("Lookup after slide: %v", err)
		}
		e.clock.Advance(7*24*time.Hour + time.Second)
		if _, _, err := e.svc.Sessions.Lookup(ctx, c); !errors.Is(err, ErrNoSession) {
			t.Fatalf("Lookup after idle TTL: err = %v, want ErrNoSession", err)
		}
	})

	t.Run("absolute", func(t *testing.T) {
		e := newEnv(t, plainHasher{})
		u := e.mkUser(t, "a@example.com", "password-123456")
		c, _ := e.mkSession(t, u.ID)
		for elapsed := time.Duration(0); elapsed < 30*24*time.Hour-6*24*time.Hour; elapsed += 6 * 24 * time.Hour {
			e.clock.Advance(6 * 24 * time.Hour)
			if _, _, err := e.svc.Sessions.Lookup(ctx, c); err != nil {
				t.Fatalf("Lookup at %v: %v", elapsed, err)
			}
		}
		e.clock.Advance(6*24*time.Hour + time.Hour) // 30 d 1 h from creation, idle only 6 d 1 h
		if _, _, err := e.svc.Sessions.Lookup(ctx, c); !errors.Is(err, ErrNoSession) {
			t.Fatalf("Lookup after absolute TTL: err = %v, want ErrNoSession", err)
		}
	})

	t.Run("unknown and malformed", func(t *testing.T) {
		e := newEnv(t, plainHasher{})
		for _, c := range []string{"", "zz", hex.EncodeToString(make([]byte, 32))} {
			if _, _, err := e.svc.Sessions.Lookup(ctx, c); !errors.Is(err, ErrNoSession) {
				t.Errorf("Lookup(%q): err = %v, want ErrNoSession", c, err)
			}
		}
	})
}

func TestSessionStoredHashed(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	u := e.mkUser(t, "a@example.com", "password-123456")
	c, csrf := e.mkSession(t, u.ID)
	raw, err := hex.DecodeString(c)
	if err != nil || len(raw) != 32 {
		t.Fatalf("cookie %q is not 32 hex-encoded bytes", c)
	}
	if csrf == "" || csrf == c {
		t.Fatalf("csrf = %q, want random value distinct from cookie", csrf)
	}
	if _, err := e.st.Q().GetSession(ctx, c); err == nil {
		t.Fatal("session row found under the raw cookie value")
	}
	sum := sha256.Sum256(raw)
	row, err := e.st.Q().GetSession(ctx, hex.EncodeToString(sum[:]))
	if err != nil {
		t.Fatalf("GetSession(sha256(id)): %v", err)
	}
	if row.IDHash == c || row.UserID != u.ID {
		t.Errorf("row = %+v", row)
	}
	s, gotU, err := e.svc.Sessions.Lookup(ctx, c)
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if s.ID != row.IDHash || s.CSRF != csrf || gotU.ID != u.ID {
		t.Errorf("Lookup = %+v %+v", s, gotU)
	}
}

func TestDisableRevokesSessions(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	u := e.mkUser(t, "a@example.com", "password-123456")
	c1, _ := e.mkSession(t, u.ID)
	c2, _ := e.mkSession(t, u.ID)
	if err := e.svc.SetDisabled(ctx, u.ID, true); err != nil {
		t.Fatalf("SetDisabled: %v", err)
	}
	for _, c := range []string{c1, c2} {
		if _, _, err := e.svc.Sessions.Lookup(ctx, c); !errors.Is(err, ErrNoSession) {
			t.Errorf("Lookup after disable: err = %v, want ErrNoSession", err)
		}
	}
	// Even a session created behind the service's back is refused.
	c3, _ := e.mkSession(t, u.ID)
	if _, _, err := e.svc.Sessions.Lookup(ctx, c3); !errors.Is(err, ErrNoSession) {
		t.Errorf("Lookup of disabled user's new session: err = %v, want ErrNoSession", err)
	}
}

func TestPasswordChangeRevokesOtherSessions(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	u := e.mkUser(t, "a@example.com", "password-123456")
	cur, _ := e.mkSession(t, u.ID)
	other, _ := e.mkSession(t, u.ID)
	s, _, err := e.svc.Sessions.Lookup(ctx, cur)
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}

	if err := e.svc.ChangePassword(ctx, u.ID, s.ID, "wrong-password-1", "new-password-1234"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("ChangePassword with wrong current: err = %v, want ErrInvalidCredentials", err)
	}
	if err := e.svc.ChangePassword(ctx, u.ID, s.ID, "password-123456", "short"); !errors.Is(err, apperr.ErrInvalid) {
		t.Fatalf("ChangePassword too short: err = %v, want ErrInvalid", err)
	}
	if err := e.svc.ChangePassword(ctx, u.ID, s.ID, "password-123456", "new-password-1234"); err != nil {
		t.Fatalf("ChangePassword: %v", err)
	}
	if _, _, err := e.svc.Sessions.Lookup(ctx, cur); err != nil {
		t.Errorf("current session revoked: %v", err)
	}
	if _, _, err := e.svc.Sessions.Lookup(ctx, other); !errors.Is(err, ErrNoSession) {
		t.Errorf("other session: err = %v, want ErrNoSession", err)
	}
	if _, err := e.svc.Login(ctx, u.Email, "new-password-1234", "1.1.1.1", "ua"); err != nil {
		t.Errorf("Login with new password: %v", err)
	}

	// An admin reset revokes every session and forces a change.
	if err := e.svc.ResetPassword(ctx, u.ID, "temp-password-123"); err != nil {
		t.Fatalf("ResetPassword: %v", err)
	}
	if _, _, err := e.svc.Sessions.Lookup(ctx, cur); !errors.Is(err, ErrNoSession) {
		t.Errorf("session after reset: err = %v, want ErrNoSession", err)
	}
	got, err := e.svc.Login(ctx, u.Email, "temp-password-123", "1.1.1.1", "ua")
	if err != nil || !got.User.MustChangePassword {
		t.Errorf("Login after reset = %+v, %v; want MustChangePassword", got, err)
	}
}

func TestListOwnSessions(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	u := e.mkUser(t, "a@example.com", "password-123456")
	v := e.mkUser(t, "b@example.com", "password-123456")
	cur, _ := e.mkSession(t, u.ID)
	e.clock.Advance(time.Second)
	e.mkSession(t, u.ID)
	e.mkSession(t, v.ID)
	s, _, _ := e.svc.Sessions.Lookup(ctx, cur)

	list, err := e.svc.Sessions.ListForUser(ctx, u.ID, s.ID)
	if err != nil {
		t.Fatalf("ListForUser: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("len = %d, want 2", len(list))
	}
	currents := 0
	for _, si := range list {
		if len(si.ID) != 12 {
			t.Errorf("public id %q, want 12 hex chars", si.ID)
		}
		if si.ID == s.ID || si.IP != "10.0.0.1" || si.UA != "test-ua" || si.CreatedAt.IsZero() || si.LastSeenAt.IsZero() {
			t.Errorf("SessionInfo = %+v", si)
		}
		if si.Current {
			currents++
			if si.ID != s.ID[:12] {
				t.Errorf("current id = %q, want %q", si.ID, s.ID[:12])
			}
		}
	}
	if currents != 1 {
		t.Errorf("current sessions = %d, want 1", currents)
	}
}

func TestRevokeOtherSession(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	u := e.mkUser(t, "a@example.com", "password-123456")
	v := e.mkUser(t, "b@example.com", "password-123456")
	cur, _ := e.mkSession(t, u.ID)
	other, _ := e.mkSession(t, u.ID)
	vc, _ := e.mkSession(t, v.ID)
	cs, _, _ := e.svc.Sessions.Lookup(ctx, cur)
	os, _, _ := e.svc.Sessions.Lookup(ctx, other)
	vs, _, _ := e.svc.Sessions.Lookup(ctx, vc)

	if err := e.svc.Sessions.RevokeByPublicID(ctx, u.ID, vs.ID[:12]); !errors.Is(err, apperr.ErrNotFound) {
		t.Errorf("revoke another user's session: err = %v, want ErrNotFound", err)
	}
	if _, _, err := e.svc.Sessions.Lookup(ctx, vc); err != nil {
		t.Errorf("other user's session was revoked: %v", err)
	}
	for _, bad := range []string{"", "abc", "zzzzzzzzzzzz"} {
		if err := e.svc.Sessions.RevokeByPublicID(ctx, u.ID, bad); !errors.Is(err, apperr.ErrNotFound) {
			t.Errorf("RevokeByPublicID(%q): err = %v, want ErrNotFound", bad, err)
		}
	}
	if err := e.svc.Sessions.RevokeByPublicID(ctx, u.ID, os.ID[:12]); err != nil {
		t.Fatalf("RevokeByPublicID: %v", err)
	}
	if _, _, err := e.svc.Sessions.Lookup(ctx, other); !errors.Is(err, ErrNoSession) {
		t.Errorf("revoked session: err = %v, want ErrNoSession", err)
	}
	if _, _, err := e.svc.Sessions.Lookup(ctx, cur); err != nil {
		t.Errorf("current session: %v", err)
	}
	if err := e.svc.Sessions.Revoke(ctx, cs.ID); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if _, _, err := e.svc.Sessions.Lookup(ctx, cur); !errors.Is(err, ErrNoSession) {
		t.Errorf("after Revoke: err = %v, want ErrNoSession", err)
	}
}

func TestRevokeAllExceptCurrent(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	u := e.mkUser(t, "a@example.com", "password-123456")
	v := e.mkUser(t, "b@example.com", "password-123456")
	cur, _ := e.mkSession(t, u.ID)
	o1, _ := e.mkSession(t, u.ID)
	o2, _ := e.mkSession(t, u.ID)
	vc, _ := e.mkSession(t, v.ID)
	cs, _, _ := e.svc.Sessions.Lookup(ctx, cur)

	if err := e.svc.Sessions.RevokeAllForUser(ctx, u.ID, cs.ID); err != nil {
		t.Fatalf("RevokeAllForUser: %v", err)
	}
	if _, _, err := e.svc.Sessions.Lookup(ctx, cur); err != nil {
		t.Errorf("current: %v", err)
	}
	for _, c := range []string{o1, o2} {
		if _, _, err := e.svc.Sessions.Lookup(ctx, c); !errors.Is(err, ErrNoSession) {
			t.Errorf("other: err = %v, want ErrNoSession", err)
		}
	}
	if _, _, err := e.svc.Sessions.Lookup(ctx, vc); err != nil {
		t.Errorf("other user's session: %v", err)
	}
	if err := e.svc.Sessions.RevokeAllForUser(ctx, u.ID, ""); err != nil {
		t.Fatalf("RevokeAllForUser(all): %v", err)
	}
	if _, _, err := e.svc.Sessions.Lookup(ctx, cur); !errors.Is(err, ErrNoSession) {
		t.Errorf("current after revoke all: err = %v, want ErrNoSession", err)
	}
}
