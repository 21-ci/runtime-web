// Package invites issues expiring, single-use invite links and accepts them. An accepted invite
// creates the user (or sets the password of the existing user with that email) and adds the
// membership the invite is bound to. Login, MFA and policy checks run afterwards, on the normal login path.
package invites

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/audit"
	"github.com/21cloud/runtime-web/internal/auth"
	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/store"
	"github.com/21cloud/runtime-web/internal/store/db"
	"github.com/21cloud/runtime-web/internal/users"
)

const (
	ttl        = 7 * 24 * time.Hour
	tokenBytes = 32
	// defaultRole is the membership role of an org-bound invite that names no role.
	defaultRole = authz.RoleMember
)

// OrgRef is the org an invite is bound to.
type OrgRef struct {
	Slug string
	Name string
}

// Invite is a pending or settled invite. The token is never part of it; it is returned once by Create.
type Invite struct {
	ID            string
	Email         string
	Org           *OrgRef
	Role          *string
	CreatedBy     string
	CreatedByName string
	CreatedAt     int64
	ExpiresAt     int64
}

// Service manages invites.
type Service struct {
	st        *store.Store
	hasher    auth.Hasher
	publicURL string
	now       func() time.Time
}

// New returns an invites Service. publicURL is the console base URL used to build invite links.
func New(st *store.Store, hasher auth.Hasher, publicURL string) *Service {
	return &Service{st: st, hasher: hasher, publicURL: strings.TrimRight(publicURL, "/"), now: time.Now}
}

func (s *Service) log() audit.Writer { return audit.Writer{Now: s.now} }

// Create issues an invite for email. With orgID nil the invite is unbound and only an instance admin
// may create it. With orgID set the actor needs invites.manage in that org, and granting the owner
// role also needs members.owners. A nil role means member. The link (shown once) carries the token.
func (s *Service) Create(ctx context.Context, actor audit.Actor, email string, orgID, role *string) (Invite, string, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if !strings.Contains(email, "@") {
		return Invite{}, "", fmt.Errorf("invites: create: email required: %w", apperr.ErrInvalid)
	}
	if role != nil && !validRole(*role) {
		return Invite{}, "", fmt.Errorf("invites: create: role %q: %w", *role, apperr.ErrInvalid)
	}
	if orgID == nil && role != nil {
		return Invite{}, "", fmt.Errorf("invites: create: role needs an org: %w", apperr.ErrInvalid)
	}
	token, err := newToken()
	if err != nil {
		return Invite{}, "", fmt.Errorf("invites: create: %w", err)
	}
	now := s.now()
	inv := Invite{
		ID: store.NewID("inv_"), Email: email, CreatedBy: actor.UserID,
		CreatedAt: now.UnixMilli(), ExpiresAt: now.Add(ttl).UnixMilli(),
	}
	var rowOrg, rowRole sql.NullString
	orgAudit := ""
	err = s.st.Tx(ctx, func(q *db.Queries) error {
		if orgID == nil {
			if err := authorize(ctx, q, actor, "", ""); err != nil {
				return err
			}
		} else {
			org, err := q.GetOrgByID(ctx, *orgID)
			if errors.Is(err, sql.ErrNoRows) {
				return fmt.Errorf("invites: create: org %s: %w", *orgID, apperr.ErrNotFound)
			}
			if err != nil {
				return err
			}
			r := defaultRole
			if role != nil {
				r = *role
			}
			if err := authorize(ctx, q, actor, org.ID, r); err != nil {
				return err
			}
			inv.Org = &OrgRef{Slug: org.Slug, Name: org.Name}
			inv.Role = &r
			rowOrg = sql.NullString{String: org.ID, Valid: true}
			rowRole = sql.NullString{String: r, Valid: true}
			orgAudit = org.ID
		}
		creator, err := q.GetUserByID(ctx, actor.UserID)
		if err != nil {
			return fmt.Errorf("invites: create: creator: %w", err)
		}
		inv.CreatedByName = creator.Name
		if err := q.CreateInvite(ctx, db.CreateInviteParams{
			ID: inv.ID, Email: email, OrgID: rowOrg, Role: rowRole, TokenHash: hashToken(token),
			ExpiresAt: inv.ExpiresAt, CreatedBy: actor.UserID, CreatedAt: inv.CreatedAt,
		}); err != nil {
			return err
		}
		return s.log().Log(ctx, q, actor, orgAudit, "invite.create", inv.ID, map[string]any{"email": email, "role": roleOrNil(inv.Role)})
	})
	if err != nil {
		return Invite{}, "", fmt.Errorf("invites: create: %w", err)
	}
	return inv, s.publicURL + "/invite/" + token, nil
}

