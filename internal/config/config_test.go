package config

import (
	"crypto/sha256"
	"strings"
	"testing"
)

const validKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func envOf(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func baseEnv() map[string]string {
	return map[string]string{
		"RUNTIME_URL":          "http://runtime.internal:8080",
		"RUNTIME_PUBLIC_URL":   "https://run.example.net",
		"RTWEB_SECRET_KEY":     validKey,
		"RTWEB_PUBLIC_URL":     "https://console.example.com",
		"RUNTIME_ROOT_TOKEN":   "root-token",
		"ROUTER_SHARED_SECRET": "router-secret",
		"RTWEB_DEV":            "",
		"BASE_DOMAIN":          "",
	}
}

func withEnv(overrides map[string]string) map[string]string {
	m := baseEnv()
	for k, v := range overrides {
		m[k] = v
	}
	return m
}

func TestLoad(t *testing.T) {
	tests := []struct {
		name    string
		env     map[string]string
		wantErr string // substring; empty means success
		check   func(t *testing.T, c Config)
	}{
		{
			name: "valid minimal env",
			env:  baseEnv(),
			check: func(t *testing.T, c Config) {
				if c.RuntimeURL != "http://runtime.internal:8080" {
					t.Errorf("RuntimeURL = %q", c.RuntimeURL)
				}
				if c.PublicURL != "https://console.example.com" {
					t.Errorf("PublicURL = %q", c.PublicURL)
				}
			},
		},
		{
			name:    "missing RUNTIME_ROOT_TOKEN names it",
			env:     withEnv(map[string]string{"RUNTIME_ROOT_TOKEN": ""}),
			wantErr: "RUNTIME_ROOT_TOKEN",
		},
		{
			name:    "missing ROUTER_SHARED_SECRET names it",
			env:     withEnv(map[string]string{"ROUTER_SHARED_SECRET": ""}),
			wantErr: "ROUTER_SHARED_SECRET",
		},
		{
			name:    "missing RUNTIME_URL names it",
			env:     withEnv(map[string]string{"RUNTIME_URL": ""}),
			wantErr: "RUNTIME_URL",
		},
		{
			name:    "secret key not 64 hex",
			env:     withEnv(map[string]string{"RTWEB_SECRET_KEY": "abc123"}),
			wantErr: "RTWEB_SECRET_KEY",
		},
		{
			name:    "secret key 64 chars but not hex",
			env:     withEnv(map[string]string{"RTWEB_SECRET_KEY": strings.Repeat("z", 64)}),
			wantErr: "RTWEB_SECRET_KEY",
		},
		{
			name:    "dev-insecure key rejected without RTWEB_DEV",
			env:     withEnv(map[string]string{"RTWEB_SECRET_KEY": "dev-insecure-x"}),
			wantErr: "RTWEB_SECRET_KEY",
		},
		{
			name: "dev-insecure key accepted with RTWEB_DEV=1 and hashed",
			env: withEnv(map[string]string{
				"RTWEB_SECRET_KEY":   "dev-insecure-x",
				"RTWEB_DEV":          "1",
				"RTWEB_PUBLIC_URL":   "http://localhost:8090",
				"RUNTIME_PUBLIC_URL": "http://localhost:8080",
			}),
			check: func(t *testing.T, c Config) {
				want := sha256.Sum256([]byte("dev-insecure-x"))
				if c.SecretKey != want {
					t.Errorf("SecretKey = %x, want sha256 of value", c.SecretKey)
				}
				if !c.Dev {
					t.Error("Dev = false, want true")
				}
			},
		},
		{
			name: "defaults applied",
			env:  baseEnv(),
			check: func(t *testing.T, c Config) {
				if c.RuntimeDefaultPlan != "standard" {
					t.Errorf("RuntimeDefaultPlan = %q", c.RuntimeDefaultPlan)
				}
				if c.DBPath != "./data/rtweb.db" {
					t.Errorf("DBPath = %q", c.DBPath)
				}
				if c.Listen != ":8090" {
					t.Errorf("Listen = %q", c.Listen)
				}
				if c.LogLevel != "info" {
					t.Errorf("LogLevel = %q", c.LogLevel)
				}
			},
		},
		{
			name: "explicit values override defaults",
			env: withEnv(map[string]string{
				"RUNTIME_DEFAULT_PLAN": "small",
				"RTWEB_DB":             "/var/lib/rtweb.db",
				"RTWEB_LISTEN":         ":9000",
			}),
			check: func(t *testing.T, c Config) {
				if c.RuntimeDefaultPlan != "small" || c.DBPath != "/var/lib/rtweb.db" || c.Listen != ":9000" {
					t.Errorf("got plan=%q db=%q listen=%q", c.RuntimeDefaultPlan, c.DBPath, c.Listen)
				}
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, err := Load(envOf(tt.env))
			if tt.wantErr != "" {
				if err == nil {
					t.Fatalf("Load() error = nil, want error containing %q", tt.wantErr)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("Load() error = %v, want it to contain %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("Load() error = %v", err)
			}
			if tt.check != nil {
				tt.check(t, c)
			}
		})
	}
}

// envExample mirrors the values shipped in .env.example.
func envExample() map[string]string {
	return map[string]string{
		"RUNTIME_URL":          "http://runtime:8080",
		"RUNTIME_PUBLIC_URL":   "https://run.example.net",
		"RUNTIME_ROOT_TOKEN":   "dev-insecure-runtime-root",
		"RUNTIME_DEFAULT_PLAN": "standard",
		"RTWEB_PUBLIC_URL":     "http://localhost:8090",
		"RTWEB_LISTEN":         ":8090",
		"RTWEB_DB":             "./data/rtweb.db",
		"RTWEB_DEV":            "1",
		"RTWEB_SETUP_TOKEN":    "dev-insecure-setup",
		"RTWEB_SECRET_KEY":     "dev-insecure-secret-key",
		"ROUTER_SHARED_SECRET": "dev-insecure-router",
		"BASE_DOMAIN":          "apps.example.net",
		"ACME_EMAIL":           "ops@example.net",
	}
}

func TestLoadEnvExampleAndDevLocal(t *testing.T) {
	tests := []struct {
		name    string
		env     map[string]string
		wantErr string
	}{
		{name: "shipped .env.example values with RTWEB_DEV=1", env: envExample()},
		{
			name: "dev local console 127.0.0.1 skips same-site check",
			env: withEnv(map[string]string{
				"RTWEB_DEV":          "1",
				"RTWEB_PUBLIC_URL":   "http://127.0.0.1:8090",
				"RUNTIME_PUBLIC_URL": "https://run.example.com",
				"BASE_DOMAIN":        "example.com",
			}),
		},
		{
			name: "dev *.localhost console skips same-site check",
			env: withEnv(map[string]string{
				"RTWEB_DEV":        "1",
				"RTWEB_PUBLIC_URL": "http://console.localhost:8090",
				"BASE_DOMAIN":      "example.com",
			}),
		},
		{
			name: "non-dev localhost console is not skipped",
			env: withEnv(map[string]string{
				"RTWEB_PUBLIC_URL": "http://localhost:8090",
			}),
			wantErr: "RTWEB_PUBLIC_URL",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Load(envOf(tt.env))
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("Load() error = %v, want nil", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("Load() error = %v, want containing %q", err, tt.wantErr)
			}
		})
	}
}

func TestLoadRejectsSameSite(t *testing.T) {
	tests := []struct {
		name    string
		env     map[string]string
		wantErr string // substring; empty means accepted
	}{
		{
			name: "same registrable domain as RUNTIME_PUBLIC_URL rejected",
			env: withEnv(map[string]string{
				"RTWEB_PUBLIC_URL":   "https://console.example.com",
				"RUNTIME_PUBLIC_URL": "https://run.example.com",
			}),
			wantErr: "RUNTIME_PUBLIC_URL",
		},
		{
			name: "different registrable domain from RUNTIME_PUBLIC_URL accepted",
			env: withEnv(map[string]string{
				"RTWEB_PUBLIC_URL":   "https://console.example.com",
				"RUNTIME_PUBLIC_URL": "https://apps.example.net",
			}),
		},
		{
			name: "uppercase and trailing dot normalized: Example.COM. rejected",
			env: withEnv(map[string]string{
				"RTWEB_PUBLIC_URL":   "https://console.example.com",
				"RUNTIME_PUBLIC_URL": "https://RUN.Example.COM.",
			}),
			wantErr: "RUNTIME_PUBLIC_URL",
		},
		{
			name: "BASE_DOMAIN with wildcard rejected",
			env: withEnv(map[string]string{
				"RTWEB_PUBLIC_URL": "https://console.x.com",
				"BASE_DOMAIN":      "*.x.com",
			}),
			wantErr: "BASE_DOMAIN",
		},
		{
			name: "BASE_DOMAIN with scheme rejected",
			env: withEnv(map[string]string{
				"RTWEB_PUBLIC_URL": "https://console.x.com",
				"BASE_DOMAIN":      "https://x.com",
			}),
			wantErr: "BASE_DOMAIN",
		},
		{
			name: "BASE_DOMAIN uppercase with trailing dot normalized to same site",
			env: withEnv(map[string]string{
				"RTWEB_PUBLIC_URL": "https://console.example.com",
				"BASE_DOMAIN":      "Example.COM.",
			}),
			wantErr: "BASE_DOMAIN",
		},
		{
			name: "same registrable domain as BASE_DOMAIN rejected",
			env: withEnv(map[string]string{
				"RTWEB_PUBLIC_URL": "https://console.example.com",
				"BASE_DOMAIN":      "example.com",
			}),
			wantErr: "BASE_DOMAIN",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Load(envOf(tt.env))
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("Load() error = %v, want nil", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("Load() error = nil, want error containing %q", tt.wantErr)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("Load() error = %v, want it to contain %q", err, tt.wantErr)
			}
		})
	}
}
