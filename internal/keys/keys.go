// Package keys manages an org's runtime keys: custom API tokens (org-level in v1) and rotation of the
// sealed default key. Custom tokens are minted with the operator root credential, never from the default
// key, so rotating the default key never cascades to them. Secrets are returned once by CreateToken and
// are never logged, audited or stored in plaintext.
package keys

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/apps"
	"github.com/21cloud/runtime-web/internal/audit"
	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/orgs"
	"github.com/21cloud/runtime-web/internal/runtime"
	"github.com/21cloud/runtime-web/internal/seal"
	"github.com/21cloud/runtime-web/internal/store"
	"github.com/21cloud/runtime-web/internal/store/db"
)

const (
	defaultKeyName = "rtweb-default"
	// RetryInterval is how often RunRetrier retries pending default-key revokes.
	RetryInterval = 5 * time.Minute
	retryBatch    = 100
)

// TokenRequest describes a custom token. Services are app slugs; empty means all apps.
type TokenRequest struct {
	Name      string
	Scopes    []string
	Services  []string
	ExpiresAt *time.Time
}

// Creator is the user who created a token.
type Creator struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Token is a custom token's metadata. It never carries the secret.
type Token struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Scopes     []string `json:"scopes"`
	Apps       []string `json:"apps"`
	CreatedBy  Creator  `json:"created_by"`
	CreatedAt  int64    `json:"created_at"`
	ExpiresAt  *int64   `json:"expires_at"`
	LastUsedAt *int64   `json:"last_used_at"`
}

// Service manages custom tokens and default key rotation.
type Service struct {
	st     *store.Store
	rt     *runtime.Client
	root   runtime.RootCred
	sealer *seal.Sealer
	orgs   *orgs.Service
	apps   *apps.Service
	now    func() time.Time
	// beforeRevoke is a test seam run right before the runtime revoke of a rotated-out default key.
	beforeRevoke func()
	// beforeSwap is a test seam run after a rotation mints its key and before the swap tx.
	beforeSwap func(runtime.KeyCreated)
}

// New returns a keys Service.
func New(st *store.Store, rt *runtime.Client, root runtime.RootCred, sealer *seal.Sealer, o *orgs.Service, a *apps.Service) *Service {
	return &Service{st: st, rt: rt, root: root, sealer: sealer, orgs: o, apps: a, now: time.Now}
}

func (s *Service) log() audit.Writer { return audit.Writer{Now: s.now} }

// CreateToken mints a custom token for orgID with the root credential and returns its metadata and the
// one-time secret. Needs tokens.manage (org owner/admin). Scopes must be tenant scopes other than
// keys:write; Services are app slugs resolved to runtime service ids.
func (s *Service) CreateToken(ctx context.Context, actor audit.Actor, sub authz.Subject, orgID string, req TokenRequest) (Token, string, error) {
	if !authz.Can(sub, authz.TokensManage, "") {
		return Token{}, "", fmt.Errorf("keys: create token: %w", apperr.ErrForbidden)
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		return Token{}, "", fmt.Errorf("keys: create token: name required: %w", apperr.ErrInvalid)
	}
	if len(req.Scopes) == 0 {
		return Token{}, "", fmt.Errorf("keys: create token: scopes required: %w", apperr.ErrInvalid)
	}
	allowed := authz.DefaultKeyScopes()
	scopes := []string{}
	for _, sc := range req.Scopes {
		if !slices.Contains(allowed, sc) {
			return Token{}, "", fmt.Errorf("keys: create token: scope %q: %w", sc, apperr.ErrInvalid)
		}
		if !slices.Contains(scopes, sc) {
			scopes = append(scopes, sc)
		}
	}
	now := s.now()
	in := runtime.KeyCreate{Name: req.Name, Scopes: scopes}
	var expiresAt sql.NullInt64
	if req.ExpiresAt != nil {
		if !req.ExpiresAt.After(now) {
			return Token{}, "", fmt.Errorf("keys: create token: expiry in the past: %w", apperr.ErrInvalid)
		}
		in.ExpiresAt = req.ExpiresAt.UTC().Format(time.RFC3339Nano)
		expiresAt = sql.NullInt64{Int64: req.ExpiresAt.UnixMilli(), Valid: true}
	}

	org, err := s.orgs.Get(ctx, orgID)
	if err != nil {
		return Token{}, "", err
	}
	apps := []string{}
	if len(req.Services) > 0 {
		ids, err := s.resolveApps(ctx, orgID, req.Services)
		if err != nil {
			return Token{}, "", err
		}
		in.Services = ids
		for _, a := range req.Services {
			if !slices.Contains(apps, a) {
				apps = append(apps, a)
			}
		}
	}
	creator, err := s.st.Q().GetUserByID(ctx, actor.UserID)
	if err != nil {
		return Token{}, "", fmt.Errorf("keys: create token: creator %s: %w", actor.UserID, err)
	}

	scopesJSON, err := json.Marshal(scopes)
	if err != nil {
		return Token{}, "", fmt.Errorf("keys: create token: encode scopes: %w", err)
	}
	appsJSON, err := json.Marshal(apps)
	if err != nil {
		return Token{}, "", fmt.Errorf("keys: create token: encode apps: %w", err)
	}
	key, err := s.rt.With(s.root).CreateTenantKey(ctx, org.TenantID, in)
	if err != nil {
		return Token{}, "", fmt.Errorf("keys: create token: mint: %w", err)
	}
	tok := Token{
		ID: store.NewID("tok_"), Name: req.Name, Scopes: scopes, Apps: apps,
		CreatedBy: Creator{ID: creator.ID, Name: creator.Name}, CreatedAt: now.UnixMilli(),
	}
	if expiresAt.Valid {
		ms := expiresAt.Int64
		tok.ExpiresAt = &ms
	}
	err = s.st.Tx(ctx, func(q *db.Queries) error {
		if err := q.CreateToken(ctx, db.CreateTokenParams{
			ID: tok.ID, OrgID: orgID, RuntimeKeyID: key.ID, Name: tok.Name, Scopes: string(scopesJSON),
			Apps: string(appsJSON), ExpiresAt: expiresAt, CreatedBy: actor.UserID, CreatedAt: tok.CreatedAt,
		}); err != nil {
			return err
		}
		return s.log().Log(ctx, q, actor, orgID, "token.create", tok.ID, map[string]any{"name": tok.Name, "scopes": scopes, "apps": apps})
	})
	if err != nil {
		if rerr := s.rt.With(s.root).RevokeTenantKey(ctx, org.TenantID, key.ID); rerr != nil && !runtime.IsNotFound(rerr) {
			slog.Error("keys: revoke unrecorded token key failed", "tenant_id", org.TenantID, "key_id", key.ID, "err", rerr)
		}
		return Token{}, "", fmt.Errorf("keys: create token: %w", err)
	}
	return tok, key.Secret, nil
}