// List returns pending invites (unused, unrevoked, unexpired), oldest first. A nil orgID lists
// every org and unbound invites. The caller checks the actor's access.
func (s *Service) List(ctx context.Context, orgID *string) ([]Invite, error) {
	nowAt := s.now().UnixMilli()
	if orgID == nil {
		rows, err := s.st.Q().ListPendingInvites(ctx, nowAt)
		if err != nil {
			return nil, fmt.Errorf("invites: list: %w", err)
		}
		out := make([]Invite, 0, len(rows))
		for _, r := range rows {
			out = append(out, fromRow(r.ID, r.Email, r.OrgID, r.Role, r.OrgSlug, r.OrgName, r.CreatedBy, r.CreatorName, r.CreatedAt, r.ExpiresAt))
		}
		return out, nil
	}
	rows, err := s.st.Q().ListPendingInvitesByOrg(ctx, db.ListPendingInvitesByOrgParams{
		NowAt: nowAt, OrgID: sql.NullString{String: *orgID, Valid: true},
	})
	if err != nil {
		return nil, fmt.Errorf("invites: list: %w", err)
	}
	out := make([]Invite, 0, len(rows))
	for _, r := range rows {
		out = append(out, fromRow(r.ID, r.Email, r.OrgID, r.Role, r.OrgSlug, r.OrgName, r.CreatedBy, r.CreatorName, r.CreatedAt, r.ExpiresAt))
	}
	return out, nil
}

// Revoke cancels a pending invite. Unknown, settled, expired and invisible invites (the actor is not
// a member of the bound org) return apperr.ErrNotFound; a known invite the actor may not manage returns ErrForbidden.
func (s *Service) Revoke(ctx context.Context, actor audit.Actor, id string) error {
	err := s.st.Tx(ctx, func(q *db.Queries) error {
		row, err := q.GetInviteByID(ctx, id)
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("invites: revoke %s: %w", id, apperr.ErrNotFound)
		}
		if err != nil {
			return err
		}
		now := s.now().UnixMilli()
		if row.UsedAt.Valid || row.RevokedAt.Valid || now >= row.ExpiresAt {
			return fmt.Errorf("invites: revoke %s: not pending: %w", id, apperr.ErrNotFound)
		}
		orgID := ""
		if row.OrgID.Valid {
			orgID = row.OrgID.String
		}
		if err := authorize(ctx, q, actor, orgID, row.Role.String); err != nil {
			return err
		}
		n, err := q.RevokeInvite(ctx, db.RevokeInviteParams{RevokedAt: sql.NullInt64{Int64: now, Valid: true}, ID: id})
		if err != nil {
			return err
		}
		if n != 1 {
			return fmt.Errorf("invites: revoke %s: %w", id, apperr.ErrNotFound)
		}
		return s.log().Log(ctx, q, actor, orgID, "invite.revoke", id, nil)
	})
	if err != nil {
		return fmt.Errorf("invites: revoke: %w", err)
	}
	return nil
}

