package orgs

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/audit"
	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/store/db"
)

// Member is one org member with their project grants (project slug → role).
type Member struct {
	UserID string            `json:"user_id"`
	Email  string            `json:"email"`
	Name   string            `json:"name"`
	Role   string            `json:"role"`
	Grants map[string]string `json:"grants"`
}

var (
	orgRoles     = map[string]bool{authz.RoleOwner: true, authz.RoleAdmin: true, authz.RoleMember: true}
	projectRoles = map[string]bool{authz.RoleAdmin: true, authz.RoleDeveloper: true, authz.RoleViewer: true}
)

// Subject resolves userID's org role and project grants in orgID. A non-member gets an empty OrgRole.
func (s *Service) Subject(ctx context.Context, userID, orgID string) (authz.Subject, error) {
	q := s.st.Q()
	u, err := q.GetUserByID(ctx, userID)
	if errors.Is(err, sql.ErrNoRows) {
		return authz.Subject{}, fmt.Errorf("orgs: subject: user %s: %w", userID, apperr.ErrNotFound)
	} else if err != nil {
		return authz.Subject{}, fmt.Errorf("orgs: subject: %w", err)
	}
	sub := authz.Subject{UserID: userID, InstanceAdmin: u.IsInstanceAdmin != 0, ProjectRoles: map[string]string{}}
	m, err := q.GetMember(ctx, db.GetMemberParams{OrgID: orgID, UserID: userID})
	if errors.Is(err, sql.ErrNoRows) {
		return sub, nil
	} else if err != nil {
		return authz.Subject{}, fmt.Errorf("orgs: subject: %w", err)
	}
	sub.OrgRole = m.Role
	grants, err := q.ListGrantsForUser(ctx, db.ListGrantsForUserParams{OrgID: orgID, UserID: userID})
	if err != nil {
		return authz.Subject{}, fmt.Errorf("orgs: subject: grants: %w", err)
	}
	for _, g := range grants {
		sub.ProjectRoles[g.ProjectSlug] = g.Role
	}
	return sub, nil
}

// Members lists orgID's members with their grants.
func (s *Service) Members(ctx context.Context, orgID string) ([]Member, error) {
	q := s.st.Q()
	rows, err := q.ListMembers(ctx, orgID)
	if err != nil {
		return nil, fmt.Errorf("orgs: members: %w", err)
	}
	out := make([]Member, 0, len(rows))
	for _, r := range rows {
		m, err := s.member(ctx, q, orgID, r.UserID, r.Role)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, nil
}

// Member returns one member, or apperr.ErrNotFound.
func (s *Service) Member(ctx context.Context, orgID, userID string) (Member, error) {
	q := s.st.Q()
	r, err := q.GetMember(ctx, db.GetMemberParams{OrgID: orgID, UserID: userID})
	if errors.Is(err, sql.ErrNoRows) {
		return Member{}, fmt.Errorf("orgs: member %s: %w", userID, apperr.ErrNotFound)
	} else if err != nil {
		return Member{}, fmt.Errorf("orgs: member: %w", err)
	}
	return s.member(ctx, q, orgID, userID, r.Role)
}

func (s *Service) member(ctx context.Context, q *db.Queries, orgID, userID, role string) (Member, error) {
	u, err := q.GetUserByID(ctx, userID)
	if err != nil {
		return Member{}, fmt.Errorf("orgs: member user %s: %w", userID, err)
	}
	grants, err := q.ListGrantsForUser(ctx, db.ListGrantsForUserParams{OrgID: orgID, UserID: userID})
	if err != nil {
		return Member{}, fmt.Errorf("orgs: member grants: %w", err)
	}
	m := Member{UserID: userID, Email: u.Email, Name: u.Name, Role: role, Grants: map[string]string{}}
	for _, g := range grants {
		m.Grants[g.ProjectSlug] = g.Role
	}
	return m, nil
}

// AddMember adds userID to orgID with role. Needs members.manage, plus members.owners for role owner.
func (s *Service) AddMember(ctx context.Context, actor audit.Actor, sub authz.Subject, orgID, userID, role string) error {
	if !orgRoles[role] {
		return fmt.Errorf("orgs: add member: role %q: %w", role, apperr.ErrInvalid)
	}
	if err := canManage(sub, role == authz.RoleOwner); err != nil {
		return err
	}
	err := s.st.Tx(ctx, func(q *db.Queries) error {
		if _, err := q.GetUserByID(ctx, userID); errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("orgs: add member: user %s: %w", userID, apperr.ErrNotFound)
		} else if err != nil {
			return err
		}
		if _, err := q.GetMember(ctx, db.GetMemberParams{OrgID: orgID, UserID: userID}); err == nil {
			return apperr.Conflict{Code: "already_member"}
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if err := q.AddMember(ctx, db.AddMemberParams{OrgID: orgID, UserID: userID, Role: role}); err != nil {
			return err
		}
		return s.log().Log(ctx, q, actor, orgID, "member.add", userID, map[string]string{"role": role})
	})
	if err != nil {
		return fmt.Errorf("orgs: add member: %w", err)
	}
	return nil
}

// SetRole changes userID's org role. Needs members.manage, plus members.owners when the old or new role is
// owner. Demoting the last owner is apperr.Conflict{Code: "last_owner"}.
func (s *Service) SetRole(ctx context.Context, actor audit.Actor, sub authz.Subject, orgID, userID, role string) error {
	if !orgRoles[role] {
		return fmt.Errorf("orgs: set role: role %q: %w", role, apperr.ErrInvalid)
	}
	if err := canManage(sub, role == authz.RoleOwner); err != nil {
		return err
	}
	err := s.st.Tx(ctx, func(q *db.Queries) error {
		old, err := q.GetMember(ctx, db.GetMemberParams{OrgID: orgID, UserID: userID})
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("orgs: member %s: %w", userID, apperr.ErrNotFound)
		} else if err != nil {
			return err
		}
		if old.Role == role {
			return nil
		}
		if old.Role == authz.RoleOwner {
			if err := canManage(sub, true); err != nil {
				return err
			}
			if err := lastOwnerGuard(ctx, q, orgID); err != nil {
				return err
			}
		}
		if _, err := q.UpdateMemberRole(ctx, db.UpdateMemberRoleParams{Role: role, OrgID: orgID, UserID: userID}); err != nil {
			return err
		}
		return s.log().Log(ctx, q, actor, orgID, "member.role", userID, map[string]string{"from": old.Role, "to": role})
	})
	if err != nil {
		return fmt.Errorf("orgs: set role: %w", err)
	}
	return nil
}

