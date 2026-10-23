package invites

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/audit"
	"github.com/21cloud/runtime-web/internal/store"
	"github.com/21cloud/runtime-web/internal/store/db"
)

const testBase = "https://console.example.test"

// plainHasher is a fast test Hasher; it is not a real password hash.
type plainHasher struct{}

func (plainHasher) Hash(p string) (string, error) { return "plain$" + p, nil }
func (plainHasher) Verify(hash, p string) bool    { return hash == "plain$"+p }

type fixture struct {
	st                      *store.Store
	svc                     *Service
	now                     time.Time
	acme                    string
	adm                     audit.Actor // instance admin
	owner, orgAdmin, member string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	ctx := context.Background()
	st, err := store.Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	f := &fixture{st: st, now: time.UnixMilli(1_000_000_000_000)}
	f.svc = New(st, plainHasher{}, testBase+"/")
	f.svc.now = func() time.Time { return f.now }

	root := f.user(t, "root@example.com", "Root", true)
	f.adm = audit.Actor{UserID: root, AsInstanceAdmin: true}
	f.owner = f.user(t, "owner@example.com", "Owner", false)
	f.orgAdmin = f.user(t, "admin@example.com", "Admin", false)
	f.member = f.user(t, "member@example.com", "Member", false)

	f.acme = store.NewID("org_")
	if err := st.Q().CreateOrg(ctx, db.CreateOrgParams{
		ID: f.acme, Slug: "acme", Name: "Acme", TenantID: "ten_acme",
		DefaultKeyID: "key_acme", DefaultKeySealed: []byte{1}, CreatedAt: 1,
	}); err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	f.addMember(t, f.owner, "owner")
	f.addMember(t, f.orgAdmin, "admin")
	f.addMember(t, f.member, "member")
	return f
}

func (f *fixture) user(t *testing.T, email, name string, admin bool) string {
	t.Helper()
	id := store.NewID("usr_")
	var adminFlag int64
	if admin {
		adminFlag = 1
	}
	if err := f.st.Q().CreateUser(context.Background(), db.CreateUserParams{
		ID: id, Email: email, Name: name, IsInstanceAdmin: adminFlag, CreatedAt: 1, UpdatedAt: 1,
	}); err != nil {
		t.Fatalf("CreateUser(%s): %v", email, err)
	}
	return id
}

func (f *fixture) addMember(t *testing.T, userID, role string) {
	t.Helper()
	if err := f.st.Q().AddMember(context.Background(), db.AddMemberParams{OrgID: f.acme, UserID: userID, Role: role}); err != nil {
		t.Fatalf("AddMember(%s): %v", role, err)
	}
}

func (f *fixture) actor(userID string) audit.Actor { return audit.Actor{UserID: userID} }

func (f *fixture) acmeID() *string { id := f.acme; return &id }

func strPtr(s string) *string { return &s }

// tokenOf strips the console base URL from a link and returns the token.
func tokenOf(t *testing.T, link string) string {
	t.Helper()
	prefix := testBase + "/invite/"
	if !strings.HasPrefix(link, prefix) {
		t.Fatalf("link = %q, want prefix %q", link, prefix)
	}
	return strings.TrimPrefix(link, prefix)
}

func wantInviteInvalid(t *testing.T, err error) {
	t.Helper()
	code, ok := apperr.NotFoundCode(err)
	if !ok || code != "invite_invalid" || !errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("err = %v, want not found invite_invalid", err)
	}
}

