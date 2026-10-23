package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/auth"
	"github.com/21cloud/runtime-web/internal/store"
)

const adminUsage = "usage: rtweb admin reset-2fa --email <email>"

// runAdmin runs an `rtweb admin` subcommand directly against the database
// (RTWEB_DB, default ./data/rtweb.db) and returns the exit code: 0 ok,
// 1 failure, 2 bad usage.
func runAdmin(ctx context.Context, args []string, getenv func(string) string, now func() time.Time, out io.Writer) int {
	if len(args) == 0 || args[0] != "reset-2fa" {
		fmt.Fprintln(out, adminUsage)
		return 2
	}
	fs := flag.NewFlagSet("reset-2fa", flag.ContinueOnError)
	fs.SetOutput(out)
	email := fs.String("email", "", "email of the user whose 2FA is cleared")
	if err := fs.Parse(args[1:]); err != nil {
		return 2
	}
	*email = strings.ToLower(strings.TrimSpace(*email))
	if *email == "" {
		fmt.Fprintln(out, "rtweb admin reset-2fa: --email is required")
		return 2
	}
	path := getenv("RTWEB_DB")
	if path == "" {
		path = "./data/rtweb.db"
	}
	st, err := store.Open(ctx, path)
	if err != nil {
		fmt.Fprintf(out, "rtweb admin: %v\n", err)
		return 1
	}
	defer st.Close()

	userID, err := auth.Reset2FA(ctx, st, *email, "cli", now())
	if errors.Is(err, apperr.ErrNotFound) {
		fmt.Fprintf(out, "rtweb admin reset-2fa: user %s not found\n", *email)
		return 1
	}
	if err != nil {
		fmt.Fprintf(out, "rtweb admin reset-2fa: %v\n", err)
		return 1
	}
	fmt.Fprintf(out, "cleared 2FA and revoked sessions for %s (%s)\n", *email, userID)
	return 0
}
