package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/21cloud/runtime-web/internal/store/db"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func mkUser(t *testing.T, s *Store, email string) string {
	t.Helper()
	id := NewID("usr_")
	err := s.Q().CreateUser(context.Background(), db.CreateUserParams{
		ID:                 id,
		Email:              email,
		Name:               "Test",
		PasswordHash:       "",
		MustChangePassword: 0,
		IsInstanceAdmin:    0,
		Disabled:           0,
		CreatedAt:          1,
		UpdatedAt:          1,
	})
	if err != nil {
		t.Fatalf("CreateUser(%q): %v", email, err)
	}
	return id
}

func mkOrg(t *testing.T, s *Store, slug string) string {
	t.Helper()
	id := NewID("org_")
	err := s.Q().CreateOrg(context.Background(), db.CreateOrgParams{
		ID:               id,
		Slug:             slug,
		Name:             slug,
		TenantID:         "tnt_" + slug,
		DefaultKeyID:     "",
		DefaultKeySealed: nil,
		CreatedAt:        1,
	})
	if err != nil {
		t.Fatalf("CreateOrg(%q): %v", slug, err)
	}
	return id
}

func tableNames(t *testing.T, s *Store) map[string]bool {
	t.Helper()
	rows, err := s.sqlDB.Query(`SELECT name FROM sqlite_master WHERE type = 'table'`)
	if err != nil {
		t.Fatalf("list tables: %v", err)
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan table name: %v", err)
		}
		out[name] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate tables: %v", err)
	}
	return out
}

func TestOpenMigrates(t *testing.T) {
	s := newTestStore(t)
	tables := tableNames(t, s)
	want := []string{
		"users", "identities", "sessions", "user_totp", "recovery_codes",
		"login_events", "invites", "version_authors", "orgs", "pending_key_revokes",
		"members", "project_grants", "tokens", "domains", "audit", "settings",
		"login_failures",
	}
	for _, name := range want {
		t.Run(name, func(t *testing.T) {
			if !tables[name] {
				t.Errorf("table %q missing after migrate", name)
			}
		})
	}
}

func TestEmailCaseInsensitiveUnique(t *testing.T) {
	s := newTestStore(t)
	mkUser(t, s, "Alice@Example.com")

	err := s.Q().CreateUser(context.Background(), db.CreateUserParams{
		ID:        NewID("usr_"),
		Email:     "alice@example.COM",
		Name:      "Dup",
		CreatedAt: 1,
		UpdatedAt: 1,
	})
	if err == nil {
		t.Fatal("expected unique constraint error for case-variant email, got nil")
	}

	u, err := s.Q().GetUserByEmail(context.Background(), "ALICE@example.com")
	if err != nil {
		t.Fatalf("GetUserByEmail: %v", err)
	}
	if u.Email != "Alice@Example.com" {
		t.Errorf("Email = %q, want original casing", u.Email)
	}
}

func TestTxRollback(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	wantErr := errors.New("boom")

	err := s.Tx(ctx, func(q *db.Queries) error {
		if err := q.CreateOrg(ctx, db.CreateOrgParams{
			ID: NewID("org_"), Slug: "rolled", Name: "rolled", TenantID: "tnt_rolled", CreatedAt: 1,
		}); err != nil {
			return err
		}
		return wantErr
	})
	if !errors.Is(err, wantErr) {
		t.Fatalf("Tx error = %v, want %v", err, wantErr)
	}

	if _, err := s.Q().GetOrgBySlug(ctx, "rolled"); !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("GetOrgBySlug after rollback: err = %v, want sql.ErrNoRows", err)
	}
}

func TestNewIDPrefixAndSortable(t *testing.T) {
	prefixes := []string{"usr_", "ses_", "org_", "mem_", "tok_", "dom_", "aud_", "inv_", "lge_"}
	for _, p := range prefixes {
		t.Run(p, func(t *testing.T) {
			id := NewID(p)
			if !strings.HasPrefix(id, p) {
				t.Fatalf("NewID(%q) = %q, missing prefix", p, id)
			}
			if got := len(id) - len(p); got != 26 {
				t.Errorf("ULID part length = %d, want 26", got)
			}
		})
	}

	const n = 1000
	prev := NewID("usr_")
	for i := 0; i < n; i++ {
		next := NewID("usr_")
		if next <= prev {
			t.Fatalf("ids not sortable: %q then %q", prev, next)
		}
		prev = next
	}
}

