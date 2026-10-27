package main

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestRtEnvPassesFileSecretsAsPaths(t *testing.T) {
	t.Setenv("TMPDIR", "")
	t.Setenv("SQLITE_TMPDIR", "/custom")
	sec := &secrets{rootToken: "r", masterKey: "m", rootTokenFile: "/run/secrets/rt_root_token", masterKeyFile: "/data/rtweb/secrets/master-key"}
	got := rtEnv(nil, sec, "/data/tmp")
	for _, want := range []string{"RT_ROOT_TOKEN_FILE=/run/secrets/rt_root_token", "RT_MASTER_KEY_FILE=/data/rtweb/secrets/master-key", "TMPDIR=/data/tmp"} {
		if !slices.Contains(got, want) {
			t.Errorf("missing %q in %v", want, got)
		}
	}
	for _, kv := range got {
		if kv == "RT_MASTER_KEY=m" || kv == "RT_ROOT_TOKEN=r" || kv == "SQLITE_TMPDIR=/data/tmp" {
			t.Errorf("unexpected %q", kv)
		}
	}
}

func TestRtEnvPassesVariableSecretsAsValues(t *testing.T) {
	got := rtEnv(nil, &secrets{rootToken: "r", masterKey: "m"}, "/d/tmp")
	if !slices.Contains(got, "RT_MASTER_KEY=m") || !slices.Contains(got, "RT_ROOT_TOKEN=r") {
		t.Fatalf("got %v", got)
	}
}

func TestEnsureTmpDirEmptiesLeftovers(t *testing.T) {
	data := t.TempDir()
	if err := os.MkdirAll(filepath.Join(data, "tmp", "x"), 0o700); err != nil {
		t.Fatal(err)
	}
	d, err := ensureTmpDir(data)
	if err != nil {
		t.Fatal(err)
	}
	ents, _ := os.ReadDir(d)
	if len(ents) != 0 {
		t.Fatalf("leftovers: %v", ents)
	}
	st, _ := os.Stat(d)
	if st.Mode().Perm() != 0o700 {
		t.Fatalf("mode %v", st.Mode().Perm())
	}
}

func TestNodeConfigRoutesAppSubdomains(t *testing.T) {
	c := testConfig(t, "https://console.example.com")
	share := t.TempDir()
	_ = os.WriteFile(filepath.Join(share, "rt.rtweb.toml"), []byte("# frag\n"), 0o644)
	c.shareDir, c.rtConfig = share, filepath.Join(t.TempDir(), "rt.toml")
	if err := writeNodeConfig(c); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(c.rtConfig)
	if !strings.Contains(string(b), "[routing]\nbase_domain = \"apps.example.com\"") {
		t.Errorf("rt.toml:\n%s", b)
	}
}
