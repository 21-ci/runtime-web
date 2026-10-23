package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"database/sql"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/seal"
	"github.com/21cloud/runtime-web/internal/store"
	"github.com/21cloud/runtime-web/internal/store/db"
)

const (
	// totpPeriod is the RFC 6238 time step in seconds.
	totpPeriod = 30
	// totpSkew is how many steps either side of now are accepted.
	totpSkew     = 1
	totpDigits   = 6
	totpSecretSz = 20
	// MaxTOTPFailures is the second-factor failure budget per user per
	// LoginFailureWindow, shared by TOTP and recovery codes.
	MaxTOTPFailures = 5
	// totpLimiterIP keys second-factor failures in the login limiter.
	totpLimiterIP = "totp"
	// DefaultTOTPIssuer labels the account in authenticator apps.
	DefaultTOTPIssuer = "Runtime Web"
)

// ErrInvalidCode is the single failure for a wrong, malformed, replayed or
// already-used TOTP or recovery code.
var ErrInvalidCode = errors.New("auth: invalid code")

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// TOTP manages RFC 6238 second factors (SHA-1, 6 digits, 30 s, ±1 step)
// and their recovery codes. Secrets are sealed at rest.
type TOTP struct {
	Q *db.Queries
	// Store runs multi-row writes in one transaction.
	Store   *store.Store
	Sealer  *seal.Sealer
	Now     func() time.Time
	Hasher  Hasher
	Limiter *Limiter
	// Issuer labels the otpauth URL (DefaultTOTPIssuer when empty).
	Issuer string
}

func (t *TOTP) now() time.Time {
	if t.Now != nil {
		return t.Now()
	}
	return time.Now()
}

// totpCode is the 6-digit RFC 4226 HOTP value of secret at step.
func totpCode(secret []byte, step int64) string {
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(step))
	m := hmac.New(sha1.New, secret)
	m.Write(msg[:])
	sum := m.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	v := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	return fmt.Sprintf("%0*d", totpDigits, v%1_000_000)
}

