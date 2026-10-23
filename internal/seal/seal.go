// Package seal encrypts secrets at rest with AES-256-GCM.
package seal

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
)

const nonceSize = 12

// ErrOpen is returned when sealed data is truncated or fails authentication.
var ErrOpen = errors.New("seal: open failed")

// Sealer seals and opens byte slices with one key.
type Sealer struct {
	aead cipher.AEAD
}

// New returns a Sealer for key.
func New(key [32]byte) *Sealer {
	block, err := aes.NewCipher(key[:])
	if err != nil {
		panic(fmt.Sprintf("seal: aes key: %v", err)) // unreachable: key is 32 bytes
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		panic(fmt.Sprintf("seal: gcm: %v", err)) // unreachable: AES block size is valid
	}
	return &Sealer{aead: aead}
}

// Seal encrypts plain and returns nonce || ciphertext.
func (s *Sealer) Seal(plain []byte) ([]byte, error) {
	nonce := make([]byte, nonceSize)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("seal: nonce: %w", err)
	}
	return s.aead.Seal(nonce, nonce, plain, nil), nil
}

// Open decrypts data produced by Seal.
func (s *Sealer) Open(sealed []byte) ([]byte, error) {
	if len(sealed) < nonceSize+s.aead.Overhead() {
		return nil, ErrOpen
	}
	nonce, body := sealed[:nonceSize], sealed[nonceSize:]
	plain, err := s.aead.Open(nil, nonce, body, nil)
	if err != nil {
		return nil, ErrOpen
	}
	return plain, nil
}
