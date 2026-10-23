package netx

import (
	"net/http/httptest"
	"net/netip"
	"testing"
)

var trusted = []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8"), netip.MustParsePrefix("127.0.0.1/32")}

func TestClientIPTrustedProxyUsesRightmostXFF(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "10.0.0.5:4000"
	r.Header.Add("X-Forwarded-For", "6.6.6.6, 1.2.3.4")
	r.Header.Add("X-Forwarded-For", "203.0.113.9, 10.0.0.7")
	if got := ClientIP(r, trusted); got != "203.0.113.9" {
		t.Fatalf("ClientIP = %q, want 203.0.113.9", got)
	}
}

func TestClientIPUntrustedPeerIgnoresXFF(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "198.51.100.2:4000"
	r.Header.Set("X-Forwarded-For", "1.2.3.4")
	if got := ClientIP(r, trusted); got != "198.51.100.2" {
		t.Fatalf("ClientIP = %q, want 198.51.100.2", got)
	}
	if got := ClientIP(r, nil); got != "198.51.100.2" {
		t.Fatalf("ClientIP(no trust) = %q", got)
	}
}

func TestClientIPAllTrustedOrGarbage(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "[::ffff:10.0.0.5]:4000"
	r.Header.Set("X-Forwarded-For", "10.0.0.9, not-an-ip")
	if got := ClientIP(r, trusted); got != "10.0.0.5" {
		t.Fatalf("ClientIP = %q, want peer 10.0.0.5", got)
	}
}

func TestParsePrefixes(t *testing.T) {
	ps, err := ParsePrefixes(" 10.0.0.0/8, 127.0.0.1 ,")
	if err != nil || len(ps) != 2 || ps[1].Bits() != 32 {
		t.Fatalf("ParsePrefixes = %v, %v", ps, err)
	}
	if _, err := ParsePrefixes("nope"); err == nil {
		t.Fatal("want error")
	}
}
