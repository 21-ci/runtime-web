package router

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/caddyserver/certmagic"
	"github.com/libdns/cloudflare"
	"github.com/mholt/acmez/v3"
)

// TLSOptions configures rtrouter TLS. Zero-value fields fall back to defaults.
type TLSOptions struct {
	BaseDomain  string // BASE_DOMAIN; {app}.BASE_DOMAIN served by the wildcard cert
	ConsoleHost string // console host; managed or file cert, never on-demand

	Email        string         // ACME_EMAIL
	CA           string         // ROUTER_ACME_CA (default Let's Encrypt production)
	TrustedRoots *x509.CertPool // ACME server roots (tests: Pebble)
	StorageDir   string         // certmagic file storage

	WildcardCert, WildcardKey string // ROUTER_WILDCARD_CERT/KEY
	DNSProvider               string // ROUTER_DNS_PROVIDER ("cloudflare" only)
	CloudflareToken           string // CLOUDFLARE_API_TOKEN
	ConsoleCert, ConsoleKey   string // ROUTER_CONSOLE_CERT/KEY

	AltHTTPPort, AltTLSALPNPort int // challenge ports for tests

	Table    *Table
	Reporter *CertReporter // optional; receives certmagic events
}

// Validate checks option combinations without touching the network.
func (o *TLSOptions) Validate() error {
	if o.BaseDomain == "" {
		return errors.New("router: BASE_DOMAIN is required when TLS is on")
	}
	if (o.WildcardCert == "") != (o.WildcardKey == "") {
		return errors.New("router: ROUTER_WILDCARD_CERT and ROUTER_WILDCARD_KEY must be set together")
	}
	if (o.ConsoleCert == "") != (o.ConsoleKey == "") {
		return errors.New("router: ROUTER_CONSOLE_CERT and ROUTER_CONSOLE_KEY must be set together")
	}
	if o.DNSProvider != "" && o.DNSProvider != "cloudflare" {
		return fmt.Errorf("router: unsupported ROUTER_DNS_PROVIDER %q (only cloudflare)", o.DNSProvider)
	}
	if o.DNSProvider == "cloudflare" && o.CloudflareToken == "" {
		return errors.New("router: CLOUDFLARE_API_TOKEN is required for ROUTER_DNS_PROVIDER=cloudflare")
	}
	if o.WildcardCert == "" && o.DNSProvider == "" {
		return errors.New("router: wildcard cert needed: set ROUTER_WILDCARD_CERT/KEY or ROUTER_DNS_PROVIDER=cloudflare (or ROUTER_TLS=off)")
	}
	if o.Table == nil {
		return errors.New("router: TLS needs a route table")
	}
	return nil
}

// TLS is the router's certificate manager.
type TLS struct {
	opts     TLSOptions
	base     string
	console  string
	acme     *certmagic.Config     // HTTP-01/TLS-ALPN-01: console + on-demand custom
	issuer   *certmagic.ACMEIssuer // for HTTP-01 challenge handling
	dns      *certmagic.Config     // DNS-01 wildcard, nil when files are used
	wildFile *fileCert
	conFile  *fileCert
}

// NewTLS builds the manager. Call Start to pre-obtain managed names.
func NewTLS(o TLSOptions) (*TLS, error) {
	if err := o.Validate(); err != nil {
		return nil, err
	}
	t := &TLS{opts: o, base: normHost(o.BaseDomain), console: normHost(o.ConsoleHost)}
	ca := o.CA
	if ca == "" {
		ca = certmagic.LetsEncryptProductionCA
	}
	storage := &certmagic.FileStorage{Path: o.StorageDir}
	if o.StorageDir == "" {
		storage = &certmagic.FileStorage{Path: "./certmagic"}
	}
	newCfg := func(solver *certmagic.DNS01Solver, onDemand bool) (*certmagic.Config, *certmagic.ACMEIssuer) {
		var cfg *certmagic.Config
		cache := certmagic.NewCache(certmagic.CacheOptions{
			GetConfigForCert: func(certmagic.Certificate) (*certmagic.Config, error) { return cfg, nil },
		})
		cfg = certmagic.New(cache, certmagic.Config{Storage: storage})
		if o.Reporter != nil {
			cfg.OnEvent = o.Reporter.OnEvent
		}
		if onDemand {
			cfg.OnDemand = &certmagic.OnDemandConfig{DecisionFunc: t.Decide}
		}
		tpl := certmagic.ACMEIssuer{
			CA:             ca,
			TestCA:         ca,
			Email:          o.Email,
			Agreed:         true,
			TrustedRoots:   o.TrustedRoots,
			AltHTTPPort:    o.AltHTTPPort,
			AltTLSALPNPort: o.AltTLSALPNPort,
		}
		if solver != nil { // a typed-nil *DNS01Solver would be used as a solver
			tpl.DNS01Solver = solver
		}
		iss := certmagic.NewACMEIssuer(cfg, tpl)
		cfg.Issuers = []certmagic.Issuer{iss}
		return cfg, iss
	}
	t.acme, t.issuer = newCfg(nil, true)
	switch {
	case o.WildcardCert != "":
		t.wildFile = &fileCert{certPath: o.WildcardCert, keyPath: o.WildcardKey}
		if _, err := t.wildFile.get(); err != nil {
			return nil, err
		}
	default:
		t.dns, _ = newCfg(&certmagic.DNS01Solver{DNSManager: certmagic.DNSManager{
			DNSProvider: &cloudflare.Provider{APIToken: o.CloudflareToken},
		}}, false)
	}
	if o.ConsoleCert != "" {
		t.conFile = &fileCert{certPath: o.ConsoleCert, keyPath: o.ConsoleKey}
		if _, err := t.conFile.get(); err != nil {
			return nil, err
		}
	}
	return t, nil
}

