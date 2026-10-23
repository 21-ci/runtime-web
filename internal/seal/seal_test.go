package seal

import (
	"bytes"
	"errors"
	"testing"
)

func testKey() [32]byte {
	var k [32]byte
	for i := range k {
		k[i] = byte(i)
	}
	return k
}

func TestSealRoundTrip(t *testing.T) {
	tests := []struct {
		name  string
		plain []byte
	}{
		{name: "empty", plain: []byte{}},
		{name: "short", plain: []byte("client-secret")},
		{name: "long", plain: bytes.Repeat([]byte("x"), 4096)},
	}
	s := New(testKey())
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sealed, err := s.Seal(tt.plain)
			if err != nil {
				t.Fatalf("Seal() error = %v", err)
			}
			got, err := s.Open(sealed)
			if err != nil {
				t.Fatalf("Open() error = %v", err)
			}
			if !bytes.Equal(got, tt.plain) {
				t.Errorf("Open() = %q, want %q", got, tt.plain)
			}
		})
	}
}

func TestSealTamper(t *testing.T) {
	s := New(testKey())
	sealed, err := s.Seal([]byte("default-key-material"))
	if err != nil {
		t.Fatalf("Seal() error = %v", err)
	}
	for i := range sealed {
		tampered := bytes.Clone(sealed)
		tampered[i] ^= 0x01
		if _, err := s.Open(tampered); !errors.Is(err, ErrOpen) {
			t.Fatalf("Open() with byte %d flipped: error = %v, want ErrOpen", i, err)
		}
	}
	if _, err := s.Open(sealed[:4]); !errors.Is(err, ErrOpen) {
		t.Fatalf("Open() on truncated input: error = %v, want ErrOpen", err)
	}
}

func TestSealNonceUnique(t *testing.T) {
	s := New(testKey())
	plain := []byte("same plaintext")
	a, err := s.Seal(plain)
	if err != nil {
		t.Fatalf("Seal() error = %v", err)
	}
	b, err := s.Seal(plain)
	if err != nil {
		t.Fatalf("Seal() error = %v", err)
	}
	if bytes.Equal(a[:nonceSize], b[:nonceSize]) {
		t.Fatal("two seals of the same plaintext reused a nonce")
	}
	if bytes.Equal(a, b) {
		t.Fatal("two seals of the same plaintext produced identical output")
	}
}
