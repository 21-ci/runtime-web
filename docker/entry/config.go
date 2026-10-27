package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type config struct {
	dataDir       string
	rtBin         string
	rtConfig      string // generated rt.toml, rewritten on every start
	shareDir      string // bundle, SDK and node config fragment baked into the image
	extraConfig   string // optional operator TOML appended to the generated rt.toml
	consoleURL    *url.URL
	appsURL       *url.URL
	listen        string
	tlsAskListen  string
	controlListen string
	trusted       []netip.Prefix
	tenant        string
	slug          string
	plan          string
	defaultPlan   string
	version       string
	sdkVersion    string
}

type secrets struct {
	rootToken, masterKey, relaySecret, setupToken string
	// Files the root token and master key were read from ("" when they came from the variable itself). rt gets
	// RT_*_FILE for these instead of the value, so the master key never sits in rt's environment.
	rootTokenFile, masterKeyFile string
}

var slugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func parseOriginURL(name, raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.User != nil {
		return nil, fmt.Errorf("%s: must be an origin such as https://console.example.com (got %q)", name, raw)
	}
	u.Path = ""
	return u, nil
}

func loadConfig() (*config, error) {
	c := &config{
		dataDir:       env("RTWEB_DATA", "/data"),
		rtBin:         env("RTWEB_RT_BIN", "/usr/local/bin/rt"),
		shareDir:      env("RTWEB_SHARE", "/usr/local/share/rtweb"),
		extraConfig:   os.Getenv("RTWEB_RT_CONFIG_EXTRA"),
		listen:        env("RTWEB_LISTEN", ":8080"),
		tlsAskListen:  os.Getenv("RTWEB_TLS_ASK_LISTEN"),
		controlListen: env("RTWEB_CONTROL_LISTEN", rtControl),
		tenant:        env("RTWEB_TENANT", "runtime-web"),
		slug:          env("RTWEB_SLUG", "rtweb"),
		plan:          env("RTWEB_PLAN", "rtweb"),
		defaultPlan:   env("RTWEB_DEFAULT_PLAN", "unlimited"),
		version:       os.Getenv("RTWEB_VERSION"),
		sdkVersion:    env("RTCTL_SDK_VERSION", "0.1.0"),
	}
	c.rtConfig = filepath.Join(c.dataDir, "rtweb", "rt.toml")
	if !slugRe.MatchString(c.slug) {
		return nil, fmt.Errorf("RTWEB_SLUG: bad slug %q", c.slug)
	}
	var err error
	if c.consoleURL, err = parseOriginURL("RTWEB_CONSOLE_URL", os.Getenv("RTWEB_CONSOLE_URL")); err != nil {
		return nil, err
	}
	if c.appsURL, err = parseOriginURL("RTWEB_APPS_URL", os.Getenv("RTWEB_APPS_URL")); err != nil {
		return nil, err
	}
	// Apps must never share the console origin, not even the host on another port: cookies ignore ports.
	if strings.EqualFold(c.consoleURL.Hostname(), c.appsURL.Hostname()) {
		return nil, errors.New("RTWEB_APPS_URL must use a different host name than RTWEB_CONSOLE_URL")
	}
	for _, s := range strings.FieldsFunc(os.Getenv("RTWEB_TRUSTED_PROXIES"), func(r rune) bool { return r == ',' || r == ' ' }) {
		p, err := netip.ParsePrefix(s)
		if err != nil {
			a, aerr := netip.ParseAddr(s)
			if aerr != nil {
				return nil, fmt.Errorf("RTWEB_TRUSTED_PROXIES: %q is not a CIDR or address", s)
			}
			p = netip.PrefixFrom(a, a.BitLen())
		}
		c.trusted = append(c.trusted, p.Masked())
	}
	if _, _, err := net.SplitHostPort(c.listen); err != nil {
		return nil, fmt.Errorf("RTWEB_LISTEN: %w", err)
	}
	return c, nil
}

