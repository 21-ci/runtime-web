// Command rtrouter routes the console host and app/custom domains.
// Task 12a: plain HTTP only (ROUTER_TLS=off); TLS arrives later.
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
	if strings.ToLower(env("ROUTER_TLS", "off")) != "off" {
		return errors.New("rtrouter: TLS not implemented yet; set ROUTER_TLS=off")
	}
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

	srv := &http.Server{
		Addr:              env("ROUTER_HTTP_ADDR", ":8081"),
		Handler:           router.Handler(table, router.Upstreams{Runtime: runtime, Console: console}),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	log.Info("rtrouter listening", "addr", srv.Addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
