package auth

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/store/db"
)

// Settings keys of the instance auth policy.
const (
	settingRequire2FA            = "auth.require_2fa"
	settingPasswordLoginDisabled = "auth.password_login_disabled"
)

// Policy is the instance-wide auth policy, stored in settings.
type Policy struct {
	// Require2FA forces users without confirmed TOTP to enroll before using
	// anything but their profile (see RequireMFAEnrolled).
	Require2FA bool
	// PasswordLoginDisabled turns off password login for everyone but
	// instance admins. It needs an OAuth/OIDC provider.
	PasswordLoginDisabled bool
}

// mfaEnrollmentAllowed are the routes a user who must enroll may call.
// A trailing "/*" matches the prefix and anything below it.
var mfaEnrollmentAllowed = []string{"/api/me", "/api/me/totp/*", "/api/auth/logout"}

func (s *Service) flag(ctx context.Context, key string) (bool, error) {
	row, err := s.Store.Q().GetSetting(ctx, key)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("auth: get setting %s: %w", key, err)
	}
	return string(row.Value) == "1", nil
}

// Policy loads the instance auth policy; unset keys are false.
func (s *Service) Policy(ctx context.Context) (Policy, error) {
	var p Policy
	var err error
	if p.Require2FA, err = s.flag(ctx, settingRequire2FA); err != nil {
		return Policy{}, err
	}
	if p.PasswordLoginDisabled, err = s.flag(ctx, settingPasswordLoginDisabled); err != nil {
		return Policy{}, err
	}
	return p, nil
}

// SetPolicy stores p. Disabling password login without a configured
// OAuth/OIDC provider is an sso_not_configured conflict.
func (s *Service) SetPolicy(ctx context.Context, p Policy) error {
	return s.SetPolicyWith(ctx, p, nil)
}

// SetPolicyWith stores p and runs inTx in the same transaction, so a caller's audit row commits or
// rolls back with the change. A nil inTx does nothing extra.
func (s *Service) SetPolicyWith(ctx context.Context, p Policy, inTx func(*db.Queries) error) error {
	if p.PasswordLoginDisabled && (s.SSOConfigured == nil || !s.SSOConfigured(ctx)) {
		return fmt.Errorf("auth: set policy: %w", apperr.Conflict{Code: "sso_not_configured"})
	}
	return s.Store.Tx(ctx, func(q *db.Queries) error {
		if err := writePolicy(ctx, q, p); err != nil {
			return err
		}
		if inTx != nil {
			return inTx(q)
		}
		return nil
	})
}

// writePolicy stores p through q.
func writePolicy(ctx context.Context, q *db.Queries, p Policy) error {
	for key, on := range map[string]bool{settingRequire2FA: p.Require2FA, settingPasswordLoginDisabled: p.PasswordLoginDisabled} {
		v := "0"
		if on {
			v = "1"
		}
		if err := q.UpsertSetting(ctx, db.UpsertSettingParams{Key: key, Value: []byte(v)}); err != nil {
			return fmt.Errorf("auth: set setting %s: %w", key, err)
		}
	}
	return nil
}

func pathAllowed(path string, allow []string) bool {
	for _, a := range allow {
		if prefix, ok := strings.CutSuffix(a, "/*"); ok {
			if path == prefix || strings.HasPrefix(path, prefix+"/") {
				return true
			}
		} else if path == a {
			return true
		}
	}
	return false
}

// RequireMFAEnrolled answers 403 mfa_enrollment_required when the policy
// requires 2FA and the caller has no confirmed TOTP, except on /api/me,
// /api/me/totp/*, /api/auth/logout and the extra allow patterns. It runs
// after RequireSession and checks policy and enrollment per request.
func (s *Service) RequireMFAEnrolled(allow ...string) func(http.Handler) http.Handler {
	allowed := append(append([]string{}, mfaEnrollmentAllowed...), allow...)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			p, ok := FromContext(r.Context())
			if !ok {
				writeError(w, http.StatusUnauthorized, "unauthenticated", "sign in required")
				return
			}
			if pathAllowed(r.URL.Path, allowed) {
				next.ServeHTTP(w, r)
				return
			}
			pol, err := s.Policy(r.Context())
			if err != nil {
				writeError(w, http.StatusInternalServerError, "internal", "internal error")
				return
			}
			if pol.Require2FA {
				on, err := s.TOTP.Enabled(r.Context(), p.User.ID)
				if err != nil {
					writeError(w, http.StatusInternalServerError, "internal", "internal error")
					return
				}
				if !on {
					writeError(w, http.StatusForbidden, "mfa_enrollment_required", "two-factor authentication must be set up")
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}
