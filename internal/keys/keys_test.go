package keys

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/audit"
	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/orgs"
	"github.com/21cloud/runtime-web/internal/runtime"
	"github.com/21cloud/runtime-web/internal/runtime/runtimetest"
	"github.com/21cloud/runtime-web/internal/seal"
	"github.com/21cloud/runtime-web/internal/store"
	"github.com/21cloud/runtime-web/internal/store/db"
)

type fixture struct {
	fake  *runtimetest.Fake
	rt    *runtime.Client
	root  runtime.RootCred
	st    *store.Store
	orgs  *orgs.Service
	svc   *Service
	org   orgs.Org
	owner authz.Subject
	actor audit.Actor
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	ctx := context.Background()
	fake := runtimetest.NewServer(t)
	st, err := store.Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	owner := store.NewID("usr_")
	if err := st.Q().CreateUser(ctx, db.CreateUserParams{ID: owner, Email: "o@example.com", Name: "Olga", CreatedAt: 1, UpdatedAt: 1}); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	rt := runtime.New(fake.URL, http.DefaultClient)
	root := runtime.RootCred{Token: fake.RootToken}
	var key [32]byte
	for i := range key {
		key[i] = byte(i + 7)
	}
	sealer := seal.New(key)
	o := orgs.New(st, rt, root, sealer, "free")
	actor := audit.Actor{UserID: owner}
	org, err := o.Create(ctx, actor, "acme", "Acme", owner)
	if err != nil {
		t.Fatalf("orgs.Create: %v", err)
	}
	sub, err := o.Subject(ctx, owner, org.ID)
	if err != nil {
		t.Fatalf("Subject: %v", err)
	}
	return &fixture{
		fake: fake, rt: rt, root: root, st: st, orgs: o, org: org, owner: sub, actor: actor,
		svc: New(st, rt, root, sealer, o),
	}
}

func (f *fixture) token(t *testing.T, req TokenRequest) (Token, string) {
	t.Helper()
	tok, secret, err := f.svc.CreateToken(context.Background(), f.actor, f.owner, f.org.ID, req)
	if err != nil {
		t.Fatalf("CreateToken: %v", err)
	}
	return tok, secret
}

// works reports whether cred authenticates against the runtime.
func (f *fixture) works(t *testing.T, cred runtime.Credential) bool {
	t.Helper()
	_, err := f.rt.With(cred).Me(context.Background())
	if err == nil {
		return true
	}
	var rerr *runtime.Error
	if errors.As(err, &rerr) && rerr.Status == http.StatusUnauthorized {
		return false
	}
	t.Fatalf("Me: unexpected error %v", err)
	return false
}

func (f *fixture) defaultSecret(t *testing.T) string {
	t.Helper()
	c, err := f.orgs.DefaultCred(context.Background(), f.org.ID)
	if err != nil {
		t.Fatalf("DefaultCred: %v", err)
	}
	return c.Secret
}

func (f *fixture) pending(t *testing.T) []db.PendingKeyRevoke {
	t.Helper()
	rows, err := f.st.Q().ListPendingKeyRevokes(context.Background(), 100)
	if err != nil {
		t.Fatalf("ListPendingKeyRevokes: %v", err)
	}
	return rows
}

func TestCustomTokenShownOnce(t *testing.T) {
	f := newFixture(t)
	tok, secret := f.token(t, TokenRequest{Name: "ci", Scopes: []string{"deploy"}})
	if !strings.HasPrefix(secret, "rtk_") || !f.works(t, runtime.TenantKeyCred{Secret: secret}) {
		t.Fatalf("secret %q does not authenticate", secret)
	}
	if !strings.HasPrefix(tok.ID, "tok_") || tok.Name != "ci" || tok.CreatedBy.Name != "Olga" {
		t.Fatalf("token = %+v", tok)
	}
	list, err := f.svc.ListTokens(context.Background(), f.org.ID)
	if err != nil || len(list) != 1 || list[0].ID != tok.ID {
		t.Fatalf("ListTokens = %+v, %v (the default key must not be listed)", list, err)
	}
	b, _ := json.Marshal(list)
	if strings.Contains(string(b), secret) {
		t.Fatalf("ListTokens JSON contains the secret: %s", b)
	}
}

