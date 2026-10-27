package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// upstream starts a fake rt on a loopback port and points rtInvoke / rtControl at it.
func upstream(t *testing.T, h http.HandlerFunc) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	addr := strings.TrimPrefix(srv.URL, "http://")
	oldI, oldC := rtInvoke, rtControl
	rtInvoke, rtControl = addr, addr
	t.Cleanup(func() { rtInvoke, rtControl = oldI, oldC })
}

func testConfig(t *testing.T, console string) *config {
	t.Helper()
	cu, _ := url.Parse(console)
	au, _ := url.Parse("https://apps.example.com")
	return &config{consoleURL: cu, appsURL: au, slug: "rtweb", trusted: []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}}
}

func TestEdgeRules(t *testing.T) {
	var got *http.Request
	upstream(t, func(w http.ResponseWriter, r *http.Request) { got = r.Clone(r.Context()); w.WriteHeader(200) })
	ready.Store(true)
	t.Cleanup(func() { ready.Store(false) })
	h := edgeHandler(testConfig(t, "https://console.example.com"))
	cases := []struct {
		host, target string
		want         int
	}{
		{"console.example.com", "/api/internal/tls-ask", 404},
		{"console.example.com", "/s/rtweb/api/internal/assets/x/0", 404},
		{"console.example.com", "//s/rtweb/api/internal/tls-ask", 404},
		{"console.example.com", "/s/rtweb/./api/internal/tls-ask", 404},
		{"console.example.com", "/s/rtweb/api/INTERNAL/tls-ask", 404},
		{"console.example.com", "/s/rtweb%2Fapi%2Finternal%2Ftls-ask", 404},
		{"apps.example.com", "/s/rtweb", 404},
		{"apps.example.com:8443", "/s/rtweb/api/me", 404},
		{"APPS.example.com", "/s/RTWEB/", 404},
		{"apps.example.com", "//s/rtweb/", 404},
		{"apps.example.com", "/s/hello/", 404},
		{"apps.example.com", "/", 404},
		{"hello.apps.example.com", "/", 200},
		{"hello.apps.example.com", "/api/x", 200},
		{"hello.apps.example.com", "/s/other/", 404},
		{"nosuch.apps.example.com", "//s/rtweb/", 404},
		{"rtweb.apps.example.com", "/", 404},
		{"RTWEB.apps.example.com:443", "/", 404},
		{"custom.example.org", "/s/x/", 200},
		{"console.example.com", "/", 200},
		{"custom.example.org", "/", 200},
	}
	for _, c := range cases {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("GET", "http://"+c.host+c.target, nil)
		h.ServeHTTP(w, r)
		if w.Code != c.want {
			t.Errorf("%s%s: got %d, want %d", c.host, c.target, w.Code, c.want)
		}
	}
	// The Host header reaches rt unchanged (it routes mapped hosts by it).
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://console.example.com/x", nil))
	if got.Host != "console.example.com" {
		t.Errorf("host %q", got.Host)
	}
	if w.Header().Get("Strict-Transport-Security") == "" {
		t.Error("HSTS missing on the https console host")
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://a.apps.example.com/", nil))
	if w.Header().Get("Strict-Transport-Security") != "" {
		t.Error("HSTS must not be set on App hosts")
	}
}

func TestEdgeNotReady(t *testing.T) {
	ready.Store(false)
	w := httptest.NewRecorder()
	edgeHandler(testConfig(t, "https://console.example.com")).ServeHTTP(w, httptest.NewRequest("GET", "http://console.example.com/", nil))
	if w.Code != 503 {
		t.Fatalf("got %d", w.Code)
	}
}

func TestXFFReplaced(t *testing.T) {
	var xff, xreal, fwd, proto string
	upstream(t, func(w http.ResponseWriter, r *http.Request) {
		xff, xreal, fwd, proto = r.Header.Get("X-Forwarded-For"), r.Header.Get("X-Real-IP"), r.Header.Get("Forwarded"), r.Header.Get("X-Forwarded-Proto")
	})
	ready.Store(true)
	t.Cleanup(func() { ready.Store(false) })
	h := edgeHandler(testConfig(t, "https://console.example.com"))
	send := func(peer, hdr, p string) {
		r := httptest.NewRequest("GET", "http://a.apps.example.com/", nil)
		r.RemoteAddr = net.JoinHostPort(peer, "5555")
		if hdr != "" {
			r.Header.Set("X-Forwarded-For", hdr)
		}
		if p != "" {
			r.Header.Set("X-Forwarded-Proto", p)
		}
		r.Header.Set("X-Real-IP", "6.6.6.6")
		r.Header.Set("Forwarded", "for=6.6.6.6")
		h.ServeHTTP(httptest.NewRecorder(), r)
	}
	// Untrusted peer: its header is ignored, the peer is the client.
	send("203.0.113.7", "6.6.6.6", "https")
	if xff != "203.0.113.7" || proto != "http" || xreal != "" || fwd != "" {
		t.Errorf("untrusted: xff=%q proto=%q real=%q fwd=%q", xff, proto, xreal, fwd)
	}
	// Trusted proxy chain: the rightmost untrusted hop wins; a spoofed left value is dropped.
	send("10.1.2.3", "6.6.6.6, 198.51.100.9, 10.9.9.9", "https")
	if xff != "198.51.100.9" || proto != "https" {
		t.Errorf("trusted: xff=%q proto=%q", xff, proto)
	}
	// Trusted peer with garbage: stop at the last valid hop.
	send("10.1.2.3", "nonsense", "")
	if xff != "10.1.2.3" {
		t.Errorf("garbage: xff=%q", xff)
	}
}

func TestRelayAuth(t *testing.T) {
	var auth, key, relay, tenant string
	upstream(t, func(w http.ResponseWriter, r *http.Request) {
		auth, key, relay, tenant = r.Header.Get("Authorization"), r.Header.Get("x-rtweb-key"), r.Header.Get("x-relay-auth"), r.Header.Get("x-rt-tenant")
	})
	secret := strings.Repeat("ab", 32)
	h := relayHandler(secret)
	send := func(sec, k string) int {
		r := httptest.NewRequest("GET", "http://127.0.0.1:8082/v1/services", nil)
		if sec != "" {
			r.Header.Set("x-relay-auth", sec)
		}
		if k != "" {
			r.Header.Set("x-rtweb-key", k)
		}
		r.Header.Set("x-rt-tenant", "t_other")
		r.Header.Set("Authorization", "Bearer root")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	for _, c := range []struct{ sec, key string }{{"", "rtk_a"}, {"wrong", "rtk_a"}, {secret, ""}, {secret, "Bearer x"}, {secret, "rtk_a b"}, {secret + "x", "rtk_a"}} {
		if code := send(c.sec, c.key); code != 403 {
			t.Errorf("%q/%q: got %d, want 403", c.sec, c.key, code)
		}
	}
	if code := send(secret, "rtk_abc-_9"); code != 200 {
		t.Fatalf("valid: got %d", code)
	}
	if auth != "Bearer rtk_abc-_9" || key != "" || relay != "" || tenant != "" {
		t.Errorf("upstream headers: auth=%q key=%q relay=%q tenant=%q", auth, key, relay, tenant)
	}
	// A short secret fails closed, even when the caller sends the same short value.
	if code := sendWith(relayHandler("short"), "short", "rtk_a"); code != 403 {
		t.Errorf("short secret: got %d", code)
	}
}

func sendWith(h http.Handler, sec, k string) int {
	r := httptest.NewRequest("GET", "http://127.0.0.1:8082/v1/me", nil)
	r.Header.Set("x-relay-auth", sec)
	r.Header.Set("x-rtweb-key", k)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w.Code
}

func TestConfigValidation(t *testing.T) {
	for _, c := range []struct{ console, apps string }{
		{"https://c.example.com", "https://c.example.com:8443"}, // same host, other port: cookies ignore ports
		{"https://c.example.com/path", "https://a.example.com"},
		{"ftp://c.example.com", "https://a.example.com"},
		{"", "https://a.example.com"},
	} {
		t.Setenv("RTWEB_CONSOLE_URL", c.console)
		t.Setenv("RTWEB_APPS_URL", c.apps)
		if _, err := loadConfig(); err == nil {
			t.Errorf("%q / %q: want an error", c.console, c.apps)
		}
	}
	t.Setenv("RTWEB_CONSOLE_URL", "https://c.example.com")
	t.Setenv("RTWEB_APPS_URL", "https://a.example.com")
	t.Setenv("RTWEB_TRUSTED_PROXIES", "10.0.0.0/8, 192.0.2.1")
	c, err := loadConfig()
	if err != nil || len(c.trusted) != 2 {
		t.Fatalf("valid config: %v %v", err, c)
	}
}

func TestSecretsGeneratedOnceAndFromFile(t *testing.T) {
	dir := t.TempDir()
	for _, k := range []string{"RT_ROOT_TOKEN", "RT_MASTER_KEY", "RTWEB_RELAY_SECRET", "RTWEB_SETUP_TOKEN"} {
		t.Setenv(k, "")
		t.Setenv(k+"_FILE", "")
	}
	a, err := loadSecrets(dir)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := loadSecrets(dir)
	if a.rootToken == "" || a.rootToken != b.rootToken || a.masterKey != b.masterKey || len(a.masterKey) != 64 || a.relaySecret != b.relaySecret {
		t.Fatal("secrets must be generated once and reused")
	}
	st, _ := os.Stat(filepath.Join(dir, "rtweb", "secrets", "root-token"))
	if st.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", st.Mode())
	}
	f := filepath.Join(dir, "tok")
	_ = os.WriteFile(f, []byte("from-file\n"), 0o600)
	t.Setenv("RT_ROOT_TOKEN_FILE", f)
	c, _ := loadSecrets(dir)
	if c.rootToken != "from-file" {
		t.Errorf("file secret: %q", c.rootToken)
	}
	t.Setenv("RTWEB_RELAY_SECRET", "short")
	if _, err := loadSecrets(dir); err == nil {
		t.Error("short relay secret must fail")
	}
}

func TestFilterEnv(t *testing.T) {
	out := filterEnv([]string{"RT_ROOT_TOKEN=x", "RT_MASTER_KEY_FILE=/f", "RTWEB_SETUP_TOKEN=y", "RT_LOG=info", "RT__A__B=1"})
	if strings.Join(out, " ") != "RT_LOG=info RT__A__B=1" {
		t.Errorf("got %v", out)
	}
}

func TestCollectAndNodeConfig(t *testing.T) {
	root := t.TempDir()
	_ = os.MkdirAll(filepath.Join(root, "src", "gen"), 0o755)
	for _, f := range []string{"src/main.ts", "src/gen/a.js", "src/types.d.ts", "src/readme.md"} {
		_ = os.WriteFile(filepath.Join(root, f), []byte(f), 0o644)
	}
	files, err := collect(root)
	if err != nil || len(files) != 2 || files["src/main.ts"] != "src/main.ts" || files["src/gen/a.js"] == "" {
		t.Fatalf("collect: %v %v", files, err)
	}
	share := t.TempDir()
	_ = os.WriteFile(filepath.Join(share, "rt.rtweb.toml"), []byte(`base_url = "http://127.0.0.1:8081"`+"\n"+`base_url = "http://127.0.0.1:8082"`+"\n"), 0o644)
	oldC, oldR := rtControl, relayAddr
	rtControl, relayAddr = "127.0.0.1:28081", "127.0.0.1:28082"
	t.Cleanup(func() { rtControl, relayAddr = oldC, oldR })
	c := testConfig(t, "https://console.example.com")
	c.shareDir, c.rtConfig = share, filepath.Join(t.TempDir(), "x", "rt.toml")
	if err := writeNodeConfig(c); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(c.rtConfig)
	s := string(b)
	if !strings.Contains(s, "trusted_proxies") || !strings.Contains(s, "127.0.0.1:28081") || !strings.Contains(s, "127.0.0.1:28082") || strings.Contains(s, ":8081") {
		t.Errorf("rt.toml:\n%s", s)
	}
}