func TestInviteAcceptCreatesUserAndMembership(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()

	inv, link, err := f.svc.Create(ctx, f.adm, "New@Example.com", f.acmeID(), strPtr("admin"))
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if inv.Email != "new@example.com" {
		t.Errorf("Email = %q, want normalized lowercase", inv.Email)
	}
	if inv.Org == nil || inv.Org.Slug != "acme" || inv.Role == nil || *inv.Role != "admin" {
		t.Errorf("Org/Role = %+v/%v, want acme/admin", inv.Org, inv.Role)
	}
	token := tokenOf(t, link)
	if len(token) != 43 {
		t.Errorf("token length = %d, want 43 (32 bytes, base64url)", len(token))
	}
	sum := sha256.Sum256([]byte(token))
	row, err := f.st.Q().GetInviteByID(ctx, inv.ID)
	if err != nil {
		t.Fatalf("GetInviteByID: %v", err)
	}
	if row.TokenHash != hex.EncodeToString(sum[:]) {
		t.Errorf("stored token_hash is not sha256(token)")
	}
	if want := f.now.UnixMilli() + int64(7*24*time.Hour/time.Millisecond); row.ExpiresAt != want {
		t.Errorf("expires_at = %d, want %d (7 days)", row.ExpiresAt, want)
	}

	u, err := f.svc.Accept(ctx, token, "New Person", "correct horse battery")
	if err != nil {
		t.Fatalf("Accept: %v", err)
	}
	if u.Email != "new@example.com" || u.Name != "New Person" || u.MustChangePassword {
		t.Errorf("user = %+v, want new@example.com / New Person / no forced change", u)
	}
	acct, err := f.st.Q().GetUserByID(ctx, u.ID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if !(plainHasher{}).Verify(acct.PasswordHash, "correct horse battery") {
		t.Errorf("password hash does not match the accepted password")
	}
	m, err := f.st.Q().GetMember(ctx, db.GetMemberParams{OrgID: f.acme, UserID: u.ID})
	if err != nil {
		t.Fatalf("GetMember: %v", err)
	}
	if m.Role != "admin" {
		t.Errorf("membership role = %q, want admin", m.Role)
	}
}

func TestInviteAcceptExistingUserKeepsName(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	existing := f.user(t, "exists@example.com", "Old Name", false)

	_, link, err := f.svc.Create(ctx, f.adm, "exists@example.com", nil, nil)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	u, err := f.svc.Accept(ctx, tokenOf(t, link), "Ignored", "correct horse battery")
	if err != nil {
		t.Fatalf("Accept: %v", err)
	}
	if u.ID != existing || u.Name != "Old Name" {
		t.Errorf("user = %+v, want existing user %s with name kept", u, existing)
	}
}

func TestInviteExpired(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	_, link, err := f.svc.Create(ctx, f.adm, "late@example.com", nil, nil)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	f.now = f.now.Add(7*24*time.Hour + time.Millisecond)
	_, err = f.svc.Accept(ctx, tokenOf(t, link), "Late", "correct horse battery")
	wantInviteInvalid(t, err)
}

func TestInviteReuseRejected(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	_, link, err := f.svc.Create(ctx, f.adm, "once@example.com", nil, nil)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	token := tokenOf(t, link)
	if _, err := f.svc.Accept(ctx, token, "Once", "correct horse battery"); err != nil {
		t.Fatalf("first Accept: %v", err)
	}
	_, err = f.svc.Accept(ctx, token, "Once", "another long password")
	wantInviteInvalid(t, err)
}

func TestInviteRevoke(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	inv, link, err := f.svc.Create(ctx, f.adm, "rev@example.com", f.acmeID(), strPtr("member"))
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := f.svc.Revoke(ctx, f.adm, inv.ID); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	_, err = f.svc.Accept(ctx, tokenOf(t, link), "Rev", "correct horse battery")
	wantInviteInvalid(t, err)

	pending, err := f.svc.List(ctx, nil)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(pending) != 0 {
		t.Errorf("List after revoke = %d items, want 0", len(pending))
	}
	if err := f.svc.Revoke(ctx, f.adm, inv.ID); !errors.Is(err, apperr.ErrNotFound) {
		t.Errorf("second Revoke err = %v, want ErrNotFound", err)
	}
}

func TestAdminCannotInviteOwner(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	tests := []struct {
		name    string
		actor   string
		role    string
		wantErr error
	}{
		{name: "org admin invites owner is forbidden", actor: f.orgAdmin, role: "owner", wantErr: apperr.ErrForbidden},
		{name: "org admin invites admin", actor: f.orgAdmin, role: "admin"},
		{name: "org owner invites owner", actor: f.owner, role: "owner"},
		{name: "member cannot invite", actor: f.member, role: "member", wantErr: apperr.ErrForbidden},
	}
	for i, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			email := "invitee" + string(rune('a'+i)) + "@example.com"
			_, _, err := f.svc.Create(ctx, f.actor(tt.actor), email, f.acmeID(), strPtr(tt.role))
			if tt.wantErr == nil && err != nil {
				t.Fatalf("Create: %v", err)
			}
			if tt.wantErr != nil && !errors.Is(err, tt.wantErr) {
				t.Fatalf("Create err = %v, want %v", err, tt.wantErr)
			}
		})
	}
}

func TestInviteAuthorization(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	stranger := f.user(t, "stranger@example.com", "Stranger", false)

	t.Run("unbound invite needs instance admin", func(t *testing.T) {
		_, _, err := f.svc.Create(ctx, f.actor(f.orgAdmin), "u1@example.com", nil, nil)
		if !errors.Is(err, apperr.ErrForbidden) {
			t.Errorf("err = %v, want ErrForbidden", err)
		}
	})
	t.Run("non-member of org gets not found", func(t *testing.T) {
		_, _, err := f.svc.Create(ctx, f.actor(stranger), "u2@example.com", f.acmeID(), strPtr("member"))
		if !errors.Is(err, apperr.ErrNotFound) {
			t.Errorf("err = %v, want ErrNotFound", err)
		}
	})
	t.Run("unknown org gets not found", func(t *testing.T) {
		_, _, err := f.svc.Create(ctx, f.adm, "u3@example.com", strPtr("org_missing"), nil)
		if !errors.Is(err, apperr.ErrNotFound) {
			t.Errorf("err = %v, want ErrNotFound", err)
		}
	})
	t.Run("invalid role rejected", func(t *testing.T) {
		_, _, err := f.svc.Create(ctx, f.adm, "u4@example.com", f.acmeID(), strPtr("viewer"))
		if !errors.Is(err, apperr.ErrInvalid) {
			t.Errorf("err = %v, want ErrInvalid", err)
		}
	})
}

func TestInviteListPendingOnly(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	if _, _, err := f.svc.Create(ctx, f.adm, "a@example.com", f.acmeID(), strPtr("member")); err != nil {
		t.Fatalf("Create org invite: %v", err)
	}
	if _, _, err := f.svc.Create(ctx, f.adm, "b@example.com", nil, nil); err != nil {
		t.Fatalf("Create unbound invite: %v", err)
	}
	all, err := f.svc.List(ctx, nil)
	if err != nil || len(all) != 2 {
		t.Fatalf("List(nil) = %d items, err %v; want 2", len(all), err)
	}
	byOrg, err := f.svc.List(ctx, f.acmeID())
	if err != nil || len(byOrg) != 1 || byOrg[0].Email != "a@example.com" {
		t.Fatalf("List(acme) = %+v, err %v; want only a@example.com", byOrg, err)
	}
	if byOrg[0].Org == nil || byOrg[0].Org.Slug != "acme" {
		t.Errorf("Org = %+v, want acme", byOrg[0].Org)
	}
}