func TestActiveHostUniqueOnlyWhenActive(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	orgA := mkOrg(t, s, "alpha")
	orgB := mkOrg(t, s, "beta")

	domA := NewID("dom_")
	domB := NewID("dom_")
	const host = "app.example.net"

	if err := s.Q().CreateDomain(ctx, db.CreateDomainParams{
		ID: domA, OrgID: orgA, ProjectSlug: "p", ServiceID: "svc_a", Host: host,
		Token: "t1", Status: "pending", CreatedAt: 1,
	}); err != nil {
		t.Fatalf("CreateDomain A: %v", err)
	}
	if err := s.Q().CreateDomain(ctx, db.CreateDomainParams{
		ID: domB, OrgID: orgB, ProjectSlug: "p", ServiceID: "svc_b", Host: host,
		Token: "t2", Status: "pending", CreatedAt: 1,
	}); err != nil {
		t.Fatalf("two pending rows for one host should be allowed: %v", err)
	}

	if _, err := s.Q().UpdateDomainStatus(ctx, db.UpdateDomainStatusParams{ID: domA, Status: "active"}); err != nil {
		t.Fatalf("first active: %v", err)
	}
	if _, err := s.Q().UpdateDomainStatus(ctx, db.UpdateDomainStatusParams{ID: domB, Status: "active"}); err == nil {
		t.Fatal("second active row for one host: expected constraint error, got nil")
	}
}

func TestRecoveryCodeSingleUse(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	uid := mkUser(t, s, "rec@example.com")
	const hash = "hash-of-code"

	if err := s.Q().CreateRecoveryCode(ctx, db.CreateRecoveryCodeParams{UserID: uid, Hash: hash}); err != nil {
		t.Fatalf("CreateRecoveryCode: %v", err)
	}

	use := db.ConsumeRecoveryCodeParams{
		UserID: uid,
		Hash:   hash,
		UsedAt: sql.NullInt64{Int64: 100, Valid: true},
	}
	n, err := s.Q().ConsumeRecoveryCode(ctx, use)
	if err != nil {
		t.Fatalf("first ConsumeRecoveryCode: %v", err)
	}
	if n != 1 {
		t.Fatalf("first consume rows = %d, want 1", n)
	}

	n, err = s.Q().ConsumeRecoveryCode(ctx, use)
	if err != nil {
		t.Fatalf("second ConsumeRecoveryCode: %v", err)
	}
	if n != 0 {
		t.Fatalf("second consume rows = %d, want 0", n)
	}
}

func TestInviteTokenStoredHashed(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	uid := mkUser(t, s, "admin@example.com")

	raw := "raw-invite-token-value"
	sum := sha256.Sum256([]byte(raw))
	tokenHash := hex.EncodeToString(sum[:])

	if err := s.Q().CreateInvite(ctx, db.CreateInviteParams{
		ID:        NewID("inv_"),
		Email:     "new@example.com",
		TokenHash: tokenHash,
		ExpiresAt: 1000,
		CreatedBy: uid,
		CreatedAt: 1,
	}); err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}

	inv, err := s.Q().GetInviteByTokenHash(ctx, tokenHash)
	if err != nil {
		t.Fatalf("lookup by hash: %v", err)
	}
	if inv.TokenHash != tokenHash {
		t.Errorf("stored token_hash = %q, want %q", inv.TokenHash, tokenHash)
	}
	if inv.TokenHash == raw {
		t.Fatal("raw token stored in token_hash column")
	}

	if _, err := s.Q().GetInviteByTokenHash(ctx, raw); !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("lookup by raw token: err = %v, want sql.ErrNoRows", err)
	}
}

func TestStoreConcurrentWriteTxNoBusy(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, filepath.Join(t.TempDir(), "busy.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if _, err := st.DB().ExecContext(ctx, "CREATE TABLE ctr (n INTEGER)"); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := st.DB().ExecContext(ctx, "INSERT INTO ctr VALUES (0)"); err != nil {
		t.Fatalf("insert: %v", err)
	}
	const workers = 16
	var wg sync.WaitGroup
	errs := make(chan error, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- func() error {
				tx, err := st.DB().BeginTx(ctx, nil)
				if err != nil {
					return err
				}
				defer func() { _ = tx.Rollback() }()
				var n int
				if err := tx.QueryRowContext(ctx, "SELECT n FROM ctr").Scan(&n); err != nil {
					return err
				}
				time.Sleep(5 * time.Millisecond)
				if _, err := tx.ExecContext(ctx, "UPDATE ctr SET n = ?", n+1); err != nil {
					return err
				}
				return tx.Commit()
			}()
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("tx: %v", err)
		}
	}
	var n int
	if err := st.DB().QueryRowContext(ctx, "SELECT n FROM ctr").Scan(&n); err != nil || n != workers {
		t.Fatalf("n = %d (%v), want %d", n, err, workers)
	}
}
