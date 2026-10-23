package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/21cloud/runtime-web/internal/store/db"
)

// RecoveryCodeCount is how many recovery codes a user gets at a time.
const RecoveryCodeCount = 10

// hashRecovery returns the stored hash of a normalized recovery code.
func hashRecovery(norm string) string {
	sum := sha256.Sum256([]byte(norm))
	return hex.EncodeToString(sum[:])
}

// newRecoveryCode returns an 80-bit code shaped xxxx-xxxx-xxxx-xxxx.
func newRecoveryCode() (string, error) {
	raw := make([]byte, 10)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("auth: recovery code: %w", err)
	}
	s := strings.ToLower(b32.EncodeToString(raw))
	return s[0:4] + "-" + s[4:8] + "-" + s[8:12] + "-" + s[12:16], nil
}

// newRecoveryCodes replaces userID's recovery codes and returns the new
// plaintext codes; only their sha256 hashes are stored. Run it in a
// transaction so old codes are never lost without new ones.
func newRecoveryCodes(ctx context.Context, q *db.Queries, userID string) ([]string, error) {
	codes := make([]string, 0, RecoveryCodeCount)
	for len(codes) < RecoveryCodeCount {
		c, err := newRecoveryCode()
		if err != nil {
			return nil, err
		}
		codes = append(codes, c)
	}
	if _, err := q.DeleteRecoveryCodes(ctx, userID); err != nil {
		return nil, fmt.Errorf("auth: delete recovery codes: %w", err)
	}
	for _, c := range codes {
		err := q.CreateRecoveryCode(ctx, db.CreateRecoveryCodeParams{UserID: userID, Hash: hashRecovery(normalizeCode(c))})
		if err != nil {
			return nil, fmt.Errorf("auth: store recovery code: %w", err)
		}
	}
	return codes, nil
}
