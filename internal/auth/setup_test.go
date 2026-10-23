package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"sync"
	"testing"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/config"
	"github.com/21cloud/runtime-web/internal/store"
)

func TestSetupOnlyOnce(t *testing.T) {
	ctx := context.Background()
	// A file database so the goroutines really use separate connections.
	st, err := store.Open(ctx, filepath.Join(t.TempDir(), "rtweb.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	svc := NewService(st, plainHasher{}, testSealer(), "tok", false)
	if !svc.SetupNeeded(ctx) {
		t.Fatal("SetupNeeded = false on empty db")
	}

	const n = 8
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := range n {
		wg.Go(func() {
			_, errs[i] = svc.Setup(ctx, "tok", fmt.Sprintf("admin%d@example.com", i), "Admin", "password-123456")
		})
	}
	wg.Wait()
	ok := 0
	for _, err := range errs {
		switch code, _ := apperr.ConflictCode(err); {
		case err == nil:
			ok++
		case code == "already_set_up":
		default:
			t.Errorf("unexpected err: %v", err)
		}
	}
	if ok != 1 {
		t.Fatalf("successful setups = %d, want 1 (%v)", ok, errs)
	}
	if svc.SetupNeeded(ctx) {
		t.Error("SetupNeeded = true after setup")
	}
	if n, _ := st.Q().CountUsers(ctx); n != 1 {
		t.Errorf("users = %d, want 1", n)
	}
	if _, err := svc.Setup(ctx, "tok", "late@example.com", "Late", "password-123456"); func() bool { c, _ := apperr.ConflictCode(err); return c != "already_set_up" }() {
		t.Errorf("late Setup: err = %v, want already_set_up", err)
	}
}

func TestSetupCreatesAdmin(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	if _, err := e.svc.Setup(ctx, "setup-token-for-tests", "root@example.com", "Root", "short"); !errors.Is(err, apperr.ErrInvalid) {
		t.Fatalf("short password: err = %v, want ErrInvalid", err)
	}
	u, err := e.svc.Setup(ctx, "setup-token-for-tests", "root@example.com", "Root", "password-123456")
	if err != nil {
		t.Fatal(err)
	}
	if !u.IsInstanceAdmin || u.MustChangePassword || u.Email != "root@example.com" {
		t.Errorf("user = %+v", u)
	}
	if _, err := e.svc.Login(ctx, "root@example.com", "password-123456", "1.1.1.1", "ua"); err != nil {
		t.Errorf("Login: %v", err)
	}
}

func TestSetupRequiresToken(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	for _, tok := range []string{"", "wrong", "setup-token-for-test", "setup-token-for-tests "} {
		_, err := e.svc.Setup(ctx, tok, "root@example.com", "Root", "password-123456")
		if code, _ := apperr.ForbiddenCode(err); code != "setup_token_invalid" || !errors.Is(err, apperr.ErrForbidden) {
			t.Errorf("token %q: err = %v, want forbidden setup_token_invalid", tok, err)
		}
	}
	if n, _ := e.st.Q().CountUsers(ctx); n != 0 {
		t.Errorf("users = %d, want 0", n)
	}

	// An empty configured token never matches.
	empty := NewService(e.st, plainHasher{}, testSealer(), "", false)
	if _, err := empty.Setup(ctx, "", "root@example.com", "Root", "password-123456"); !errors.Is(err, apperr.ErrForbidden) {
		t.Errorf("empty configured token: err = %v", err)
	}
}

func TestNewSetupToken(t *testing.T) {
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.DiscardHandler))
	t.Cleanup(func() { slog.SetDefault(prev) })
	if got := NewSetupToken(config.Config{SetupToken: "from-env"}); got != "from-env" {
		t.Errorf("configured: %q", got)
	}
	a, b := NewSetupToken(config.Config{}), NewSetupToken(config.Config{})
	if len(a) < 32 || a == b {
		t.Errorf("generated tokens %q %q: want long and random", a, b)
	}
}
