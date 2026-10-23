// Command rtweb is the Runtime Web BFF and console server.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/21cloud/runtime-web/internal/config"
)

// Set at build time with -ldflags "-X main.version=… -X main.commit=… -X main.date=…".
var (
	version = "dev"
	commit  = "none"
	date    = "unknown"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "admin" {
		os.Exit(runAdmin(context.Background(), os.Args[2:], os.Getenv, time.Now, os.Stdout))
	}
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		fmt.Fprintf(os.Stderr, "rtweb: %v\n", err)
		os.Exit(1)
	}

	logger := newLogger(cfg.Dev, cfg.LogLevel)
	slog.SetDefault(logger)
	logger.Info("rtweb config loaded",
		"version", version, "commit", commit, "date", date,
		"listen", cfg.Listen, "dev", cfg.Dev)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := serve(ctx, cfg, logger, version); err != nil {
		logger.Error("rtweb: serve failed", "err", err)
		stop()
		os.Exit(1)
	}
}

// newLogger uses text output in dev and JSON otherwise, at the given LOG_LEVEL.
func newLogger(dev bool, level string) *slog.Logger {
	var lvl slog.Level
	if err := lvl.UnmarshalText([]byte(level)); err != nil {
		fmt.Fprintf(os.Stderr, "rtweb: LOG_LEVEL: %v\n", err)
		os.Exit(1)
	}
	opts := &slog.HandlerOptions{Level: lvl}
	if dev {
		return slog.New(slog.NewTextHandler(os.Stderr, opts))
	}
	return slog.New(slog.NewJSONHandler(os.Stderr, opts))
}
