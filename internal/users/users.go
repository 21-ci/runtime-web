// Package users is the instance-admin service for user accounts: create with a temporary password,
// list, disable, grant or revoke instance admin, and reset passwords.
package users

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base32"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/audit"
	"github.com/21cloud/runtime-web/internal/auth"
	"github.com/21cloud/runtime-web/internal/store"
	"github.com/21cloud/runtime-web/internal/store/db"
)

// tempPasswordLen is the length of generated temporary passwords.
const tempPasswordLen = 20

// User is an account as seen by instance admins.
type User struct {
	ID                 string
	Email              string
	Name               string
	IsInstanceAdmin    bool
	Disabled           bool
	MustChangePassword bool
	CreatedAt          int64
}

// Service manages user accounts.
type Service struct {
	st     *store.Store
	hasher auth.Hasher
	now    func() time.Time
	// hookAfterWrite is a test seam run last in each write tx; an error rolls the tx back.
	hookAfterWrite func() error
}

func (s *Service) log() audit.Writer { return audit.Writer{Now: s.now} }

func (s *Service) afterWrite() error {
	if s.hookAfterWrite != nil {
		return s.hookAfterWrite()
	}
	return nil
}

// New returns a users Service.
func New(st *store.Store, hasher auth.Hasher) *Service {
	return &Service{st: st, hasher: hasher, now: time.Now}
}

