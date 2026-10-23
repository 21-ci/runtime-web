package users

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/audit"
	"github.com/21cloud/runtime-web/internal/store/db"
)

// maxNameLen bounds a display name.
const maxNameLen = 200

// Patch is a partial user update. Nil fields are unchanged.
type Patch struct {
	Name          *string
	Disabled      *bool
	InstanceAdmin *bool
}

// Update applies p to userID in one transaction. Disabling a user revokes their sessions. The last
// enabled instance admin cannot be disabled or demoted.
func (s *Service) Update(ctx context.Context, actor audit.Actor, userID string, p Patch) (User, error) {
	var out User
	err := s.st.Tx(ctx, func(q *db.Queries) error {
		u, err := getUser(ctx, q, userID)
		if err != nil {
			return err
		}
		name := u.Name
		if p.Name != nil {
			name = strings.TrimSpace(*p.Name)
			if name == "" || len(name) > maxNameLen {
				return fmt.Errorf("users: name: %w", apperr.ErrInvalid)
			}
		}
		disabled := u.Disabled != 0
		if p.Disabled != nil {
			disabled = *p.Disabled
		}
		admin := u.IsInstanceAdmin != 0
		if p.InstanceAdmin != nil {
			admin = *p.InstanceAdmin
		}
		wasEnabledAdmin := u.IsInstanceAdmin != 0 && u.Disabled == 0
		if wasEnabledAdmin && !(admin && !disabled) {
			if err := guardLastAdmin(ctx, q); err != nil {
				return err
			}
		}
		now := s.now().UnixMilli()
		if p.Name != nil {
			if _, err := q.UpdateUserName(ctx, db.UpdateUserNameParams{Name: name, UpdatedAt: now, ID: userID}); err != nil {
				return err
			}
		}
		if p.InstanceAdmin != nil {
			if _, err := q.SetUserAdmin(ctx, db.SetUserAdminParams{IsInstanceAdmin: boolInt(admin), UpdatedAt: now, ID: userID}); err != nil {
				return err
			}
		}
		if p.Disabled != nil {
			if _, err := q.SetUserDisabled(ctx, db.SetUserDisabledParams{Disabled: boolInt(disabled), UpdatedAt: now, ID: userID}); err != nil {
				return err
			}
		}
		if disabled {
			if _, err := q.DeleteSessionsForUser(ctx, userID); err != nil {
				return err
			}
		}
		if err := s.log().Log(ctx, q, actor, "", "user.update", userID, map[string]any{
			"name": p.Name != nil, "disabled": p.Disabled != nil, "instance_admin": p.InstanceAdmin != nil,
		}); err != nil {
			return err
		}
		row, err := getUser(ctx, q, userID)
		if err != nil {
			return err
		}
		out = userFrom(row)
		return s.afterWrite()
	})
	if err != nil {
		return User{}, fmt.Errorf("users: update: %w", err)
	}
	return out, nil
}

// Delete soft-deletes a user. The row stays, so tokens, invites, version authors and audit rows keep
// their created_by and actor references. The email and name are replaced with an anonymous value,
// the password and 2FA are cleared, sessions and identities are revoked, and memberships and grants
// are removed. The last enabled instance admin and the sole owner of an org cannot be deleted.
func (s *Service) Delete(ctx context.Context, actor audit.Actor, userID string) error {
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
		if err := guardSoleOwner(ctx, q, userID); err != nil {
			return err
		}
		if _, err := q.DeleteMembershipsForUser(ctx, userID); err != nil {
			return err
		}
		if _, err := q.DeleteProjectGrantsForUser(ctx, userID); err != nil {
			return err
		}
		if _, err := q.DeleteUserTOTP(ctx, userID); err != nil {
			return err
		}
		if _, err := q.DeletePendingUserTOTP(ctx, userID); err != nil {
			return err
		}
		if _, err := q.DeleteRecoveryCodes(ctx, userID); err != nil {
			return err
		}
		if _, err := q.DeleteIdentitiesForUser(ctx, userID); err != nil {
			return err
		}
		if _, err := q.DeleteSessionsForUser(ctx, userID); err != nil {
			return err
		}
		anon := "deleted-" + userID + "@invalid"
		if _, err := q.AnonymizeUser(ctx, db.AnonymizeUserParams{
			Email: anon, Name: "Deleted user", UpdatedAt: s.now().UnixMilli(), ID: userID,
		}); err != nil {
			return err
		}
		if err := s.log().Log(ctx, q, actor, "", "user.delete", userID, nil); err != nil {
			return err
		}
		return s.afterWrite()
	})
	if err != nil {
		return fmt.Errorf("users: delete: %w", err)
	}
	return nil
}

// ResetTOTP removes the user's two-factor enrolment and recovery codes and revokes their sessions.
func (s *Service) ResetTOTP(ctx context.Context, actor audit.Actor, userID string) error {
	err := s.st.Tx(ctx, func(q *db.Queries) error {
		if _, err := getUser(ctx, q, userID); err != nil {
			return err
		}
		if _, err := q.DeleteUserTOTP(ctx, userID); err != nil {
			return err
		}
		if _, err := q.DeletePendingUserTOTP(ctx, userID); err != nil {
			return err
		}
		if _, err := q.DeleteRecoveryCodes(ctx, userID); err != nil {
			return err
		}
		if _, err := q.DeleteSessionsForUser(ctx, userID); err != nil {
			return err
		}
		if err := s.log().Log(ctx, q, actor, "", "user.reset_totp", userID, nil); err != nil {
			return err
		}
		return s.afterWrite()
	})
	if err != nil {
		return fmt.Errorf("users: reset totp: %w", err)
	}
	return nil
}

// guardSoleOwner refuses deleting a user who is the only owner of any org.
func guardSoleOwner(ctx context.Context, q *db.Queries, userID string) error {
	orgs, err := q.ListOrgsForUser(ctx, userID)
	if err != nil {
		return err
	}
	for _, o := range orgs {
		m, err := q.GetMember(ctx, db.GetMemberParams{OrgID: o.ID, UserID: userID})
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		if m.Role != "owner" {
			continue
		}
		n, err := q.CountOwners(ctx, o.ID)
		if err != nil {
			return err
		}
		if n <= 1 {
			return apperr.Conflict{Code: "last_owner"}
		}
	}
	return nil
}
