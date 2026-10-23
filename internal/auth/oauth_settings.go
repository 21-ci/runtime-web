package auth

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/store/db"
)

// ProviderSetting is the admin view of one login provider. The secret is never included; SecretSet
// says whether one is stored.
type ProviderSetting struct {
	ID        string
	Enabled   bool
	ClientID  string
	Issuer    string
	Name      string
	SecretSet bool
}

// Settings returns every known provider, enabled or not, for the admin settings view.
func (o *OAuth) Settings(ctx context.Context) ([]ProviderSetting, error) {
	q := o.Service.Store.Q()
	out := make([]ProviderSetting, 0, 3)
	for _, id := range []string{ProviderGitHub, ProviderGoogle, ProviderOIDC} {
		ps := ProviderSetting{ID: id}
		row, err := q.GetSetting(ctx, settingKey(id))
		switch {
		case errors.Is(err, sql.ErrNoRows):
		case err != nil:
			return nil, fmt.Errorf("auth: oauth settings %s: %w", id, err)
		default:
			var sp storedProvider
			if err := json.Unmarshal(row.Value, &sp); err != nil {
				return nil, fmt.Errorf("auth: oauth settings decode %s: %w", id, err)
			}
			ps.Enabled, ps.ClientID, ps.Issuer, ps.Name = sp.Enabled, sp.ClientID, sp.Issuer, sp.Name
		}
		_, err = q.GetSetting(ctx, secretSettingKey(id))
		switch {
		case errors.Is(err, sql.ErrNoRows):
		case err != nil:
			return nil, fmt.Errorf("auth: oauth settings secret %s: %w", id, err)
		default:
			ps.SecretSet = true
		}
		out = append(out, ps)
	}
	return out, nil
}

// preparedProvider is a validated provider ready to write: the settings JSON and, when a new
// secret was given, the sealed secret. Nothing is stored until write.
type preparedProvider struct {
	id      string
	enabled bool
	raw     []byte
	sealed  []byte // nil keeps the stored secret
}

// prepareProvider validates p and seals its secret without touching the store.
func (o *OAuth) prepareProvider(p ProviderConfig) (preparedProvider, error) {
	if !knownProvider(p.ID) {
		return preparedProvider{}, fmt.Errorf("auth: oauth provider %q: %w", p.ID, apperr.ErrInvalid)
	}
	if p.ID == ProviderOIDC {
		if err := o.requireURL(p.Issuer); err != nil {
			return preparedProvider{}, fmt.Errorf("auth: oauth issuer: %w", err)
		}
	}
	raw, err := json.Marshal(storedProvider{Enabled: p.Enabled, ClientID: p.ClientID, Issuer: p.Issuer, Name: p.Name})
	if err != nil {
		return preparedProvider{}, fmt.Errorf("auth: oauth encode: %w", err)
	}
	pp := preparedProvider{id: p.ID, enabled: p.Enabled, raw: raw}
	if p.ClientSecret == "" {
		return pp, nil
	}
	if o.Sealer == nil {
		return preparedProvider{}, fmt.Errorf("auth: oauth seal secret: no sealer")
	}
	sealed, err := o.Sealer.Seal([]byte(p.ClientSecret))
	if err != nil {
		return preparedProvider{}, fmt.Errorf("auth: oauth seal secret: %w", err)
	}
	pp.sealed = sealed
	return pp, nil
}

// write stores pp through q. Callers decide the transaction.
func (pp preparedProvider) write(ctx context.Context, q *db.Queries) error {
	if err := q.UpsertSetting(ctx, db.UpsertSettingParams{Key: settingKey(pp.id), Value: pp.raw}); err != nil {
		return fmt.Errorf("auth: oauth save %s: %w", pp.id, err)
	}
	if pp.sealed == nil {
		return nil
	}
	if err := q.UpsertSetting(ctx, db.UpsertSettingParams{Key: secretSettingKey(pp.id), Value: pp.sealed, Sealed: 1}); err != nil {
		return fmt.Errorf("auth: oauth save secret %s: %w", pp.id, err)
	}
	return nil
}

// SaveSettings validates the whole change before writing anything: every provider, then the
// resulting state, where password login may be disabled only while an enabled provider with a secret
// remains (sso_not_configured). It then writes the providers, the policy and inTx in one transaction.
func (o *OAuth) SaveSettings(ctx context.Context, providers []ProviderConfig, pol Policy, inTx func(*db.Queries) error) error {
	prepared := make([]preparedProvider, 0, len(providers))
	for _, p := range providers {
		pp, err := o.prepareProvider(p)
		if err != nil {
			return err
		}
		prepared = append(prepared, pp)
	}
	current, err := o.Settings(ctx)
	if err != nil {
		return err
	}
	state := map[string]ProviderSetting{}
	for _, ps := range current {
		state[ps.ID] = ps
	}
	for _, pp := range prepared {
		ps := state[pp.id]
		ps.Enabled = pp.enabled
		ps.SecretSet = ps.SecretSet || pp.sealed != nil
		state[pp.id] = ps
	}
	ssoOK := false
	for _, ps := range state {
		if ps.Enabled && ps.SecretSet {
			ssoOK = true
		}
	}
	if pol.PasswordLoginDisabled && !ssoOK {
		return fmt.Errorf("auth: save settings: %w", apperr.Conflict{Code: "sso_not_configured"})
	}
	return o.Service.Store.Tx(ctx, func(q *db.Queries) error {
		for _, pp := range prepared {
			if err := pp.write(ctx, q); err != nil {
				return err
			}
		}
		if err := writePolicy(ctx, q, pol); err != nil {
			return err
		}
		if inTx != nil {
			return inTx(q)
		}
		return nil
	})
}
