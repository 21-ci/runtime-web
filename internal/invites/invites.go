// Package invites issues expiring, single-use invite links and accepts them. An accepted invite
// for a new email creates the user with the chosen password and logs it in through the normal
// LoginUser path (second-factor policy applies). An invite for an existing account never touches
// its password: the caller must be that account, and Accept only adds the bound membership.
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

// Accepted is the outcome of Accept. Existing is true for an existing account (no session, no
// password change); Session is set only for a new account. Role and AlreadyMember describe the
// bound membership (Role is "" for unbound invites).
type Accepted struct {
	User          users.User
	Existing      bool
	Role          string
	AlreadyMember bool
	Session       auth.LoginResult
}

// Preview is what the public accept page shows for a pending token.
type Preview struct {
	Email   string
	OrgName *string
}

// Preview looks up a pending invite by token without changing it. Expired, used, revoked and
// unknown tokens all return the invite_invalid error.
func (s *Service) Preview(ctx context.Context, token string) (Preview, error) {
	row, err := s.st.Q().GetInviteByTokenHash(ctx, hashToken(token))
	if errors.Is(err, sql.ErrNoRows) {
		return Preview{}, invalidInvite()
	}
	if err != nil {
		return Preview{}, fmt.Errorf("invites: preview: %w", err)
	}
	if row.UsedAt.Valid || row.RevokedAt.Valid || s.now().UnixMilli() >= row.ExpiresAt {
		return Preview{}, invalidInvite()
	}
	out := Preview{Email: row.Email}
	if row.OrgID.Valid {
		org, err := s.st.Q().GetOrgByID(ctx, row.OrgID.String)
		if err != nil {
			return Preview{}, fmt.Errorf("invites: preview org: %w", err)
		}
		name := org.Name
		out.OrgName = &name
	}
	return out, nil
}

// Logins starts a session for an already-authenticated user; *auth.Service implements it.
type Logins interface {
	LoginUser(ctx context.Context, userID, method, ip, ua string) (auth.LoginResult, error)
}

// Service manages invites.
type Service struct {
	st        *store.Store
	hasher    auth.Hasher
	logins    Logins
	publicURL string
	now       func() time.Time
}

