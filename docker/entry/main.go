// rtweb-entry: PID 1 of the Runtime Web container image (docs/getting-started/docker.md).
//
//	rtweb-entry            supervise rt, bootstrap the console service, serve the edge and the relay
//	rtweb-entry healthcheck  exit 0 when rt is healthy and the console is installed (Docker HEALTHCHECK)
//
// It replaces, inside the container, what install.sh sets up on a host: the node config (deploy/rt.rtweb.toml
// plus the loopback trusted proxy), the secrets, install.mjs (bootstrap.go) and the Caddy edge and relay
// (edge.go). TLS stays outside: the platform or a reverse proxy in front terminates it.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

// Loopback ports inside the container. The bindings in deploy/rt.rtweb.toml name 8081 and 8082; writeNodeConfig
// rewrites them when RTWEB_INTERNAL_PORTS moves them (only needed with host networking next to another node).
var (
	rtInvoke  = "127.0.0.1:8090" // rt public listener, reached only through the edge
	rtControl = "127.0.0.1:8081"
	rtMetrics = "127.0.0.1:9090"
	relayAddr = "127.0.0.1:8082"
	statusAdr = "127.0.0.1:8099" // /healthz for the healthcheck subcommand
)

// internalPorts applies RTWEB_INTERNAL_PORTS=invoke:control:metrics:relay:status.
func internalPorts() error {
	v := os.Getenv("RTWEB_INTERNAL_PORTS")
	if v == "" {
		return nil
	}
	ps := strings.Split(v, ":")
	if len(ps) != 5 {
		return errors.New("RTWEB_INTERNAL_PORTS: want invoke:control:metrics:relay:status")
	}
	for _, p := range ps {
		if n, err := strconv.Atoi(p); err != nil || n < 1 || n > 65535 {
			return fmt.Errorf("RTWEB_INTERNAL_PORTS: bad port %q", p)
		}
	}
	rtInvoke, rtControl, rtMetrics, relayAddr, statusAdr = "127.0.0.1:"+ps[0], "127.0.0.1:"+ps[1], "127.0.0.1:"+ps[2], "127.0.0.1:"+ps[3], "127.0.0.1:"+ps[4]
	return nil
}

var ready atomic.Bool

func main() {
	log.SetFlags(0)
	log.SetPrefix("rtweb-entry: ")
	if err := internalPorts(); err != nil {
		log.Fatal(err)
	}
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

func healthcheck() int {
	c := http.Client{Timeout: 2 * time.Second}
	res, err := c.Get("http://" + statusAdr + "/healthz")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, "status", res.StatusCode)
		return 1
	}
	return 0
}

func run() error {
	// Everything rtweb-entry and rt create (secrets, rt.toml, databases, temp files) is private to uid 10001.
	syscall.Umask(0o077)
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	sec, err := loadSecrets(cfg.dataDir)
	if err != nil {
		return err
	}
	if err := writeNodeConfig(cfg); err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	tmpDir, err := ensureTmpDir(cfg.dataDir)
	if err != nil {
		return err
	}

	rt := exec.Command(cfg.rtBin, "serve")
	rt.Stdout, rt.Stderr = os.Stdout, os.Stderr
	rt.Dir = cfg.dataDir
	rt.Env = append(rtEnv(filterEnv(os.Environ()), sec, tmpDir),
		"RT_CONFIG="+cfg.rtConfig,
		"RT__NODE__DATA_DIR="+cfg.dataDir,
		"RT__LISTENERS__PUBLIC="+rtInvoke,
		"RT__LISTENERS__CONTROL="+cfg.controlListen,
		"RT__LISTENERS__METRICS="+rtMetrics,
		"RT__LISTENERS__INTERNAL=unix:"+env("RTWEB_RT_SOCKET", cfg.dataDir+"/rt.sock"),
		// The bindings read these two from rt's environment (inject_headers = "env:..."): no file form exists.
		"RTWEB_OP_TOKEN=Bearer "+sec.rootToken,
		"RTWEB_RELAY_SECRET="+sec.relaySecret,
	)
	if err := rt.Start(); err != nil {
		return fmt.Errorf("start rt: %w", err)
	}
	exited := make(chan error, 1)
	go func() { exited <- rt.Wait() }()

	go serveStatus()
	go func() { log.Fatal(serveRelay(sec.relaySecret)) }()

	bootErr := make(chan error, 1)
	go func() {
		if err := waitHealthy(ctx, 90*time.Second); err != nil {
			bootErr <- err
			return
		}
		if err := bootstrap(ctx, cfg, sec); err != nil {
			bootErr <- fmt.Errorf("bootstrap: %w", err)
			return
		}
		ready.Store(true)
		log.Printf("ready: console %s, apps %s", cfg.consoleURL, cfg.appsURL)
	}()
	go func() { log.Fatal(serveEdge(cfg)) }()
	if cfg.tlsAskListen != "" {
		go func() { log.Fatal(serveTLSAsk(cfg)) }()
	}

	select {
	case err := <-exited:
		return fmt.Errorf("rt exited: %v", err)
	case err := <-bootErr:
		_ = rt.Process.Signal(syscall.SIGTERM)
		<-exited
		return err
	case <-ctx.Done():
		log.Print("stopping rt")
		_ = rt.Process.Signal(syscall.SIGTERM)
		select {
		case <-exited:
		case <-time.After(25 * time.Second):
			_ = rt.Process.Kill()
			<-exited
		}
		return nil
	}
}