func validCodeShape(code string) bool {
	if len(code) != totpDigits {
		return false
	}
	for _, c := range code {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func normalizeCode(code string) string {
	return strings.Map(func(r rune) rune {
		if r == ' ' || r == '-' {
			return -1
		}
		return r
	}, strings.ToLower(strings.TrimSpace(code)))
}

// Enroll starts (or restarts) an unconfirmed enrollment and returns the
// otpauth URL. A confirmed TOTP is a totp_already_enabled conflict.
func (t *TOTP) Enroll(ctx context.Context, userID string) (string, error) {
	u, err := t.Q.GetUserByID(ctx, userID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("auth: user: %w", apperr.ErrNotFound)
	}
	if err != nil {
		return "", fmt.Errorf("auth: get user: %w", err)
	}
	if on, err := t.Enabled(ctx, userID); err != nil {
		return "", err
	} else if on {
		return "", fmt.Errorf("auth: enroll totp: %w", apperr.Conflict{Code: "totp_already_enabled"})
	}
	secret := make([]byte, totpSecretSz)
	if _, err := rand.Read(secret); err != nil {
		return "", fmt.Errorf("auth: totp secret: %w", err)
	}
	sealed, err := t.Sealer.Seal(secret)
	if err != nil {
		return "", fmt.Errorf("auth: seal totp secret: %w", err)
	}
	if _, err := t.Q.DeletePendingUserTOTP(ctx, userID); err != nil {
		return "", fmt.Errorf("auth: clear pending totp: %w", err)
	}
	if err := t.Q.CreateUserTOTP(ctx, db.CreateUserTOTPParams{UserID: userID, SecretSealed: sealed}); err != nil {
		return "", fmt.Errorf("auth: create totp: %w", err)
	}
	issuer := t.Issuer
	if issuer == "" {
		issuer = DefaultTOTPIssuer
	}
	v := url.Values{}
	v.Set("secret", b32.EncodeToString(secret))
	v.Set("issuer", issuer)
	v.Set("algorithm", "SHA1")
	v.Set("digits", "6")
	v.Set("period", "30")
	label := url.PathEscape(issuer + ":" + u.Email)
	return "otpauth://totp/" + label + "?" + v.Encode(), nil
}

// Enabled reports whether userID has a confirmed TOTP.
func (t *TOTP) Enabled(ctx context.Context, userID string) (bool, error) {
	row, err := t.Q.GetUserTOTP(ctx, userID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("auth: get totp: %w", err)
	}
	return row.EnabledAt.Valid, nil
}

// Confirm activates a pending enrollment with a valid code and returns the
// recovery codes. They are shown only this once; only hashes are kept.
func (t *TOTP) Confirm(ctx context.Context, userID, code string) ([]string, error) {
	if err := t.check(ctx, userID, code, false); err != nil {
		return nil, err
	}
	var codes []string
	err := t.Store.Tx(ctx, func(q *db.Queries) error {
		n, err := q.ActivateUserTOTP(ctx, db.ActivateUserTOTPParams{
			EnabledAt: sql.NullInt64{Int64: t.now().UnixMilli(), Valid: true}, UserID: userID,
		})
		if err != nil {
			return fmt.Errorf("auth: activate totp: %w", err)
		}
		if n == 0 {
			return ErrInvalidCode
		}
		codes, err = newRecoveryCodes(ctx, q, userID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return codes, nil
}

// Verify checks a TOTP code for a user with confirmed TOTP. Codes at or
// before the last used step are replays and fail.
func (t *TOTP) Verify(ctx context.Context, userID, code string) error {
	return t.check(ctx, userID, code, true)
}

// check verifies code against userID's secret; enabled selects confirmed
// (true) or pending (false) enrollments. Failures count toward the limiter.
func (t *TOTP) check(ctx context.Context, userID, code string, enabled bool) error {
	if err := t.blocked(ctx, userID); err != nil {
		return err
	}
	row, err := t.Q.GetUserTOTP(ctx, userID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && row.EnabledAt.Valid != enabled) {
		return t.fail(ctx, userID)
	}
	if err != nil {
		return fmt.Errorf("auth: get totp: %w", err)
	}
	code = normalizeCode(code)
	if !validCodeShape(code) {
		return t.fail(ctx, userID)
	}
	secret, err := t.Sealer.Open(row.SecretSealed)
	if err != nil {
		return fmt.Errorf("auth: open totp secret: %w", err)
	}
	now := t.now().Unix() / totpPeriod
	var matched int64 = -1
	for d := int64(-totpSkew); d <= totpSkew; d++ {
		want := totpCode(secret, now+d)
		if subtle.ConstantTimeCompare([]byte(want), []byte(code)) == 1 {
			matched = now + d
		}
	}
	if matched < 0 {
		return t.fail(ctx, userID)
	}
	// Advancing only when the step is newer rejects replays atomically.
	n, err := t.Q.AdvanceTOTPStep(ctx, db.AdvanceTOTPStepParams{Step: matched, UserID: userID})
	if err != nil {
		return fmt.Errorf("auth: advance totp step: %w", err)
	}
	if n == 0 {
		return t.fail(ctx, userID)
	}
	return t.Limiter.Reset(ctx, totpLimiterIP, userID)
}

// UseRecovery consumes one recovery code of a user with confirmed TOTP.
func (t *TOTP) UseRecovery(ctx context.Context, userID, code string) error {
	if err := t.blocked(ctx, userID); err != nil {
		return err
	}
	on, err := t.Enabled(ctx, userID)
	if err != nil {
		return err
	}
	norm := normalizeCode(code)
	if !on || norm == "" {
		return t.fail(ctx, userID)
	}
	n, err := t.Q.ConsumeRecoveryCode(ctx, db.ConsumeRecoveryCodeParams{
		UsedAt: sql.NullInt64{Int64: t.now().UnixMilli(), Valid: true}, UserID: userID, Hash: hashRecovery(norm),
	})
	if err != nil {
		return fmt.Errorf("auth: consume recovery code: %w", err)
	}
	if n == 0 {
		return t.fail(ctx, userID)
	}
	return t.Limiter.Reset(ctx, totpLimiterIP, userID)
}

// Disable removes TOTP and recovery codes and revokes the user's sessions
// other than currentSessionID; it needs the password and a current TOTP
// code.
func (t *TOTP) Disable(ctx context.Context, userID, currentSessionID, password, code string) error {
	if err := t.checkPassword(ctx, userID, password); err != nil {
		return err
	}
	if err := t.Verify(ctx, userID, code); err != nil {
		return err
	}
	return t.Store.Tx(ctx, func(q *db.Queries) error {
		if err := clear2FA(ctx, q, userID); err != nil {
			return err
		}
		_, err := q.DeleteSessionsForUserExcept(ctx, db.DeleteSessionsForUserExceptParams{UserID: userID, ExceptIDHash: currentSessionID})
		if err != nil {
			return fmt.Errorf("auth: revoke user sessions: %w", err)
		}
		return nil
	})
}

// Regenerate replaces every recovery code; it needs the password.
func (t *TOTP) Regenerate(ctx context.Context, userID, password string) ([]string, error) {
	if err := t.checkPassword(ctx, userID, password); err != nil {
		return nil, err
	}
	on, err := t.Enabled(ctx, userID)
	if err != nil {
		return nil, err
	}
	if !on {
		return nil, fmt.Errorf("auth: regenerate recovery codes: %w", apperr.Conflict{Code: "totp_not_enabled"})
	}
	var codes []string
	err = t.Store.Tx(ctx, func(q *db.Queries) error {
		codes, err = newRecoveryCodes(ctx, q, userID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return codes, nil
}

func (t *TOTP) checkPassword(ctx context.Context, userID, password string) error {
	if err := t.blocked(ctx, userID); err != nil {
		return err
	}
	u, err := t.Q.GetUserByID(ctx, userID)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("auth: user: %w", apperr.ErrNotFound)
	}
	if err != nil {
		return fmt.Errorf("auth: get user: %w", err)
	}
	if !t.Hasher.Verify(u.PasswordHash, password) {
		if err := t.Limiter.Fail(ctx, totpLimiterIP, userID); err != nil {
			return err
		}
		return ErrInvalidCredentials
	}
	return nil
}

func (t *TOTP) blocked(ctx context.Context, userID string) error {
	b, err := t.Limiter.blockedAt(ctx, totpLimiterIP, userID, MaxTOTPFailures)
	if err != nil {
		return err
	}
	if b {
		return fmt.Errorf("auth: second factor: %w", apperr.ErrRateLimited)
	}
	return nil
}

func (t *TOTP) fail(ctx context.Context, userID string) error {
	if err := t.Limiter.Fail(ctx, totpLimiterIP, userID); err != nil {
		return err
	}
	return ErrInvalidCode
}

// clear2FA deletes a user's TOTP and recovery codes.
func clear2FA(ctx context.Context, q *db.Queries, userID string) error {
	if _, err := q.DeleteRecoveryCodes(ctx, userID); err != nil {
		return fmt.Errorf("auth: delete recovery codes: %w", err)
	}
	if _, err := q.DeleteUserTOTP(ctx, userID); err != nil {
		return fmt.Errorf("auth: delete totp: %w", err)
	}
	return nil
}
