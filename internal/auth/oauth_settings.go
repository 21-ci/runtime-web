package auth

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
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
