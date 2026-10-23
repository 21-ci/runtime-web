// Package auth holds local passwords, sessions, CSRF and Origin checks,
// login rate limiting, login history and first-run setup.
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/21cloud/runtime-web/internal/apperr"
	"golang.org/x/crypto/argon2"
)

// MinPasswordLength is the minimum password length in characters.
const MinPasswordLength = 12

// Hasher hashes and verifies passwords.
type Hasher interface {
	Hash(p string) (string, error)
	Verify(hash, p string) bool
}

// Argon2 is the argon2id Hasher (m=64 MiB, t=3, p=2, 16-byte salt, PHC string).
type Argon2 struct{}

const (
	argonMemory  = 64 * 1024
	argonTime    = 3
	argonThreads = 2
	argonSaltLen = 16
	argonKeyLen  = 32
)

var b64 = base64.RawStdEncoding

// Hash returns the PHC string for p.
func (Argon2) Hash(p string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("auth: salt: %w", err)
	}
	key := argon2.IDKey([]byte(p), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads, b64.EncodeToString(salt), b64.EncodeToString(key)), nil
}

// Verify reports whether p matches hash, comparing in constant time.
func (Argon2) Verify(hash, p string) bool {
	parts := strings.Split(hash, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" {
		return false
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false
	}
	var m, t uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &threads); err != nil {
		return false
	}
	// Refuse absurd parameters so a corrupt row cannot exhaust memory.
	if m == 0 || m > 1<<20 || t == 0 || t > 16 || threads == 0 {
		return false
	}
	salt, err := b64.DecodeString(parts[4])
	if err != nil || len(salt) == 0 {
		return false
	}
	want, err := b64.DecodeString(parts[5])
	if err != nil || len(want) == 0 || len(want) > 128 {
		return false
	}
	got := argon2.IDKey([]byte(p), salt, t, m, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// ValidatePassword enforces the password policy.
func ValidatePassword(p string) error {
	if utf8.RuneCountInString(p) < MinPasswordLength {
		return fmt.Errorf("auth: password shorter than %d characters: %w", MinPasswordLength, apperr.ErrInvalid)
	}
	return nil
}
