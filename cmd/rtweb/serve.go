package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/21cloud/runtime-web/internal/admin"
	"github.com/21cloud/runtime-web/internal/api"
	"github.com/21cloud/runtime-web/internal/apps"
	"github.com/21cloud/runtime-web/internal/auth"
	"github.com/21cloud/runtime-web/internal/config"
	"github.com/21cloud/runtime-web/internal/domains"
	"github.com/21cloud/runtime-web/internal/invites"
	"github.com/21cloud/runtime-web/internal/keys"
	"github.com/21cloud/runtime-web/internal/orgs"
	"github.com/21cloud/runtime-web/internal/runtime"
	"github.com/21cloud/runtime-web/internal/seal"
	"github.com/21cloud/runtime-web/internal/store"
	"github.com/21cloud/runtime-web/internal/users"
)

// serve wires the services, starts the key retrier and the HTTP server, and
// returns once ctx is done and the server has shut down.
func serve(ctx context.Context, cfg config.Config, logger *slog.Logger, webVersion string) error {
	st, err := store.Open(ctx, cfg.DBPath)
	if err != nil {
		return fmt.Errorf("rtweb: open store: %w", err)
	}
	defer func() { _ = st.Close() }()

	sealer := seal.New(cfg.SecretKey)
	authSvc := auth.NewService(st, auth.Argon2{}, sealer, auth.NewSetupToken(cfg), cfg.Dev)
	// Password login may be disabled only while an enabled OAuth/OIDC provider exists (api-web.md §6).
	authSvc.SSOConfigured = func(ctx context.Context) bool {
		ps, err := auth.NewOAuth(authSvc, cfg.PublicURL).Providers(ctx)
		return err == nil && len(ps) > 0
	}
	rt := runtime.New(cfg.RuntimeURL, &http.Client{})
	root := runtime.RootCred{Token: cfg.RuntimeRootToken}
	orgSvc := orgs.New(st, rt, root, sealer, cfg.RuntimeDefaultPlan)
	appSvc := apps.New(rt, orgSvc, st)
	keySvc := keys.New(st, rt, root, sealer, orgSvc, appSvc)
	adminSvc := admin.New(st, rt, root, orgSvc)
	usersSvc := users.New(st, auth.Argon2{})
	invitesSvc := invites.New(st, auth.Argon2{}, authSvc, cfg.PublicURL)
	logHub := apps.NewLogHub(appSvc)
	domainSvc := domains.New(st, rt, root, appSvc, domains.OptionsFromConfig(cfg, os.Getenv))
	go keySvc.RunRetrier(ctx)
	go domainSvc.RunChecker(ctx)

	srv := &http.Server{
		Addr: cfg.Listen,
		Handler: api.New(api.Deps{
			Auth:             authSvc,
			Orgs:             orgSvc,
			Users:            usersSvc,
			Admin:            adminSvc,
			Keys:             keySvc,
			Invites:          invitesSvc,
			Apps:             appSvc,
			Logs:             logHub,
			Domains:          domainSvc,
			RouterSecret:     cfg.RouterSharedSecret,
			WebVersion:       webVersion,
			Logger:           logger,
			PublicURL:        cfg.PublicURL,
			RuntimePublicURL: cfg.RuntimePublicURL,
		}),
		ReadHeaderTimeout: 10 * time.Second,
		// No WriteTimeout: log streams (SSE) are long-lived.
		ReadTimeout:    60 * time.Second,
		IdleTimeout:    120 * time.Second,
		MaxHeaderBytes: 64 << 10,
	}
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	logger.Info("rtweb listening", "listen", cfg.Listen)

	select {
	case err := <-errc:
		return fmt.Errorf("rtweb: listen: %w", err)
	case <-ctx.Done():
	}
	// Closing the hub ends every SSE stream, so Shutdown does not wait on them.
	logHub.Close()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("rtweb: shutdown: %w", err)
	}
	return nil
}
