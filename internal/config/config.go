// Package config loads the rtweb settings from environment variables.
package config

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"golang.org/x/net/publicsuffix"
)

const devSecretPrefix = "dev-insecure-"

// Config is the validated process configuration.
type Config struct {
	RuntimeURL         string
	RuntimePublicURL   string
	RuntimeRootToken   string
	RuntimeDefaultPlan string
	SecretKey          [32]byte
	PublicURL          string
	DBPath             string
	Listen             string
	RouterSharedSecret string
	BaseDomain         string
	ACMEEmail          string
	SetupToken         string
	LogLevel           string
	Dev                bool
}

// Load reads and validates the configuration using getenv.
func Load(getenv func(string) string) (Config, error) {
	c := Config{
		RuntimeURL:         getenv("RUNTIME_URL"),
		RuntimePublicURL:   getenv("RUNTIME_PUBLIC_URL"),
		RuntimeRootToken:   getenv("RUNTIME_ROOT_TOKEN"),
		RuntimeDefaultPlan: getenv("RUNTIME_DEFAULT_PLAN"),
		PublicURL:          getenv("RTWEB_PUBLIC_URL"),
		DBPath:             getenv("RTWEB_DB"),
		Listen:             getenv("RTWEB_LISTEN"),
		RouterSharedSecret: getenv("ROUTER_SHARED_SECRET"),
		BaseDomain:         getenv("BASE_DOMAIN"),
		ACMEEmail:          getenv("ACME_EMAIL"),
		SetupToken:         getenv("RTWEB_SETUP_TOKEN"),
		LogLevel:           getenv("LOG_LEVEL"),
		Dev:                getenv("RTWEB_DEV") == "1",
	}
	if c.RuntimeDefaultPlan == "" {
		c.RuntimeDefaultPlan = "standard"
	}
	if c.DBPath == "" {
		c.DBPath = "./data/rtweb.db"
	}
	if c.Listen == "" {
		c.Listen = ":8090"
	}
	if c.LogLevel == "" {
		c.LogLevel = "info"
	}

	for _, req := range []struct{ name, value string }{
		{"RUNTIME_URL", c.RuntimeURL},
		{"RUNTIME_ROOT_TOKEN", c.RuntimeRootToken},
		{"ROUTER_SHARED_SECRET", c.RouterSharedSecret},
		{"RTWEB_PUBLIC_URL", c.PublicURL},
	} {
		if req.value == "" {
			return Config{}, fmt.Errorf("config: %s: required", req.name)
		}
	}

	key, err := parseSecretKey(getenv("RTWEB_SECRET_KEY"), c.Dev)
	if err != nil {
		return Config{}, err
	}
	c.SecretKey = key

	if err := checkSameSite(c); err != nil {
		return Config{}, err
	}
	return c, nil
}

// parseSecretKey turns RTWEB_SECRET_KEY into a 32-byte key. A dev-insecure
// value is accepted only in dev mode and is hashed to 32 bytes.
func parseSecretKey(raw string, dev bool) ([32]byte, error) {
	var key [32]byte
	if raw == "" {
		return key, errors.New("config: RTWEB_SECRET_KEY: required (64 hex chars)")
	}
	if strings.HasPrefix(raw, devSecretPrefix) {
		if !dev {
			return key, errors.New("config: RTWEB_SECRET_KEY: dev-insecure value requires RTWEB_DEV=1")
		}
		return sha256.Sum256([]byte(raw)), nil
	}
	b, err := hex.DecodeString(raw)
	if err != nil || len(b) != 32 {
		return key, errors.New("config: RTWEB_SECRET_KEY: must be 64 hex chars")
	}
	copy(key[:], b)
	return key, nil
}

// checkSameSite ensures the console is a different site from the runtime
// public URL and the base domain, so guest apps cannot touch console cookies.
// In dev mode a local console host (localhost, 127.0.0.1, ::1, *.localhost)
// skips the check.
func checkSameSite(c Config) error {
	consoleHost, err := hostOf("RTWEB_PUBLIC_URL", c.PublicURL)
	if err != nil {
		return err
	}
	if c.Dev && isLocal(consoleHost) {
		return nil
	}
	consoleSite, err := site(consoleHost)
	if err != nil {
		return fmt.Errorf("config: RTWEB_PUBLIC_URL: %w", err)
	}

	others := []namedHost{}
	if c.RuntimePublicURL != "" {
		h, err := hostOf("RUNTIME_PUBLIC_URL", c.RuntimePublicURL)
		if err != nil {
			return err
		}
		others = append(others, namedHost{"RUNTIME_PUBLIC_URL", h})
	}
	if c.BaseDomain != "" {
		d, err := baseDomain(c.BaseDomain)
		if err != nil {
			return err
		}
		others = append(others, namedHost{"BASE_DOMAIN", d})
	}
	for _, o := range others {
		s, err := site(o.host)
		if err != nil {
			return fmt.Errorf("config: %s: %w", o.name, err)
		}
		if s == consoleSite {
			return fmt.Errorf("config: RTWEB_PUBLIC_URL (%s) and %s (%s) share registrable domain %q; they must be different sites",
				consoleHost, o.name, o.host, s)
		}
	}
	return nil
}

type namedHost struct{ name, host string }

// hostOf returns the normalized hostname of an absolute URL.
func hostOf(name, raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" {
		return "", fmt.Errorf("config: %s: must be an absolute URL", name)
	}
	return normalizeHost(u.Hostname()), nil
}

// baseDomain validates BASE_DOMAIN as a bare domain: no scheme, wildcard, port or path.
func baseDomain(raw string) (string, error) {
	if strings.Contains(raw, "://") || strings.ContainsAny(raw, "*:/") {
		return "", fmt.Errorf("config: BASE_DOMAIN: must be a bare domain like example.com, got %q", raw)
	}
	return normalizeHost(raw), nil
}

func normalizeHost(h string) string {
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(h)), ".")
}

func site(host string) (string, error) {
	return publicsuffix.EffectiveTLDPlusOne(host)
}

func isLocal(host string) bool {
	return host == "localhost" || strings.HasSuffix(host, ".localhost") || host == "127.0.0.1" || host == "::1"
}