// RemoveMember removes userID and their grants from orgID. Needs members.manage, plus members.owners for an
// owner. Removing the last owner is apperr.Conflict{Code: "last_owner"}.
func (s *Service) RemoveMember(ctx context.Context, actor audit.Actor, sub authz.Subject, orgID, userID string) error {
	if err := canManage(sub, false); err != nil {
		return err
	}
	err := s.st.Tx(ctx, func(q *db.Queries) error {
		old, err := q.GetMember(ctx, db.GetMemberParams{OrgID: orgID, UserID: userID})
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("orgs: member %s: %w", userID, apperr.ErrNotFound)
		} else if err != nil {
			return err
		}
		if old.Role == authz.RoleOwner {
			if err := canManage(sub, true); err != nil {
				return err
			}
			if err := lastOwnerGuard(ctx, q, orgID); err != nil {
				return err
			}
		}
		if _, err := q.DeleteGrantsForUser(ctx, db.DeleteGrantsForUserParams{OrgID: orgID, UserID: userID}); err != nil {
			return err
		}
		if _, err := q.RemoveMember(ctx, db.RemoveMemberParams{OrgID: orgID, UserID: userID}); err != nil {
			return err
		}
		return s.log().Log(ctx, q, actor, orgID, "member.remove", userID, map[string]string{"role": old.Role})
	})
	if err != nil {
		return fmt.Errorf("orgs: remove member: %w", err)
	}
	return nil
}

// SetGrant gives member userID role on the project projectSlug. Needs grants.manage on that project.
func (s *Service) SetGrant(ctx context.Context, actor audit.Actor, sub authz.Subject, orgID, userID, projectSlug, role string) error {
	if projectSlug == "" || !projectRoles[role] {
		return fmt.Errorf("orgs: set grant: project %q role %q: %w", projectSlug, role, apperr.ErrInvalid)
	}
	if !authz.Can(sub, authz.GrantsManage, projectSlug) {
		return fmt.Errorf("orgs: set grant: %w", apperr.ErrForbidden)
	}
	err := s.st.Tx(ctx, func(q *db.Queries) error {
		if _, err := q.GetMember(ctx, db.GetMemberParams{OrgID: orgID, UserID: userID}); errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("orgs: member %s: %w", userID, apperr.ErrNotFound)
		} else if err != nil {
			return err
		}
		if err := q.UpsertGrant(ctx, db.UpsertGrantParams{OrgID: orgID, UserID: userID, ProjectSlug: projectSlug, Role: role}); err != nil {
			return err
		}
		return s.log().Log(ctx, q, actor, orgID, "grant.set", userID, map[string]string{"project": projectSlug, "role": role})
	})
	if err != nil {
		return fmt.Errorf("orgs: set grant: %w", err)
	}
	return nil
}

// RemoveGrant drops userID's grant on projectSlug. Needs grants.manage on that project.
func (s *Service) RemoveGrant(ctx context.Context, actor audit.Actor, sub authz.Subject, orgID, userID, projectSlug string) error {
	if !authz.Can(sub, authz.GrantsManage, projectSlug) {
		return fmt.Errorf("orgs: remove grant: %w", apperr.ErrForbidden)
	}
	err := s.st.Tx(ctx, func(q *db.Queries) error {
		n, err := q.DeleteGrant(ctx, db.DeleteGrantParams{OrgID: orgID, UserID: userID, ProjectSlug: projectSlug})
		if err != nil {
			return err
		}
		if n == 0 {
			return fmt.Errorf("orgs: grant %s/%s: %w", userID, projectSlug, apperr.ErrNotFound)
		}
		return s.log().Log(ctx, q, actor, orgID, "grant.remove", userID, map[string]string{"project": projectSlug})
	})
	if err != nil {
		return fmt.Errorf("orgs: remove grant: %w", err)
	}
	return nil
}

func canManage(sub authz.Subject, owners bool) error {
	if !authz.Can(sub, authz.MembersManage, "") || (owners && !authz.Can(sub, authz.MembersOwners, "")) {
		return fmt.Errorf("orgs: members: %w", apperr.ErrForbidden)
	}
	return nil
}

// lastOwnerGuard refuses taking the owner role away from the only owner. Runs inside the mutating tx.
func lastOwnerGuard(ctx context.Context, q *db.Queries, orgID string) error {
	n, err := q.CountOwners(ctx, orgID)
	if err != nil {
		return err
	}
	if n <= 1 {
		return apperr.Conflict{Code: "last_owner"}
	}
	return nil
}