// Accept redeems a token once. It creates the user with name, or, when an account with the invite's
// email exists, sets that user's password and keeps its name. It then adds the bound membership. It
// does not start a session: the user logs in next, and the MFA and policy checks run there.
// Expired, used and revoked tokens return apperr.NotFound with code invite_invalid.
func (s *Service) Accept(ctx context.Context, token, name, password string) (users.User, error) {
	if err := auth.ValidatePassword(password); err != nil {
		return users.User{}, fmt.Errorf("invites: accept: %w", err)
	}
	hash, err := s.hasher.Hash(password)
	if err != nil {
		return users.User{}, fmt.Errorf("invites: accept: hash: %w", err)
	}
	name = strings.TrimSpace(name)
	var out users.User
	err = s.st.Tx(ctx, func(q *db.Queries) error {
		row, err := q.GetInviteByTokenHash(ctx, hashToken(token))
		if errors.Is(err, sql.ErrNoRows) {
			return invalidInvite()
		}
		if err != nil {
			return err
		}
		now := s.now()
		nowMs := now.UnixMilli()
		if row.UsedAt.Valid || row.RevokedAt.Valid || nowMs >= row.ExpiresAt {
			return invalidInvite()
		}
		acct, err := q.GetUserByEmail(ctx, row.Email)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			if name == "" {
				return fmt.Errorf("invites: accept: name required: %w", apperr.ErrInvalid)
			}
			acct = db.User{ID: store.NewID("usr_"), Email: row.Email, Name: name, CreatedAt: nowMs}
			if err := q.CreateUser(ctx, db.CreateUserParams{
				ID: acct.ID, Email: acct.Email, Name: acct.Name, PasswordHash: hash,
				MustChangePassword: 0, IsInstanceAdmin: 0, Disabled: 0, CreatedAt: nowMs, UpdatedAt: nowMs,
			}); err != nil {
				return err
			}
		case err != nil:
			return err
		default:
			if acct.Disabled != 0 {
				return fmt.Errorf("invites: accept: account disabled: %w", apperr.Forbidden{Code: "account_disabled"})
			}
			if _, err := q.UpdateUserPassword(ctx, db.UpdateUserPasswordParams{
				PasswordHash: hash, MustChangePassword: 0, UpdatedAt: nowMs, ID: acct.ID,
			}); err != nil {
				return err
			}
		}
		n, err := q.MarkInviteUsed(ctx, db.MarkInviteUsedParams{UsedAt: sql.NullInt64{Int64: nowMs, Valid: true}, ID: row.ID})
		if err != nil {
			return err
		}
		if n != 1 {
			return invalidInvite()
		}
		orgAudit := ""
		if row.OrgID.Valid {
			orgAudit = row.OrgID.String
			if err := addMembership(ctx, q, row.OrgID.String, acct.ID, roleOf(row.Role)); err != nil {
				return err
			}
		}
		actor := audit.Actor{UserID: acct.ID}
		if err := s.log().Log(ctx, q, actor, orgAudit, "invite.accept", row.ID, map[string]string{"email": row.Email}); err != nil {
			return err
		}
		out = users.User{
			ID: acct.ID, Email: acct.Email, Name: acct.Name, IsInstanceAdmin: acct.IsInstanceAdmin != 0,
			Disabled: acct.Disabled != 0, MustChangePassword: false, CreatedAt: acct.CreatedAt,
		}
		return nil
	})
	if err != nil {
		return users.User{}, fmt.Errorf("invites: accept: %w", err)
	}
	return out, nil
}

// authorize checks that actor may manage invites that grant role in orgID. An empty orgID means an
// unbound invite, which only an instance admin may manage. A non-member of the org gets ErrNotFound;
// a member without invites.manage, or without members.owners for the owner role, gets ErrForbidden.
func authorize(ctx context.Context, q *db.Queries, actor audit.Actor, orgID, role string) error {
	sub := authz.Subject{UserID: actor.UserID, InstanceAdmin: actor.AsInstanceAdmin}
	if orgID != "" {
		m, err := q.GetMember(ctx, db.GetMemberParams{OrgID: orgID, UserID: actor.UserID})
		switch {
		case errors.Is(err, sql.ErrNoRows):
			if !actor.AsInstanceAdmin {
				return fmt.Errorf("invites: org %s: %w", orgID, apperr.ErrNotFound)
			}
		case err != nil:
			return err
		default:
			sub.OrgRole = m.Role
		}
	}
	if !authz.Can(sub, authz.InvitesManage, "") {
		return fmt.Errorf("invites: manage: %w", apperr.ErrForbidden)
	}
	if role == authz.RoleOwner && !authz.Can(sub, authz.MembersOwners, "") {
		return fmt.Errorf("invites: owner role: %w", apperr.ErrForbidden)
	}
	return nil
}

func addMembership(ctx context.Context, q *db.Queries, orgID, userID, role string) error {
	_, err := q.GetMember(ctx, db.GetMemberParams{OrgID: orgID, UserID: userID})
	if err == nil {
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	return q.AddMember(ctx, db.AddMemberParams{OrgID: orgID, UserID: userID, Role: role})
}

func invalidInvite() error {
	return fmt.Errorf("invites: accept: %w", apperr.NotFound{Code: "invite_invalid"})
}

func validRole(r string) bool {
	return r == authz.RoleOwner || r == authz.RoleAdmin || r == authz.RoleMember
}

func roleOf(r sql.NullString) string {
	if r.Valid {
		return r.String
	}
	return defaultRole
}

func roleOrNil(r *string) any {
	if r == nil {
		return nil
	}
	return *r
}

func fromRow(id, email string, orgID, role, orgSlug, orgName sql.NullString, createdBy, creatorName string, createdAt, expiresAt int64) Invite {
	inv := Invite{
		ID: id, Email: email, CreatedBy: createdBy, CreatedByName: creatorName,
		CreatedAt: createdAt, ExpiresAt: expiresAt,
	}
	if orgID.Valid {
		inv.Org = &OrgRef{Slug: orgSlug.String, Name: orgName.String}
	}
	if role.Valid {
		r := role.String
		inv.Role = &r
	}
	return inv
}

func newToken() (string, error) {
	b := make([]byte, tokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// hashToken returns the hex sha256 stored in invites.token_hash.
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