// Create adds a user with a random temporary password that must be changed at first login. The
// temporary password is returned once.
func (s *Service) Create(ctx context.Context, actor audit.Actor, email, name string, admin bool) (User, string, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	name = strings.TrimSpace(name)
	if !strings.Contains(email, "@") || name == "" {
		return User{}, "", fmt.Errorf("users: create: email and name required: %w", apperr.ErrInvalid)
	}
	temp, err := tempPassword()
	if err != nil {
		return User{}, "", fmt.Errorf("users: create: %w", err)
	}
	hash, err := s.hasher.Hash(temp)
	if err != nil {
		return User{}, "", fmt.Errorf("users: create: hash: %w", err)
	}
	now := s.now().UnixMilli()
	u := User{
		ID: store.NewID("usr_"), Email: email, Name: name, IsInstanceAdmin: admin,
		MustChangePassword: true, CreatedAt: now,
	}
	err = s.st.Tx(ctx, func(q *db.Queries) error {
		if _, err := q.GetUserByEmail(ctx, email); err == nil {
			return apperr.Conflict{Code: "email_taken"}
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if err := q.CreateUser(ctx, db.CreateUserParams{
			ID: u.ID, Email: email, Name: name, PasswordHash: hash,
			MustChangePassword: 1, IsInstanceAdmin: boolInt(admin), Disabled: 0,
			CreatedAt: now, UpdatedAt: now,
		}); err != nil {
			return err
		}
		return s.log().Log(ctx, q, actor, "", "user.create", u.ID, map[string]any{"email": email, "admin": admin})
	})
	if err != nil {
		return User{}, "", fmt.Errorf("users: create: %w", err)
	}
	return u, temp, nil
}

// List returns every user, oldest first.
func (s *Service) List(ctx context.Context) ([]User, error) {
	rows, err := s.st.Q().ListUsers(ctx)
	if err != nil {
		return nil, fmt.Errorf("users: list: %w", err)
	}
	out := make([]User, 0, len(rows))
	for _, r := range rows {
		out = append(out, userFrom(r))
	}
	return out, nil
}

// Disable blocks a user from logging in and revokes all of their sessions. The last enabled instance
// admin cannot be disabled.
func (s *Service) Disable(ctx context.Context, actor audit.Actor, userID string) error {
	err := s.st.Tx(ctx, func(q *db.Queries) error {
		u, err := getUser(ctx, q, userID)
		if err != nil {
			return err
		}
		if u.IsInstanceAdmin != 0 && u.Disabled == 0 {
			if err := guardLastAdmin(ctx, q); err != nil {
				return err
			}
		}
		if _, err := q.SetUserDisabled(ctx, db.SetUserDisabledParams{Disabled: 1, UpdatedAt: s.now().UnixMilli(), ID: userID}); err != nil {
			return err
		}
		if _, err := q.DeleteSessionsForUser(ctx, userID); err != nil {
			return err
		}
		if err := s.log().Log(ctx, q, actor, "", "user.disable", userID, nil); err != nil {
			return err
		}
		return s.afterWrite()
	})
	if err != nil {
		return fmt.Errorf("users: disable: %w", err)
	}
	return nil
}

// SetAdmin grants or revokes instance admin. Revoking the last enabled instance admin is refused.
func (s *Service) SetAdmin(ctx context.Context, actor audit.Actor, userID string, admin bool) error {
	err := s.st.Tx(ctx, func(q *db.Queries) error {
		u, err := getUser(ctx, q, userID)
		if err != nil {
			return err
		}
		if !admin && u.IsInstanceAdmin != 0 && u.Disabled == 0 {
			if err := guardLastAdmin(ctx, q); err != nil {
				return err
			}
		}
		if _, err := q.SetUserAdmin(ctx, db.SetUserAdminParams{IsInstanceAdmin: boolInt(admin), UpdatedAt: s.now().UnixMilli(), ID: userID}); err != nil {
			return err
		}
		return s.log().Log(ctx, q, actor, "", "user.set_admin", userID, map[string]bool{"admin": admin})
	})
	if err != nil {
		return fmt.Errorf("users: set admin: %w", err)
	}
	return nil
}

// ResetPassword replaces the user's password with a new temporary one, forces a change at next
// login, and revokes all sessions. The temporary password is returned once.
func (s *Service) ResetPassword(ctx context.Context, actor audit.Actor, userID string) (string, error) {
	temp, err := tempPassword()
	if err != nil {
		return "", fmt.Errorf("users: reset password: %w", err)
	}
	hash, err := s.hasher.Hash(temp)
	if err != nil {
		return "", fmt.Errorf("users: reset password: hash: %w", err)
	}
	err = s.st.Tx(ctx, func(q *db.Queries) error {
		if _, err := getUser(ctx, q, userID); err != nil {
			return err
		}
		if _, err := q.UpdateUserPassword(ctx, db.UpdateUserPasswordParams{
			PasswordHash: hash, MustChangePassword: 1, UpdatedAt: s.now().UnixMilli(), ID: userID,
		}); err != nil {
			return err
		}
		if _, err := q.DeleteSessionsForUser(ctx, userID); err != nil {
			return err
		}
		if err := s.log().Log(ctx, q, actor, "", "user.reset_password", userID, nil); err != nil {
			return err
		}
		return s.afterWrite()
	})
	if err != nil {
		return "", fmt.Errorf("users: reset password: %w", err)
	}
	return temp, nil
}

func getUser(ctx context.Context, q *db.Queries, id string) (db.User, error) {
	u, err := q.GetUserByID(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return db.User{}, fmt.Errorf("users: %s: %w", id, apperr.ErrNotFound)
	}
	return u, err
}

// guardLastAdmin refuses a change that would leave no enabled instance admin.
func guardLastAdmin(ctx context.Context, q *db.Queries) error {
	n, err := q.CountEnabledAdmins(ctx)
	if err != nil {
		return err
	}
	if n <= 1 {
		return apperr.Conflict{Code: "last_admin"}
	}
	return nil
}

// tempPassword returns tempPasswordLen random base32 characters.
func tempPassword() (string, error) {
	buf := make([]byte, tempPasswordLen)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("temp password: %w", err)
	}
	enc := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(buf)
	return enc[:tempPasswordLen], nil
}

func userFrom(r db.User) User {
	return User{
		ID:                 r.ID,
		Email:              r.Email,
		Name:               r.Name,
		IsInstanceAdmin:    r.IsInstanceAdmin != 0,
		Disabled:           r.Disabled != 0,
		MustChangePassword: r.MustChangePassword != 0,
		CreatedAt:          r.CreatedAt,
	}
}

func boolInt(b bool) int64 {
	if b {
		return 1
	}
	return 0
}