// secret resolves NAME from $NAME, then the file in $NAME_FILE, then <data>/rtweb/secrets/<file>, generating
// the last one on first boot. Nothing is baked into the image. It also returns the file the value came from
// ("" for the variable itself).
func secret(dir, name, file string, gen func() string) (string, string, error) {
	if v := os.Getenv(name); v != "" {
		return v, "", nil
	}
	if f := os.Getenv(name + "_FILE"); f != "" {
		b, err := os.ReadFile(f)
		if err != nil {
			return "", "", fmt.Errorf("%s_FILE: %w", name, err)
		}
		return strings.TrimSpace(string(b)), f, nil
	}
	p := filepath.Join(dir, file)
	if b, err := os.ReadFile(p); err == nil {
		return strings.TrimSpace(string(b)), p, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", "", err
	}
	v := gen()
	if err := os.WriteFile(p, []byte(v+"\n"), 0o600); err != nil {
		return "", "", err
	}
	log.Printf("generated %s into %s", name, p)
	return v, p, nil
}

func randHex(n int) func() string {
	return func() string { b := make([]byte, n); _, _ = rand.Read(b); return hex.EncodeToString(b) }
}

func randB64URL(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func loadSecrets(dataDir string) (*secrets, error) {
	dir := filepath.Join(dataDir, "rtweb", "secrets")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &secrets{}
	var err error
	if s.rootToken, s.rootTokenFile, err = secret(dir, "RT_ROOT_TOKEN", "root-token", randHex(32)); err != nil {
		return nil, err
	}
	if s.masterKey, s.masterKeyFile, err = secret(dir, "RT_MASTER_KEY", "master-key", randHex(32)); err != nil {
		return nil, err
	}
	if s.relaySecret, _, err = secret(dir, "RTWEB_RELAY_SECRET", "relay-secret", randHex(32)); err != nil {
		return nil, err
	}
	if len(s.relaySecret) < 32 {
		return nil, errors.New("RTWEB_RELAY_SECRET: must be at least 32 characters")
	}
	// Optional: a preset first-run setup token. Without one, bootstrap generates it.
	if v := os.Getenv("RTWEB_SETUP_TOKEN"); v != "" {
		s.setupToken = v
	} else if f := os.Getenv("RTWEB_SETUP_TOKEN_FILE"); f != "" {
		b, err := os.ReadFile(f)
		if err != nil {
			return nil, fmt.Errorf("RTWEB_SETUP_TOKEN_FILE: %w", err)
		}
		s.setupToken = strings.TrimSpace(string(b))
	}
	return s, nil
}

// writeNodeConfig renders rt.toml: the rtweb plan and bindings, the edge as the one trusted proxy, plus the
// operator's optional extra TOML (which must not repeat [ingress]).
func writeNodeConfig(c *config) error {
	frag, err := os.ReadFile(filepath.Join(c.shareDir, "rt.rtweb.toml"))
	if err != nil {
		return err
	}
	var b strings.Builder
	b.WriteString("# Generated by rtweb-entry on every start; edit RTWEB_RT_CONFIG_EXTRA instead.\n\n")
	b.WriteString("[ingress]\n# The edge (rtweb-entry) is the only peer of the invoke listener and sets X-Forwarded-For.\n")
	b.WriteString("trusted_proxies = [\"127.0.0.1/32\", \"::1/128\"]\n\n")
	// Every App is served at <slug>.<apps host> (rt routing rule 2); the edge blocks rt's /s/<slug>/ fallback.
	fmt.Fprintf(&b, "[routing]\nbase_domain = %q\n\n", hostOnly(c.appsURL.Host))
	b.WriteString(strings.NewReplacer("http://127.0.0.1:8081", "http://"+rtControl, "http://127.0.0.1:8082", "http://"+relayAddr).Replace(string(frag)))
	// Org tenant plan with cron (docker/rt.apps.toml); optional so a custom share dir can leave it out.
	if apps, err := os.ReadFile(filepath.Join(c.shareDir, "rt.apps.toml")); err == nil {
		b.WriteString("\n")
		b.Write(apps)
	}
	if c.extraConfig != "" {
		x, err := os.ReadFile(c.extraConfig)
		if err != nil {
			return fmt.Errorf("RTWEB_RT_CONFIG_EXTRA: %w", err)
		}
		b.WriteString("\n# --- RTWEB_RT_CONFIG_EXTRA ---\n")
		b.Write(x)
	}
	if err := os.MkdirAll(filepath.Dir(c.rtConfig), 0o700); err != nil {
		return err
	}
	return os.WriteFile(c.rtConfig, []byte(b.String()), 0o600)
}