// resolveApps maps app slugs to runtime service ids through apps.Resolve. An unknown slug, or one held
// by another tenant, is apperr.ErrNotFound.
func (s *Service) resolveApps(ctx context.Context, orgID string, slugs []string) ([]string, error) {
	var ids []string
	for _, slug := range slugs {
		app, err := s.apps.Resolve(ctx, orgID, slug)
		if err != nil {
			return nil, fmt.Errorf("keys: resolve app %s: %w", slug, err)
		}
		if !slices.Contains(ids, app.SvcID) {
			ids = append(ids, app.SvcID)
		}
	}
	return ids, nil
}

// ListTokens returns orgID's live custom tokens. It never returns secrets or the default key.
func (s *Service) ListTokens(ctx context.Context, orgID string) ([]Token, error) {
	rows, err := s.st.Q().ListLiveTokensByOrg(ctx, orgID)
	if err != nil {
		return nil, fmt.Errorf("keys: list tokens: %w", err)
	}
	out := make([]Token, 0, len(rows))
	for _, r := range rows {
		t := Token{
			ID: r.ID, Name: r.Name, Scopes: []string{}, Apps: []string{},
			CreatedBy: Creator{ID: r.CreatedBy, Name: r.CreatorName}, CreatedAt: r.CreatedAt,
		}
		if err := json.Unmarshal([]byte(r.Scopes), &t.Scopes); err != nil {
			return nil, fmt.Errorf("keys: list tokens: scopes of %s: %w", r.ID, err)
		}
		if err := json.Unmarshal([]byte(r.Apps), &t.Apps); err != nil {
			return nil, fmt.Errorf("keys: list tokens: apps of %s: %w", r.ID, err)
		}
		if r.ExpiresAt.Valid {
			ms := r.ExpiresAt.Int64
			t.ExpiresAt = &ms
		}
		out = append(out, t)
	}
	return out, nil
}

// RevokeToken revokes a custom token in the runtime and marks it revoked. A token that is unknown,
// already revoked or of another org is apperr.ErrNotFound.
func (s *Service) RevokeToken(ctx context.Context, actor audit.Actor, orgID, tokenID string) error {
	q := s.st.Q()
	row, err := q.GetToken(ctx, db.GetTokenParams{ID: tokenID, OrgID: orgID})
	if errors.Is(err, sql.ErrNoRows) || (err == nil && row.RevokedAt.Valid) {
		return fmt.Errorf("keys: token %s: %w", tokenID, apperr.ErrNotFound)
	} else if err != nil {
		return fmt.Errorf("keys: revoke token: %w", err)
	}
	org, err := s.orgs.Get(ctx, orgID)
	if err != nil {
		return err
	}
	if err := s.rt.With(s.root).RevokeTenantKey(ctx, org.TenantID, row.RuntimeKeyID); err != nil && !runtime.IsNotFound(err) {
		return fmt.Errorf("keys: revoke token: runtime: %w", err)
	}
	err = s.st.Tx(ctx, func(q *db.Queries) error {
		n, err := q.RevokeToken(ctx, db.RevokeTokenParams{RevokedAt: sql.NullInt64{Int64: s.now().UnixMilli(), Valid: true}, ID: tokenID, OrgID: orgID})
		if err != nil {
			return err
		}
		if n == 0 {
			return fmt.Errorf("keys: token %s: %w", tokenID, apperr.ErrNotFound)
		}
		return s.log().Log(ctx, q, actor, orgID, "token.revoke", tokenID, map[string]string{"name": row.Name})
	})
	if err != nil {
		return fmt.Errorf("keys: revoke token: %w", err)
	}
	return nil
}

