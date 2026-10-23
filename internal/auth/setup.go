package auth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"fmt"
	"log/slog"
	"strings"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/config"
	"github.com/21cloud/runtime-web/internal/store"
	"github.com/21cloud/runtime-web/internal/store/db"
)

// ErrSetupTokenInvalid is returned by Setup for a missing or wrong token.
var ErrSetupTokenInvalid = apperr.Forbidden{Code: "setup_token_invalid"}

// NewSetupToken returns cfg.SetupToken, or when unset a random one-time
// token, logged once at WARN so the operator can finish first-run setup.
func NewSetupToken(cfg config.Config) string {
	if cfg.SetupToken != "" {
		return cfg.SetupToken
	}
	tok, err := randomHex(24)
	if err != nil {
		panic(fmt.Sprintf("auth: setup token: %v", err))
	}
	slog.Warn("auth: RTWEB_SETUP_TOKEN not set; use this one-time token for first-run setup", "setup_token", tok)
	return tok
}

// SetupNeeded reports whether no user exists yet.
func (s *Service) SetupNeeded(ctx context.Context) bool {
	n, err := s.Store.Q().CountUsers(ctx)
	return err == nil && n == 0
}

func (s *Service) setupTokenOK(got string) bool {
	if s.SetupToken == "" || got == "" {
		return false
	}
	a, b := sha256.Sum256([]byte(got)), sha256.Sum256([]byte(s.SetupToken))
	return subtle.ConstantTimeCompare(a[:], b[:]) == 1
}

// Setup creates the first user as instance admin. It needs the setup
// token, and returns apperr.Conflict{"already_set_up"} once any user exists;
// the insert is a single conditional statement, so concurrent calls cannot
// both succeed.
func (s *Service) Setup(ctx context.Context, setupToken, email, name, password string) (User, error) {
	if !s.setupTokenOK(setupToken) {
		return User{}, ErrSetupTokenInvalid
	}
	email = normalizeEmail(email)
	name = strings.TrimSpace(name)
	if email == "" || !strings.Contains(email, "@") || name == "" {
		return User{}, fmt.Errorf("auth: setup: email and name required: %w", apperr.ErrInvalid)
	}
	if err := ValidatePassword(password); err != nil {
		return User{}, err
	}
	if !s.SetupNeeded(ctx) {
		return User{}, apperr.Conflict{Code: "already_set_up"}
	}
	hash, err := s.Hasher.Hash(password)
	if err != nil {
		return User{}, fmt.Errorf("auth: hash password: %w", err)
	}
	id := store.NewID("usr_")
	n, err := s.Store.Q().CreateFirstUser(ctx, db.CreateFirstUserParams{
		ID: id, Email: email, Name: name, PasswordHash: hash, CreatedAt: s.now().UnixMilli(),
	})
	if err != nil {
		// A concurrent writer may have won; report that as the conflict.
		if !s.SetupNeeded(ctx) {
			return User{}, apperr.Conflict{Code: "already_set_up"}
		}
		return User{}, fmt.Errorf("auth: create first user: %w", err)
	}
	if n == 0 {
		return User{}, apperr.Conflict{Code: "already_set_up"}
	}
	return User{ID: id, Email: email, Name: name, IsInstanceAdmin: true}, nil
}