// rtEnv adds the node secrets as RT_*_FILE when they came from a file (Docker secrets, or the generated files in
// /data/rtweb/secrets), so the master key is not in rt's environment (/proc/<pid>/environ), and points TMPDIR and
// SQLITE_TMPDIR at tmpDir unless the operator set them: SQLite spills sorts of guest data.db files (temp_store=FILE)
// there, onto the data volume instead of /tmp.
func rtEnv(base []string, sec *secrets, tmpDir string) []string {
	out := base
	if sec.rootTokenFile != "" {
		out = append(out, "RT_ROOT_TOKEN_FILE="+sec.rootTokenFile)
	} else {
		out = append(out, "RT_ROOT_TOKEN="+sec.rootToken)
	}
	if sec.masterKeyFile != "" {
		out = append(out, "RT_MASTER_KEY_FILE="+sec.masterKeyFile)
	} else {
		out = append(out, "RT_MASTER_KEY="+sec.masterKey)
	}
	for _, k := range []string{"TMPDIR", "SQLITE_TMPDIR"} {
		if os.Getenv(k) == "" {
			out = append(out, k+"="+tmpDir)
		}
	}
	return out
}

// ensureTmpDir creates <data>/tmp (0700) and empties it: SQLite unlinks its temp files on open, so anything left
// is from a crash.
func ensureTmpDir(dataDir string) (string, error) {
	d := filepath.Join(dataDir, "tmp")
	if err := os.MkdirAll(d, 0o700); err != nil {
		return "", err
	}
	ents, err := os.ReadDir(d)
	if err != nil {
		return "", err
	}
	for _, e := range ents {
		_ = os.RemoveAll(filepath.Join(d, e.Name()))
	}
	return d, nil
}

// filterEnv keeps the secret inputs (and their _FILE forms) out of rt's environment: rt gets the resolved values.
func filterEnv(env []string) []string {
	out := env[:0:0]
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		switch strings.TrimSuffix(k, "_FILE") {
		case "RT_ROOT_TOKEN", "RT_MASTER_KEY", "RTWEB_RELAY_SECRET", "RTWEB_SETUP_TOKEN", "RTWEB_OP_TOKEN", "RT_CONFIG":
			continue
		}
		out = append(out, kv)
	}
	return out
}

func waitHealthy(ctx context.Context, max time.Duration) error {
	c := http.Client{Timeout: 2 * time.Second}
	deadline := time.Now().Add(max)
	for {
		res, err := c.Get("http://" + rtMetrics + "/readyz")
		if err == nil {
			res.Body.Close()
			if res.StatusCode == http.StatusOK {
				return nil
			}
		}
		if time.Now().After(deadline) {
			return errors.New("rt did not become ready in time")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func serveStatus() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		c := http.Client{Timeout: 2 * time.Second}
		res, err := c.Get("http://" + rtMetrics + "/healthz")
		if err == nil {
			res.Body.Close()
		}
		if !ready.Load() || err != nil || res.StatusCode != http.StatusOK {
			http.Error(w, "starting", http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte("ok\n"))
	})
	srv := &http.Server{Addr: statusAdr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	log.Fatal(srv.ListenAndServe())
}