func TestRevokedTokenRejectedByRuntime(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	tok, secret := f.token(t, TokenRequest{Name: "ci", Scopes: []string{"deploy"}})
	if err := f.svc.RevokeToken(ctx, f.actor, f.org.ID, tok.ID); err != nil {
		t.Fatalf("RevokeToken: %v", err)
	}
	if f.works(t, runtime.TenantKeyCred{Secret: secret}) {
		t.Fatal("revoked token still accepted")
	}
	if list, _ := f.svc.ListTokens(ctx, f.org.ID); len(list) != 0 {
		t.Fatalf("revoked token still listed: %+v", list)
	}
	if err := f.svc.RevokeToken(ctx, f.actor, f.org.ID, tok.ID); !errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("revoke twice: err = %v, want ErrNotFound", err)
	}
	if err := f.svc.RevokeToken(ctx, f.actor, "org_other", tok.ID); !errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("revoke via other org: err = %v, want ErrNotFound", err)
	}
}

func TestRotateDefaultKeepsCustomTokens(t *testing.T) {
	f := newFixture(t)
	_, secret := f.token(t, TokenRequest{Name: "ci", Scopes: []string{"deploy", "services:read"}})
	old := f.defaultSecret(t)
	if err := f.svc.RotateDefault(context.Background(), f.actor, f.org.ID); err != nil {
		t.Fatalf("RotateDefault: %v", err)
	}
	cur := f.defaultSecret(t)
	if cur == old {
		t.Fatal("DefaultCred still returns the old key (cache not invalidated)")
	}
	if f.works(t, runtime.TenantKeyCred{Secret: old}) {
		t.Fatal("old default key still accepted")
	}
	if !f.works(t, runtime.TenantKeyCred{Secret: cur}) {
		t.Fatal("new default key rejected")
	}
	if !f.works(t, runtime.TenantKeyCred{Secret: secret}) {
		t.Fatal("custom token stopped working after default key rotation")
	}
	me, err := f.rt.With(runtime.TenantKeyCred{Secret: cur}).Me(context.Background())
	if err != nil || strings.Join(me.Scopes, ",") != strings.Join(authz.DefaultKeyScopes(), ",") {
		t.Fatalf("new default key scopes = %v, %v", me.Scopes, err)
	}
	if p := f.pending(t); len(p) != 0 {
		t.Fatalf("pending revokes left: %+v", p)
	}
}

func TestRotateRetriesRevoke(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	old := f.defaultSecret(t)
	// The rotation's calls are POST key (mint) then DELETE old key; fail the DELETE.
	f.svc.beforeRevoke = func() { f.fake.FailNext(http.StatusServiceUnavailable, "unavailable", 0) }
	if err := f.svc.RotateDefault(ctx, f.actor, f.org.ID); err != nil {
		t.Fatalf("RotateDefault: %v", err)
	}
	f.svc.beforeRevoke = nil
	if p := f.pending(t); len(p) != 1 || p[0].Attempts != 1 {
		t.Fatalf("pending = %+v, want one row with 1 attempt", p)
	}
	if !f.works(t, runtime.TenantKeyCred{Secret: old}) {
		t.Fatal("old key revoked although the DELETE failed")
	}
	if err := f.svc.RetryPendingRevokes(ctx); err != nil {
		t.Fatalf("RetryPendingRevokes: %v", err)
	}
	if f.works(t, runtime.TenantKeyCred{Secret: old}) {
		t.Fatal("old key still accepted after retry")
	}
	if p := f.pending(t); len(p) != 0 {
		t.Fatalf("pending after retry = %+v", p)
	}
}

func TestDefaultKeyNeverSerialized(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	secrets := []string{f.defaultSecret(t)}
	var out []any
	tok, tokSecret, err := f.svc.CreateToken(ctx, f.actor, f.owner, f.org.ID, TokenRequest{Name: "ci", Scopes: []string{"deploy"}})
	if err != nil {
		t.Fatalf("CreateToken: %v", err)
	}
	out = append(out, tok)
	list, err := f.svc.ListTokens(ctx, f.org.ID)
	if err != nil {
		t.Fatalf("ListTokens: %v", err)
	}
	out = append(out, list)

	f.svc.beforeRevoke = func() { f.fake.FailNext(http.StatusServiceUnavailable, "unavailable", 0) }
	if err := f.svc.RotateDefault(ctx, f.actor, f.org.ID); err != nil {
		t.Fatalf("RotateDefault: %v", err)
	}
	f.svc.beforeRevoke = nil
	secrets = append(secrets, f.defaultSecret(t))
	f.fake.FailNext(http.StatusServiceUnavailable, "unavailable", 0)
	if err := f.svc.RetryPendingRevokes(ctx); err != nil {
		out = append(out, err.Error())
	}
	if err := f.svc.RotateDefault(ctx, f.actor, "org_missing"); err != nil {
		out = append(out, err.Error())
	}
	if err := f.svc.RevokeToken(ctx, f.actor, f.org.ID, tok.ID); err != nil {
		t.Fatalf("RevokeToken: %v", err)
	}
	entries, _, err := audit.List(ctx, f.st.Q(), audit.Filter{OrgID: &f.org.ID, Limit: 100})
	if err != nil {
		t.Fatalf("audit.List: %v", err)
	}
	out = append(out, entries)

	blob, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if logs.Len() == 0 {
		t.Fatal("expected the failed revoke to be logged")
	}
	for _, s := range append(secrets, tokSecret) {
		secretPart := s[strings.LastIndex(s, "_")+1:]
		for name, hay := range map[string]string{"logs": logs.String(), "returned values": string(blob)} {
			if strings.Contains(hay, secretPart) {
				t.Errorf("a key secret appears in %s", name)
			}
		}
	}
}