// RotateDefault replaces orgID's default key. The new key is minted with the root credential; one tx swaps
// the sealed value and queues the old key in pending_key_revokes; the DefaultCred cache is dropped; then
// the old key is revoked and the queue row deleted. A failed revoke keeps the row for RetryPendingRevokes
// and is not an error: the rotation itself succeeded. Custom tokens are unaffected.
func (s *Service) RotateDefault(ctx context.Context, actor audit.Actor, orgID string) error {
	row, err := s.st.Q().GetOrgByID(ctx, orgID)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("keys: org %s: %w", orgID, apperr.ErrNotFound)
	} else if err != nil {
		return fmt.Errorf("keys: rotate: %w", err)
	}
	root := s.rt.With(s.root)
	key, err := root.CreateTenantKey(ctx, row.TenantID, runtime.KeyCreate{Name: defaultKeyName, Scopes: authz.DefaultKeyScopes()})
	if err != nil {
		return fmt.Errorf("keys: rotate: mint: %w", err)
	}
	if s.beforeSwap != nil {
		s.beforeSwap(key)
	}
	sealed, err := s.sealer.Seal([]byte(key.Secret))
	if err == nil {
		err = s.st.Tx(ctx, func(q *db.Queries) error {
			n, err := q.UpdateOrgDefaultKey(ctx, db.UpdateOrgDefaultKeyParams{DefaultKeyID: key.ID, DefaultKeySealed: sealed, ID: orgID, OldKeyID: row.DefaultKeyID})
			if err != nil {
				return err
			}
			if n == 0 {
				// Another rotation (or a delete) changed the org first; our minted key is revoked below.
				return apperr.Conflict{Code: "rotation_in_progress"}
			}
			if err := q.AddPendingKeyRevoke(ctx, db.AddPendingKeyRevokeParams{KeyID: row.DefaultKeyID, TenantID: row.TenantID, CreatedAt: s.now().UnixMilli()}); err != nil {
				return err
			}
			return s.log().Log(ctx, q, actor, orgID, "defaultkey.rotate", orgID, map[string]string{"old_key_id": row.DefaultKeyID, "new_key_id": key.ID})
		})
	}
	if err != nil {
		if rerr := root.RevokeTenantKey(ctx, row.TenantID, key.ID); rerr != nil && !runtime.IsNotFound(rerr) {
			slog.Error("keys: revoke unused rotated key failed", "tenant_id", row.TenantID, "key_id", key.ID, "err", rerr)
		}
		return fmt.Errorf("keys: rotate: %w", err)
	}
	s.orgs.InvalidateCred(orgID)
	if s.beforeRevoke != nil {
		s.beforeRevoke()
	}
	s.revokePending(ctx, db.PendingKeyRevoke{KeyID: row.DefaultKeyID, TenantID: row.TenantID})
	return nil
}

// RetryPendingRevokes retries runtime revokes of rotated-out default keys. Rows are deleted on success
// (or when the key is already gone) and their attempt count bumped on failure.
func (s *Service) RetryPendingRevokes(ctx context.Context) error {
	rows, err := s.st.Q().ListPendingKeyRevokes(ctx, retryBatch)
	if err != nil {
		return fmt.Errorf("keys: retry revokes: %w", err)
	}
	for _, r := range rows {
		s.revokePending(ctx, r)
	}
	return nil
}

// RunRetrier calls RetryPendingRevokes now and every RetryInterval until ctx is done.
func (s *Service) RunRetrier(ctx context.Context) {
	t := time.NewTicker(RetryInterval)
	defer t.Stop()
	for {
		if err := s.RetryPendingRevokes(ctx); err != nil {
			slog.Error("keys: retry pending revokes", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (s *Service) revokePending(ctx context.Context, r db.PendingKeyRevoke) {
	q := s.st.Q()
	err := s.rt.With(s.root).RevokeTenantKey(ctx, r.TenantID, r.KeyID)
	if err == nil || runtime.IsNotFound(err) {
		if _, derr := q.DeletePendingKeyRevoke(ctx, r.KeyID); derr != nil {
			slog.Error("keys: delete pending revoke", "key_id", r.KeyID, "err", derr)
		}
		return
	}
	slog.Warn("keys: revoke old default key failed, will retry", "tenant_id", r.TenantID, "key_id", r.KeyID, "err", err)
	if _, ierr := q.IncPendingKeyRevokeAttempts(ctx, r.KeyID); ierr != nil {
		slog.Error("keys: bump pending revoke attempts", "key_id", r.KeyID, "err", ierr)
	}
}
