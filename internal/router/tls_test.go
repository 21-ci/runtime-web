package router

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func writeSelfSigned(t *testing.T, dir, prefix string, names ...string) (string, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: names[0]},
		DNSNames:     names,
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	kb, _ := x509.MarshalECPrivateKey(key)
	cp, kp := filepath.Join(dir, prefix+".crt"), filepath.Join(dir, prefix+".key")
	if err := os.WriteFile(cp, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(kp, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}), 0o600); err != nil {
		t.Fatal(err)
	}
	return cp, kp
}

func tlsTestTable() *Table {
	tb := &Table{}
	tb.Store(&Routes{ConsoleHost: "console.example.net", BaseDomain: "apps.test",
		Hosts: map[string]HostRoute{"shop.example.com": {Slug: "shop"}}})
	return tb
}

func fileOpts(t *testing.T) TLSOptions {
	dir := t.TempDir()
	cp, kp := writeSelfSigned(t, dir, "wild", "apps.test", "*.apps.test")
	return TLSOptions{BaseDomain: "apps.test", ConsoleHost: "console.example.net",
		WildcardCert: cp, WildcardKey: kp, StorageDir: filepath.Join(dir, "store"), Table: tlsTestTable()}
}

func TestTLSDecisionOnlyActiveCustom(t *testing.T) {
	m, err := NewTLS(fileOpts(t))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := m.Decide(ctx, "shop.example.com"); err != nil {
		t.Fatalf("active custom rejected: %v", err)
	}
	for _, h := range []string{"a.apps.test", "apps.test", "x.y.apps.test", "console.example.net", "unknown.example.org"} {
		if m.Decide(ctx, h) == nil {
			t.Errorf("Decide(%q) allowed", h)
		}
	}
	c, err := m.GetCertificate(&tls.ClientHelloInfo{ServerName: "a.apps.test"})
	if err != nil {
		t.Fatal(err)
	}
	leaf, _ := x509.ParseCertificate(c.Certificate[0])
	if leaf.VerifyHostname("a.apps.test") != nil {
		t.Fatalf("a.apps.test not served by wildcard: %v", leaf.DNSNames)
	}
}

func TestWildcardFromFiles(t *testing.T) {
	o := fileOpts(t)
	m, err := NewTLS(o)
	if err != nil {
		t.Fatal(err)
	}
	c1, err := m.GetCertificate(&tls.ClientHelloInfo{ServerName: "apps.test"})
	if err != nil {
		t.Fatal(err)
	}
	// replace files; reload after mtime change
	time.Sleep(20 * time.Millisecond)
	writeSelfSigned(t, filepath.Dir(o.WildcardCert), "wild", "apps.test", "*.apps.test")
	future := time.Now().Add(time.Minute)
	_ = os.Chtimes(o.WildcardCert, future, future)
	m.wildFile.mu.Lock()
	m.wildFile.checked = time.Time{}
	m.wildFile.mu.Unlock()
	c2, err := m.GetCertificate(&tls.ClientHelloInfo{ServerName: "b.apps.test"})
	if err != nil {
		t.Fatal(err)
	}
	if string(c1.Certificate[0]) == string(c2.Certificate[0]) {
		t.Fatal("wildcard cert not reloaded")
	}
	bad := o
	bad.WildcardKey = filepath.Join(t.TempDir(), "missing.key")
	if _, err := NewTLS(bad); err == nil {
		t.Fatal("missing key file accepted")
	}
	none := o
	none.WildcardCert, none.WildcardKey = "", ""
	if _, err := NewTLS(none); err == nil {
		t.Fatal("no wildcard source accepted")
	}
}

func TestDNS01ConfigCloudflareOnly(t *testing.T) {
	base := TLSOptions{BaseDomain: "apps.test", Table: tlsTestTable(), StorageDir: t.TempDir()}
	o := base
	o.DNSProvider, o.CloudflareToken = "route53", "x"
	if err := o.Validate(); err == nil || !strings.Contains(err.Error(), "only cloudflare") {
		t.Fatalf("want provider error, got %v", err)
	}
	o.DNSProvider, o.CloudflareToken = "cloudflare", ""
	if o.Validate() == nil {
		t.Fatal("missing token accepted")
	}
	o.CloudflareToken = "tok"
	m, err := NewTLS(o)
	if err != nil {
		t.Fatal(err)
	}
	if m.dns == nil || m.wildFile != nil {
		t.Fatal("cloudflare DNS-01 config not used for wildcard")
	}
}