func TestTokenScopesValidated(t *testing.T) {
	f := newFixture(t)
	past := time.Now().Add(-time.Hour)
	tests := []struct {
		name string
		req  TokenRequest
	}{
		{"unknown scope", TokenRequest{Name: "x", Scopes: []string{"root:all"}}},
		{"keys:write", TokenRequest{Name: "x", Scopes: []string{"deploy", "keys:write"}}},
		{"no scopes", TokenRequest{Name: "x"}},
		{"no name", TokenRequest{Scopes: []string{"deploy"}}},
		{"past expiry", TokenRequest{Name: "x", Scopes: []string{"deploy"}, ExpiresAt: &past}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, _, err := f.svc.CreateToken(context.Background(), f.actor, f.owner, f.org.ID, tt.req)
			if !errors.Is(err, apperr.ErrInvalid) {
				t.Fatalf("err = %v, want ErrInvalid", err)
			}
		})
	}
	future := time.Now().Add(time.Hour)
	tok, _ := f.token(t, TokenRequest{Name: "x", Scopes: []string{"logs:read"}, ExpiresAt: &future})
	if tok.ExpiresAt == nil || *tok.ExpiresAt != future.UnixMilli() {
		t.Fatalf("ExpiresAt = %v", tok.ExpiresAt)
	}
}

func TestTokenScopesSubsetOfCreator(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	tests := []struct {
		name string
		sub  authz.Subject
		ok   bool
	}{
		{"owner", f.owner, true},
		{"org admin", authz.Subject{UserID: f.owner.UserID, OrgRole: authz.RoleAdmin}, true},
		{"instance admin", authz.Subject{UserID: f.owner.UserID, InstanceAdmin: true}, true},
		// v1: tokens are org-level only; a project admin cannot mint even within its project.
		{"project admin", authz.Subject{UserID: f.owner.UserID, OrgRole: authz.RoleMember, ProjectRoles: map[string]string{"default": authz.RoleAdmin}}, false},
		{"non-member", authz.Subject{UserID: f.owner.UserID}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, _, err := f.svc.CreateToken(ctx, f.actor, tt.sub, f.org.ID, TokenRequest{Name: "x", Scopes: authz.DefaultKeyScopes()})
			if tt.ok && err != nil {
				t.Fatalf("err = %v, want ok", err)
			}
			if !tt.ok && !errors.Is(err, apperr.ErrForbidden) {
				t.Fatalf("err = %v, want ErrForbidden", err)
			}
		})
	}
}

func TestTokenServiceRestriction(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	tenantRoot := f.rt.With(runtime.RootCred{Token: f.root.Token, Tenant: f.org.TenantID})
	var ids []string
	for _, slug := range []string{"acme-web", "acme-api"} {
		svc, err := tenantRoot.CreateService(ctx, runtime.ServiceCreate{Slug: slug, Runtime: "deno"})
		if err != nil {
			t.Fatalf("CreateService(%s): %v", slug, err)
		}
		ids = append(ids, svc.ID)
	}
	tok, secret := f.token(t, TokenRequest{Name: "web", Scopes: []string{"services:read"}, Services: []string{"acme-web"}})
	if len(tok.Apps) != 1 || tok.Apps[0] != "acme-web" {
		t.Fatalf("Apps = %v", tok.Apps)
	}
	me, err := f.rt.With(runtime.TenantKeyCred{Secret: secret}).Me(ctx)
	if err != nil || len(me.ServiceIDs) != 1 || me.ServiceIDs[0] != ids[0] {
		t.Fatalf("token service_ids = %v, %v; want [%s]", me.ServiceIDs, err, ids[0])
	}
	list, _ := f.svc.ListTokens(ctx, f.org.ID)
	if len(list) != 1 || len(list[0].Apps) != 1 {
		t.Fatalf("listed apps = %+v", list)
	}
	_, _, err = f.svc.CreateToken(ctx, f.actor, f.owner, f.org.ID, TokenRequest{Name: "x", Scopes: []string{"deploy"}, Services: []string{"nope"}})
	if !errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("unknown app: err = %v, want ErrNotFound", err)
	}
}
