// Command rtweb is the Runtime Web BFF and console server.
package main

import (
	"fmt"
	"log/slog"
	"os"

	"github.com/21cloud/runtime-web/internal/config"
)

// Set at build time with -ldflags "-X main.version=… -X main.commit=… -X main.date=…".
var (
	version = "dev"
	commit  = "none"
	date    = "unknown"
)

func main() {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		fmt.Fprintf(os.Stderr, "rtweb: %v\n", err)
		os.Exit(1)
	}

	logger := newLogger(cfg.Dev, os.Getenv("LOG_LEVEL"))
	slog.SetDefault(logger)
	logger.Info("rtweb config loaded",
		"version", version, "commit", commit, "date", date,
		"listen", cfg.Listen, "dev", cfg.Dev)
}

// newLogger uses text output in dev and JSON otherwise, at LOG_LEVEL (default info).
func newLogger(dev bool, level string) *slog.Logger {
	var lvl slog.Level
	if level != "" {
		if err := lvl.UnmarshalText([]byte(level)); err != nil {
			fmt.Fprintf(os.Stderr, "rtweb: LOG_LEVEL: %v\n", err)
			os.Exit(1)
		}
	}
	opts := &slog.HandlerOptions{Level: lvl}
	if dev {
		return slog.New(slog.NewTextHandler(os.Stderr, opts))
	}
	return slog.New(slog.NewJSONHandler(os.Stderr, opts))
}
