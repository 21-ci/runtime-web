package auth

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/store"
	"github.com/21cloud/runtime-web/internal/store/db"
)

// ErrInvalidCredentials is the single login failure for unknown users,
// wrong passwords and disabled users, so callers cannot tell them apart.
var ErrInvalidCredentials = errors.New("auth: invalid email or password")

// Service ties passwords, sessions, rate limiting, login history and setup
// together.
type Service struct {
	Store    *store.Store
	Hasher   Hasher
	Sessions *Sessions
	Events   *LoginEvents
	Limiter  *Limiter
	// SetupToken is the token Setup requires (see NewSetupToken).
	SetupToken string
	Now        func() time.Time

	dummyOnce sync.Once
	dummyHash string
}

// NewService wires a Service on st. dev selects the dev session cookie.
func NewService(st *store.Store, h Hasher, setupToken string, dev bool) *Service {
	q := st.Q()
	return &Service{
		Store:      st,
		Hasher:     h,
		Sessions:   &Sessions{Q: q, Dev: dev},
		Events:     &LoginEvents{Q: q},
		Limiter:    &Limiter{Q: q},
		SetupToken: setupToken,
	}
}

// SetNow replaces the clock of the service and its parts.
func (s *Service) SetNow(now func() time.Time) {
	s.Now = now
	s.Sessions.Now = now
	s.Events.Now = now
	s.Limiter.Now = now
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// dummy returns a real hash of a random value, verified for unknown users
// so they cost the same as known ones.
func (s *Service) dummy() string {
	s.dummyOnce.Do(func() {
		tok, err := randomHex(16)
		if err == nil {
			s.dummyHash, _ = s.Hasher.Hash(tok)
		}
		if s.dummyHash == "" {
			s.dummyHash = "$argon2id$v=19$m=65536,t=3,p=2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
		}
	})
	return s.dummyHash
}

func normalizeEmail(e string) string {
	return strings.ToLower(strings.TrimSpace(e))
}

// Login checks email and password. Unknown user, wrong password and
// disabled user all return ErrInvalidCredentials; 10 failures per 15 min
// per (ip, email) return apperr.ErrRateLimited. Every attempt is recorded.
// It does not create a session.
func (s *Service) Login(ctx context.Context, email, password, ip, ua string) (User, error) {
	email = normalizeEmail(email)
	ev := LoginEvent{Email: email, IP: ip, UA: ua, Method: MethodPassword}

	blocked, err := s.Limiter.Blocked(ctx, ip, email)
	if err != nil {
		return User{}, err
	}
	if blocked {
		if row, err := s.Store.Q().GetUserByEmail(ctx, email); err == nil {
			ev.UserID = row.ID
		}
		ev.Result = ResultRateLimited
		if err := s.Events.Record(ctx, ev); err != nil {
			return User{}, err
		}
		return User{}, fmt.Errorf("auth: login: %w", apperr.ErrRateLimited)
	}

	row, err := s.Store.Q().GetUserByEmail(ctx, email)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		s.Hasher.Verify(s.dummy(), password)
		return User{}, s.fail(ctx, ev, ResultBadPassword)
	case err != nil:
		return User{}, fmt.Errorf("auth: get user: %w", err)
	}
	ev.UserID = row.ID
	ok := s.Hasher.Verify(row.PasswordHash, password)
	if !ok {
		return User{}, s.fail(ctx, ev, ResultBadPassword)
	}
	if row.Disabled != 0 {
		return User{}, s.fail(ctx, ev, ResultDisabled)
	}
	if err := s.Limiter.Reset(ctx, ip, email); err != nil {
		return User{}, err
	}
	ev.Result = ResultOK
	if err := s.Events.Record(ctx, ev); err != nil {
		return User{}, err
	}
	return userFromRow(row), nil
}

func (s *Service) fail(ctx context.Context, ev LoginEvent, result string) error {
	if err := s.Limiter.Fail(ctx, ev.IP, ev.Email); err != nil {
		return err
	}
	ev.Result = result
	if err := s.Events.Record(ctx, ev); err != nil {
		return err
	}
	return ErrInvalidCredentials
}

// ChangePassword sets a new password after checking the current one, and
// revokes every other session of the user.
func (s *Service) ChangePassword(ctx context.Context, userID, currentSessionID, current, next string) error {
	row, err := s.Store.Q().GetUserByID(ctx, userID)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("auth: user: %w", apperr.ErrNotFound)
	}
	if err != nil {
		return fmt.Errorf("auth: get user: %w", err)
	}
	if !s.Hasher.Verify(row.PasswordHash, current) {
		return ErrInvalidCredentials
	}
	if err := s.setPassword(ctx, userID, next, false); err != nil {
		return err
	}
	return s.Sessions.RevokeAllForUser(ctx, userID, currentSessionID)
}

// ResetPassword sets a temporary password the user must change, and
// revokes all of the user's sessions.
func (s *Service) ResetPassword(ctx context.Context, userID, temp string) error {
	if err := s.setPassword(ctx, userID, temp, true); err != nil {
		return err
	}
	return s.Sessions.RevokeAllForUser(ctx, userID, "")
}

func (s *Service) setPassword(ctx context.Context, userID, p string, mustChange bool) error {
	if err := ValidatePassword(p); err != nil {
		return err
	}
	hash, err := s.Hasher.Hash(p)
	if err != nil {
		return fmt.Errorf("auth: hash password: %w", err)
	}
	var must int64
	if mustChange {
		must = 1
	}
	n, err := s.Store.Q().UpdateUserPassword(ctx, db.UpdateUserPasswordParams{
		PasswordHash: hash, MustChangePassword: must, UpdatedAt: s.now().UnixMilli(), ID: userID,
	})
	if err != nil {
		return fmt.Errorf("auth: update password: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("auth: user: %w", apperr.ErrNotFound)
	}
	return nil
}

// SetDisabled disables or enables a user; disabling revokes all sessions.
func (s *Service) SetDisabled(ctx context.Context, userID string, disabled bool) error {
	var d int64
	if disabled {
		d = 1
	}
	n, err := s.Store.Q().SetUserDisabled(ctx, db.SetUserDisabledParams{Disabled: d, UpdatedAt: s.now().UnixMilli(), ID: userID})
	if err != nil {
		return fmt.Errorf("auth: set disabled: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("auth: user: %w", apperr.ErrNotFound)
	}
	if disabled {
		return s.Sessions.RevokeAllForUser(ctx, userID, "")
	}
	return nil
}