func TestHTTPRedirectsToHTTPS(t *testing.T) {
	h := RedirectHandler(nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "http://shop.example.com:80/a/b?x=1&y=2", nil))
	if rec.Code != http.StatusPermanentRedirect {
		t.Fatalf("code %d", rec.Code)
	}
	if got := rec.Header().Get("Location"); got != "https://shop.example.com/a/b?x=1&y=2" {
		t.Fatalf("location %q", got)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "http://shop.example.com/.well-known/acme-challenge/tok", nil))
	if rec.Code == http.StatusPermanentRedirect {
		t.Fatal("acme challenge redirected")
	}
}

func TestCertStatusReported(t *testing.T) {
	var mu sync.Mutex
	var got []map[string]CertStatus
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer s3cret" || r.URL.Path != "/api/internal/router/cert-status" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body struct {
			Hosts map[string]CertStatus `json:"hosts"`
		}
		b, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(b, &body); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		got = append(got, body.Hosts)
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	tb := tlsTestTable()
	r := tb.Load()
	r.Hosts["bad.example.com"] = HostRoute{Slug: "b"}
	r.Hosts["new.example.com"] = HostRoute{Slug: "n"}
	exp := time.UnixMilli(1_900_000_000_000)
	c := &CertReporter{URL: srv.URL + "/api/internal/router/cert-status", Secret: "s3cret", Table: tb,
		Interval: time.Hour,
		Lookup: func(_ context.Context, h string) (time.Time, bool) {
			return exp, h == "shop.example.com"
		}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)
	_ = c.OnEvent(ctx, "cert_obtained", map[string]any{"identifier": "shop.example.com"})
	_ = c.OnEvent(ctx, "cert_failed", map[string]any{"identifier": "bad.example.com", "error": errors.New("rate limited")})
	_ = c.OnEvent(ctx, "cert_obtained", map[string]any{"identifier": "a.apps.test"}) // not custom: ignored

	deadline := time.Now().Add(3 * time.Second)
	for {
		mu.Lock()
		n := len(got)
		mu.Unlock()
		if n > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no report posted")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := c.Report(ctx); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	last := got[len(got)-1]
	mu.Unlock()
	if s := last["shop.example.com"]; s.Status != "issued" || s.NotAfter == nil || *s.NotAfter != exp.UnixMilli() {
		t.Errorf("shop: %+v", s)
	}
	if s := last["bad.example.com"]; s.Status != "error" || s.Error == nil || *s.Error != "rate limited" {
		t.Errorf("bad: %+v", s)
	}
	if s := last["new.example.com"]; s.Status != "pending" {
		t.Errorf("new: %+v", s)
	}
	if _, ok := last["a.apps.test"]; ok {
		t.Error("base-domain host reported")
	}
}

// TestOnDemandIssuesViaPebble needs a running Pebble (PEBBLE_VA_ALWAYS_VALID=1):
// ROUTER_TEST_ACME_CA=https://localhost:14000/dir ROUTER_TEST_ACME_ROOT=<pebble.minica.pem>.
func TestOnDemandIssuesViaPebble(t *testing.T) {
	if testing.Short() {
		t.Skip("-short")
	}
	ca, root := os.Getenv("ROUTER_TEST_ACME_CA"), os.Getenv("ROUTER_TEST_ACME_ROOT")
	if ca == "" || root == "" {
		t.Skip("ROUTER_TEST_ACME_CA/ROUTER_TEST_ACME_ROOT not set")
	}
	pemb, err := os.ReadFile(root)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(pemb)
	o := fileOpts(t)
	o.CA, o.TrustedRoots, o.Email = ca, pool, "ops@example.com"
	m, err := NewTLS(o)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := tls.Listen("tcp", "127.0.0.1:0", m.TLSConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) { _ = c.(*tls.Conn).Handshake(); c.Close() }(c)
		}
	}()
	conn, err := tls.DialWithDialer(&net.Dialer{Timeout: 60 * time.Second}, "tcp", ln.Addr().String(),
		&tls.Config{ServerName: "shop.example.com", InsecureSkipVerify: true})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	leaf := conn.ConnectionState().PeerCertificates[0]
	if leaf.VerifyHostname("shop.example.com") != nil || leaf.Issuer.CommonName == leaf.Subject.CommonName {
		t.Fatalf("unexpected cert %v issued by %v", leaf.DNSNames, leaf.Issuer)
	}
	if _, err := tls.Dial("tcp", ln.Addr().String(), &tls.Config{ServerName: "evil.example.org", InsecureSkipVerify: true}); err == nil {
		t.Fatal("unknown host got a cert")
	}
}