// New returns an invites Service. publicURL is the console base URL used to build invite links.
func New(st *store.Store, hasher auth.Hasher, logins Logins, publicURL string) *Service {
	return &Service{st: st, hasher: hasher, logins: logins, publicURL: strings.TrimRight(publicURL, "/"), now: time.Now}
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

// List returns pending invites (unused, unrevoked, unexpired), oldest first. orgID "" lists every
// org and unbound invites (instance scope); otherwise only that org's invites. Authorization is the
// API layer's job: it must check invites.manage for the org, or instance.admin for "".
func (s *Service) List(ctx context.Context, orgID string) ([]Invite, error) {
	nowAt := s.now().UnixMilli()
	if orgID == "" {
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
		NowAt: nowAt, OrgID: sql.NullString{String: orgID, Valid: true},
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

// Revoke cancels a pending invite. orgID "" is instance scope (any invite, instance admin only);
// otherwise the invite must belong to orgID, or the call returns ErrNotFound. Unknown, settled,
// expired and invisible invites (the actor is not a member of the bound org) return apperr.ErrNotFound;
// a known invite the actor may not manage returns ErrForbidden.
func (s *Service) Revoke(ctx context.Context, actor audit.Actor, orgID, id string) error {
	err := s.st.Tx(ctx, func(q *db.Queries) error {
		row, err := q.GetInviteByID(ctx, id)
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("invites: revoke %s: %w", id, apperr.ErrNotFound)
		}
		if err != nil {
			return err
		}
		if orgID != "" && (!row.OrgID.Valid || row.OrgID.String != orgID) {
			return fmt.Errorf("invites: revoke %s: not in org %s: %w", id, orgID, apperr.ErrNotFound)
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

// Accept redeems a token once. Checks run in this order: token validity (expired, used, revoked →
// invite_invalid); for an existing account, disabled (account_disabled), then callerID must equal
// that account (else Forbidden{invite_login_required}); then, for a new email, name and password
// fields (ErrInvalid). A new email creates the user with the chosen password and the bound
// membership, then starts a session through Logins (MethodInvite; second-factor checks apply).
// An existing account is never given a new password: name and password are ignored, Accept adds
// the bound membership, and no session is returned. The result carries Existing so the caller can
// tell the two cases apart for a valid token holder.
func (s *Service) Accept(ctx context.Context, token, callerID, name, password, ip, ua string) (Accepted, error) {
	name = strings.TrimSpace(name)
	var out Accepted
	err := s.st.Tx(ctx, func(q *db.Queries) error {
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
			if err := auth.ValidatePassword(password); err != nil {
				return fmt.Errorf("invites: accept: %w", err)
			}
			hash, err := s.hasher.Hash(password)
			if err != nil {
				return fmt.Errorf("invites: accept: hash: %w", err)
			}
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
			out.Existing = false
		case err != nil:
			return err
		default:
			if acct.Disabled != 0 {
				return fmt.Errorf("invites: accept: account disabled: %w", apperr.Forbidden{Code: "account_disabled"})
			}
			if callerID == "" || callerID != acct.ID {
				return fmt.Errorf("invites: accept: log in as %s first: %w", row.Email, apperr.Forbidden{Code: "invite_login_required"})
			}
			out.Existing = true
		}
		n, err := q.MarkInviteUsed(ctx, db.MarkInviteUsedParams{UsedAt: sql.NullInt64{Int64: nowMs, Valid: true}, ID: row.ID})
		if err != nil {
			return err
		}
		if n != 1 {
			return invalidInvite()
		}
		orgAudit := ""
		detail := map[string]any{"email": row.Email, "existing": out.Existing}
		if row.OrgID.Valid {
			orgAudit = row.OrgID.String
			m, err := addMembership(ctx, q, row.OrgID.String, acct.ID, roleOf(row.Role))
			if err != nil {
				return err
			}
			out.AlreadyMember = m.AlreadyMember
			out.Role = m.Role
			if m.AlreadyMember {
				detail["membership"] = "already_member"
				detail["kept_role"] = m.Role
			}
		}
		actor := audit.Actor{UserID: acct.ID}
		if err := s.log().Log(ctx, q, actor, orgAudit, "invite.accept", row.ID, detail); err != nil {
			return err
		}
		out.User = users.User{
			ID: acct.ID, Email: acct.Email, Name: acct.Name, IsInstanceAdmin: acct.IsInstanceAdmin != 0,
			Disabled: acct.Disabled != 0, MustChangePassword: false, CreatedAt: acct.CreatedAt,
		}
		return nil
	})
	if err != nil {
		return Accepted{}, fmt.Errorf("invites: accept: %w", err)
	}
	if out.Existing {
		return out, nil
	}
	res, err := s.logins.LoginUser(ctx, out.User.ID, auth.MethodInvite, ip, ua)
	if err != nil {
		return Accepted{}, fmt.Errorf("invites: accept: login: %w", err)
	}
	out.Session = res
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

// membership is the outcome of addMembership: the role the user holds now, and whether it was
// already there (in which case the existing role is kept, not the invite's).
type membership struct {
	Role          string
	AlreadyMember bool
}

func addMembership(ctx context.Context, q *db.Queries, orgID, userID, role string) (membership, error) {
	m, err := q.GetMember(ctx, db.GetMemberParams{OrgID: orgID, UserID: userID})
	if err == nil {
		return membership{Role: m.Role, AlreadyMember: true}, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return membership{}, err
	}
	if err := q.AddMember(ctx, db.AddMemberParams{OrgID: orgID, UserID: userID, Role: role}); err != nil {
		return membership{}, err
	}
	return membership{Role: role}, nil
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
