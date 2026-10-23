// Command rtrouter routes the console host and app/custom domains.
// ROUTER_TLS=off serves plain HTTP (dev); otherwise :443 TLS + :80 redirect/ACME.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/21cloud/runtime-web/internal/router"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if err := run(log); err != nil {
		log.Error("rtrouter exited", "err", err)
		os.Exit(1)
	}
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func mustURL(k string) (*url.URL, error) {
	v := os.Getenv(k)
	if v == "" {
		return nil, errors.New("rtrouter: " + k + " is required")
	}
	u, err := url.Parse(v)
	if err != nil || u.Host == "" {
		return nil, errors.New("rtrouter: " + k + " is not a valid URL")
	}
	return u, nil
}

func run(log *slog.Logger) error {
	tlsOn := strings.ToLower(env("ROUTER_TLS", "on")) != "off"
	console, err := mustURL("ROUTER_RTWEB_URL")
	if err != nil {
		return err
	}
	runtime, err := mustURL("RUNTIME_PUBLIC_URL")
	if err != nil {
		return err
	}
	secret := os.Getenv("ROUTER_SHARED_SECRET")
	if secret == "" {
		return errors.New("rtrouter: ROUTER_SHARED_SECRET is required")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	table := &router.Table{}
	p := &router.Poller{
		URL:      console.JoinPath("/api/internal/router/routes").String(),
		Secret:   secret,
		Interval: 5 * time.Second,
		Table:    table,
		Logger:   log,
	}
	go p.Run(ctx)

	handler := router.Handler(table, router.Upstreams{Runtime: runtime, Console: console})
	if !tlsOn {
		return serve(ctx, log, newServer(env("ROUTER_HTTP_ADDR", ":8081"), handler), false)
	}

	consoleHost := os.Getenv("ROUTER_CONSOLE_HOST")
	if consoleHost == "" {
		if u, err := url.Parse(os.Getenv("RTWEB_PUBLIC_URL")); err == nil {
			consoleHost = u.Hostname()
		}
	}
	rep := &router.CertReporter{
		URL:    console.JoinPath("/api/internal/router/cert-status").String(),
		Secret: secret,
		Table:  table,
		Logger: log,
	}
	m, err := router.NewTLS(router.TLSOptions{
		BaseDomain:      os.Getenv("BASE_DOMAIN"),
		ConsoleHost:     consoleHost,
		Email:           os.Getenv("ACME_EMAIL"),
		CA:              os.Getenv("ROUTER_ACME_CA"),
		StorageDir:      env("ROUTER_CERT_DIR", "/data/certs"),
		WildcardCert:    os.Getenv("ROUTER_WILDCARD_CERT"),
		WildcardKey:     os.Getenv("ROUTER_WILDCARD_KEY"),
		DNSProvider:     os.Getenv("ROUTER_DNS_PROVIDER"),
		CloudflareToken: os.Getenv("CLOUDFLARE_API_TOKEN"),
		ConsoleCert:     os.Getenv("ROUTER_CONSOLE_CERT"),
		ConsoleKey:      os.Getenv("ROUTER_CONSOLE_KEY"),
		Table:           table,
		Reporter:        rep,
	})
	if err != nil {
		return err
	}
	rep.Lookup = m.CertNotAfter
	if err := m.Start(ctx); err != nil {
		return err
	}
	go rep.Run(ctx)

	httpSrv := newServer(env("ROUTER_HTTP_ADDR", ":80"), m.HTTPHandler())
	go func() {
		if err := serve(ctx, log, httpSrv, false); err != nil {
			log.Error("http listener failed", "err", err)
			stop()
		}
	}()
	httpsSrv := newServer(env("ROUTER_HTTPS_ADDR", ":443"), handler)
	httpsSrv.TLSConfig = m.TLSConfig()
	return serve(ctx, log, httpsSrv, true)
}

func newServer(addr string, h http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    64 << 10,
	}
}

func serve(ctx context.Context, log *slog.Logger, srv *http.Server, useTLS bool) error {
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	log.Info("rtrouter listening", "addr", srv.Addr, "tls", useTLS)
	var err error
	if useTLS {
		err = srv.ListenAndServeTLS("", "")
	} else {
		err = srv.ListenAndServe()
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
