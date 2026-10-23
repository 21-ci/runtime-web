package auth

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/21cloud/runtime-web/internal/store"
	"github.com/21cloud/runtime-web/internal/store/db"
)

// plainHasher is a fast test Hasher; it is not a real password hash.
type plainHasher struct{}

func (plainHasher) Hash(p string) (string, error) { return "plain$" + p, nil }
func (plainHasher) Verify(hash, p string) bool {
	return strings.HasPrefix(hash, "plain$") && hash == "plain$"+p
}

// spyHasher counts Verify calls and the hashes they were given.
type spyHasher struct {
	plainHasher
	mu     sync.Mutex
	hashes []string
}

func (s *spyHasher) Verify(hash, p string) bool {
	s.mu.Lock()
	s.hashes = append(s.hashes, hash)
	s.mu.Unlock()
	return s.plainHasher.Verify(hash, p)
}

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *fakeClock { return &fakeClock{t: time.UnixMilli(1_700_000_000_000)} }

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func newStore(t *testing.T) *store.Store {
	t.Helper()
	s, err := store.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

type env struct {
	st    *store.Store
	clock *fakeClock
	svc   *Service
}

func newEnv(t *testing.T, h Hasher) *env {
	t.Helper()
	st := newStore(t)
	clock := newClock()
	svc := NewService(st, h, "setup-token-for-tests", false)
	svc.SetNow(clock.Now)
	return &env{st: st, clock: clock, svc: svc}
}

func (e *env) mkUser(t *testing.T, email, password string) db.User {
	t.Helper()
	hash, err := e.svc.Hasher.Hash(password)
	if err != nil {
		t.Fatalf("Hash: %v", err)
	}
	u := db.User{ID: store.NewID("usr_"), Email: email, Name: "Test", PasswordHash: hash}
	err = e.st.Q().CreateUser(context.Background(), db.CreateUserParams{
		ID: u.ID, Email: u.Email, Name: u.Name, PasswordHash: u.PasswordHash, CreatedAt: 1, UpdatedAt: 1,
	})
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	return u
}

func (e *env) mkSession(t *testing.T, userID string) (cookie, csrf string) {
	t.Helper()
	cookie, csrf, err := e.svc.Sessions.Create(context.Background(), userID, "10.0.0.1", "test-ua")
	if err != nil {
		t.Fatalf("Sessions.Create: %v", err)
	}
	return cookie, csrf
}