// Start pre-obtains the console cert (unless file-based) and the DNS-01 wildcard.
// Certificates are obtained in the background; renewal is automatic.
func (t *TLS) Start(ctx context.Context) error {
	if t.conFile == nil && t.console != "" {
		if err := t.acme.ManageAsync(ctx, []string{t.console}); err != nil {
			return fmt.Errorf("router: manage console cert: %w", err)
		}
	}
	if t.dns != nil {
		if err := t.dns.ManageAsync(ctx, []string{t.base, "*." + t.base}); err != nil {
			return fmt.Errorf("router: manage wildcard cert: %w", err)
		}
	}
	return nil
}

// isBase reports whether h is BASE_DOMAIN or a single-label subdomain of it.
func (t *TLS) isBase(h string) bool {
	if h == t.base {
		return true
	}
	sub, ok := strings.CutSuffix(h, "."+t.base)
	return ok && sub != "" && !strings.Contains(sub, ".")
}

// Decide is the on-demand DecisionFunc: only active custom-domain hosts.
func (t *TLS) Decide(_ context.Context, name string) error {
	h := normHost(name)
	switch {
	case h == t.console:
		return errors.New("console host is not on-demand")
	case h == t.base || strings.HasSuffix(h, "."+t.base):
		return errors.New("base domain uses the wildcard cert")
	}
	r := t.opts.Table.Load()
	if r == nil {
		return errors.New("route table not loaded")
	}
	if _, ok := r.Hosts[h]; !ok {
		return fmt.Errorf("host %q is not an active custom domain", h)
	}
	return nil
}

// GetCertificate picks the cert source by SNI.
func (t *TLS) GetCertificate(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
	if slices.Contains(hello.SupportedProtos, acmez.ACMETLS1Protocol) {
		return t.acme.GetCertificate(hello)
	}
	h := normHost(hello.ServerName)
	switch {
	case h != "" && h == t.console:
		if t.conFile != nil {
			return t.conFile.get()
		}
		return t.acme.GetCertificate(hello)
	case t.isBase(h):
		if t.wildFile != nil {
			return t.wildFile.get()
		}
		return t.dns.GetCertificate(hello)
	}
	return t.acme.GetCertificate(hello)
}

// TLSConfig returns the server tls.Config (h2, http/1.1, acme-tls/1).
func (t *TLS) TLSConfig() *tls.Config {
	return &tls.Config{
		MinVersion:     tls.VersionTLS12,
		GetCertificate: t.GetCertificate,
		NextProtos:     []string{"h2", "http/1.1", acmez.ACMETLS1Protocol},
	}
}

// CertNotAfter returns the expiry of a managed cert for host from cache or storage.
func (t *TLS) CertNotAfter(ctx context.Context, host string) (time.Time, bool) {
	c, err := t.acme.CacheManagedCertificate(ctx, host)
	if err != nil || c.Leaf == nil {
		return time.Time{}, false
	}
	return c.Leaf.NotAfter, true
}

// HTTPHandler serves ACME HTTP-01 challenges on :80 and 308-redirects the rest to https.
func (t *TLS) HTTPHandler() http.Handler {
	return RedirectHandler(t.issuer, t.opts.Table)
}

// RedirectHandler answers ACME HTTP-01 challenges via iss (may be nil) and
// redirects requests for hosts known to tbl to https, keeping path and query.
// Unknown hosts get 421 so a crafted Host cannot make an open redirect.
func RedirectHandler(iss *certmagic.ACMEIssuer, tbl *Table) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/.well-known/acme-challenge/") {
			if iss != nil && iss.HandleHTTPChallenge(w, r) {
				return
			}
			http.NotFound(w, r)
			return
		}
		var routes *Routes
		if tbl != nil {
			routes = tbl.Load()
		}
		if Resolve(routes, known, r.Host) == nil {
			http.Error(w, "misdirected request", http.StatusMisdirectedRequest)
			return
		}
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
			if strings.Contains(h, ":") {
				host = "[" + h + "]"
			}
		}
		http.Redirect(w, r, "https://"+host+r.URL.RequestURI(), http.StatusPermanentRedirect)
	})
}

// known is a non-nil upstream set used only to ask Resolve whether a host is served.
var known = Upstreams{Runtime: &url.URL{}, Console: &url.URL{}}

// fileCert is a PEM cert/key pair reloaded when either file's mtime changes.
type fileCert struct {
	certPath, keyPath string

	mu      sync.Mutex
	cert    *tls.Certificate
	mtimes  [2]time.Time
	checked time.Time
}

const fileCheckEvery = 2 * time.Second

func (f *fileCert) get() (*tls.Certificate, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	now := time.Now()
	if f.cert != nil && now.Sub(f.checked) < fileCheckEvery {
		return f.cert, nil
	}
	f.checked = now
	var mt [2]time.Time
	for i, p := range []string{f.certPath, f.keyPath} {
		st, err := os.Stat(p)
		if err != nil {
			if f.cert != nil {
				return f.cert, nil
			}
			return nil, fmt.Errorf("router: stat cert file: %w", err)
		}
		mt[i] = st.ModTime()
	}
	if f.cert != nil && mt == f.mtimes {
		return f.cert, nil
	}
	c, err := tls.LoadX509KeyPair(f.certPath, f.keyPath)
	if err != nil {
		if f.cert != nil {
			return f.cert, nil // keep serving the last good pair
		}
		return nil, fmt.Errorf("router: load cert files: %w", err)
	}
	f.cert, f.mtimes = &c, mt
	return f.cert, nil
}
