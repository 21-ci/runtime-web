package auth

import (
	"errors"
	"strings"
	"testing"

	"github.com/21cloud/runtime-web/internal/apperr"
)

func TestPasswordRoundTripAndWrong(t *testing.T) {
	h := Argon2{}
	hash, err := h.Hash("correct horse battery")
	if err != nil {
		t.Fatalf("Hash: %v", err)
	}
	if !strings.HasPrefix(hash, "$argon2id$v=19$m=65536,t=3,p=2$") {
		t.Fatalf("hash = %q, want argon2id PHC with m=65536,t=3,p=2", hash)
	}
	hash2, _ := h.Hash("correct horse battery")
	if hash == hash2 {
		t.Error("two hashes of the same password are equal; salt not random")
	}

	tests := []struct {
		name string
		hash string
		pw   string
		want bool
	}{
		{"right", hash, "correct horse battery", true},
		{"wrong", hash, "correct horse batterz", false},
		{"empty password", hash, "", false},
		{"empty hash", "", "correct horse battery", false},
		{"garbage hash", "$argon2id$v=19$m=x$y$z", "correct horse battery", false},
		{"other algo", "$2a$10$abcdefghijklmnopqrstuv", "correct horse battery", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := h.Verify(tt.hash, tt.pw); got != tt.want {
				t.Errorf("Verify = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestValidatePassword(t *testing.T) {
	if err := ValidatePassword("12345678901"); !errors.Is(err, apperr.ErrInvalid) {
		t.Errorf("11 chars: err = %v, want ErrInvalid", err)
	}
	if err := ValidatePassword("123456789012"); err != nil {
		t.Errorf("12 chars: err = %v, want nil", err)
	}
}
