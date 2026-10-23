package orgs

import (
	"context"
	"errors"
	"testing"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/runtime"
	"github.com/21cloud/runtime-web/internal/store"
	"github.com/21cloud/runtime-web/internal/store/db"
)

func (f *fixture) user(t *testing.T, email string) string {
	t.Helper()
	id := store.NewID("usr_")
	if err := f.st.Q().CreateUser(context.Background(), db.CreateUserParams{ID: id, Email: email, Name: email, CreatedAt: 1, UpdatedAt: 1}); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	return id
}

func (f *fixture) subject(t *testing.T, userID, orgID string) authz.Subject {
	t.Helper()
	s, err := f.svc.Subject(context.Background(), userID, orgID)
	if err != nil {
		t.Fatalf("Subject: %v", err)
	}
	return s
}

func TestLastOwnerProtected(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	org := f.create(t, "acme")
	sub := f.subject(t, f.owner, org.ID)

	if err := f.svc.SetRole(ctx, cli, sub, org.ID, f.owner, authz.RoleAdmin); conflictCode(err) != "last_owner" {
		t.Fatalf("demote last owner: err = %v, want last_owner", err)
	}
	if err := f.svc.RemoveMember(ctx, cli, sub, org.ID, f.owner); conflictCode(err) != "last_owner" {
		t.Fatalf("remove last owner: err = %v, want last_owner", err)
	}

	second := f.user(t, "two@example.com")
	if err := f.svc.AddMember(ctx, cli, sub, org.ID, second, authz.RoleOwner); err != nil {
		t.Fatalf("AddMember owner: %v", err)
	}
	if err := f.svc.SetRole(ctx, cli, sub, org.ID, f.owner, authz.RoleMember); err != nil {
		t.Fatalf("demote with a second owner: %v", err)
	}
	sub2 := f.subject(t, second, org.ID)
	if err := f.svc.RemoveMember(ctx, cli, sub2, org.ID, second); conflictCode(err) != "last_owner" {
		t.Fatalf("remove remaining owner: err = %v, want last_owner", err)
	}
}

func TestAdminCannotChangeOwners(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	org := f.create(t, "acme")
	owner := f.subject(t, f.owner, org.ID)
	admin := f.user(t, "admin@example.com")
	member := f.user(t, "m@example.com")
	if err := f.svc.AddMember(ctx, cli, owner, org.ID, admin, authz.RoleAdmin); err != nil {
		t.Fatalf("AddMember admin: %v", err)
	}
	asAdmin := f.subject(t, admin, org.ID)

	tests := []struct {
		name string
		fn   func() error
	}{
		{"promote to owner", func() error { return f.svc.SetRole(ctx, cli, asAdmin, org.ID, admin, authz.RoleOwner) }},
		{"demote owner", func() error { return f.svc.SetRole(ctx, cli, asAdmin, org.ID, f.owner, authz.RoleMember) }},
		{"remove owner", func() error { return f.svc.RemoveMember(ctx, cli, asAdmin, org.ID, f.owner) }},
		{"add owner", func() error { return f.svc.AddMember(ctx, cli, asAdmin, org.ID, member, authz.RoleOwner) }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.fn(); !errors.Is(err, apperr.ErrForbidden) {
				t.Fatalf("err = %v, want ErrForbidden", err)
			}
		})
	}

	if err := f.svc.AddMember(ctx, cli, asAdmin, org.ID, member, authz.RoleMember); err != nil {
		t.Fatalf("admin adds member: %v", err)
	}
	if err := f.svc.AddMember(ctx, cli, asAdmin, org.ID, member, authz.RoleMember); conflictCode(err) != "already_member" {
		t.Fatalf("re-add: err = %v, want already_member", err)
	}
	asMember := f.subject(t, member, org.ID)
	if err := f.svc.SetRole(ctx, cli, asMember, org.ID, member, authz.RoleAdmin); !errors.Is(err, apperr.ErrForbidden) {
		t.Fatalf("member self-promote: err = %v, want ErrForbidden", err)
	}
}

func TestGrantKeyedBySlug(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	org := f.create(t, "acme")
	owner := f.subject(t, f.owner, org.ID)
	dev := f.user(t, "dev@example.com")
	if _, err := f.rt.With(runtime.RootCred{Token: f.root.Token, Tenant: org.TenantID}).CreateProject(ctx, runtime.ProjectCreate{Slug: "web"}); err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	if err := f.svc.AddMember(ctx, cli, owner, org.ID, dev, authz.RoleMember); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	if err := f.svc.SetGrant(ctx, cli, owner, org.ID, dev, "web", authz.RoleAdmin); err != nil {
		t.Fatalf("SetGrant: %v", err)
	}
	s := f.subject(t, dev, org.ID)
	if s.OrgRole != authz.RoleMember || s.ProjectRoles["web"] != authz.RoleAdmin {
		t.Fatalf("subject = %+v", s)
	}
	// a project admin manages grants on its own project only
	other := f.user(t, "o@x.com")
	if err := f.svc.AddMember(ctx, cli, owner, org.ID, other, authz.RoleMember); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	if err := f.svc.SetGrant(ctx, cli, s, org.ID, other, "web", authz.RoleViewer); err != nil {
		t.Fatalf("project admin SetGrant: %v", err)
	}
	if err := f.svc.SetGrant(ctx, cli, s, org.ID, other, "api", authz.RoleViewer); !errors.Is(err, apperr.ErrForbidden) {
		t.Fatalf("grant outside project: err = %v, want ErrForbidden", err)
	}
	if err := f.svc.SetGrant(ctx, cli, owner, org.ID, other, "nope", authz.RoleViewer); !errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("unknown project: err = %v, want ErrNotFound", err)
	}
	if err := f.svc.SetGrant(ctx, cli, owner, org.ID, other, "web", "owner"); !errors.Is(err, apperr.ErrInvalid) {
		t.Fatalf("bad role: err = %v, want ErrInvalid", err)
	}
	if err := f.svc.RemoveGrant(ctx, cli, owner, org.ID, other, "web"); err != nil {
		t.Fatalf("RemoveGrant: %v", err)
	}
	if err := f.svc.RemoveGrant(ctx, cli, owner, org.ID, other, "web"); !errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("RemoveGrant twice: err = %v, want ErrNotFound", err)
	}

	// removing a member drops their grants
	if err := f.svc.RemoveMember(ctx, cli, owner, org.ID, dev); err != nil {
		t.Fatalf("RemoveMember: %v", err)
	}
	s = f.subject(t, dev, org.ID)
	if s.OrgRole != "" || len(s.ProjectRoles) != 0 {
		t.Fatalf("subject after removal = %+v", s)
	}
	members, err := f.svc.Members(ctx, org.ID)
	if err != nil || len(members) != 2 {
		t.Fatalf("Members = %v, %v", members, err)
	}
}

func conflictCode(err error) string {
	c, _ := apperr.ConflictCode(err)
	return c
}
