package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/21cloud/runtime-web/internal/api"
	"github.com/21cloud/runtime-web/internal/apps"
	"github.com/21cloud/runtime-web/internal/auth"
	"github.com/21cloud/runtime-web/internal/config"
	"github.com/21cloud/runtime-web/internal/keys"
	"github.com/21cloud/runtime-web/internal/orgs"
	"github.com/21cloud/runtime-web/internal/runtime"
	"github.com/21cloud/runtime-web/internal/seal"
	"github.com/21cloud/runtime-web/internal/store"
)

// serve wires the services, starts the key retrier and the HTTP server, and
// returns once ctx is done and the server has shut down.
func serve(ctx context.Context, cfg config.Config, logger *slog.Logger) error {
	st, err := store.Open(ctx, cfg.DBPath)
	if err != nil {
		return fmt.Errorf("rtweb: open store: %w", err)
	}
	defer func() { _ = st.Close() }()

	sealer := seal.New(cfg.SecretKey)
	authSvc := auth.NewService(st, auth.Argon2{}, sealer, auth.NewSetupToken(cfg), cfg.Dev)
	rt := runtime.New(cfg.RuntimeURL, &http.Client{})
	root := runtime.RootCred{Token: cfg.RuntimeRootToken}
	orgSvc := orgs.New(st, rt, root, sealer, cfg.RuntimeDefaultPlan)
	appSvc := apps.New(rt, orgSvc, st)
	keySvc := keys.New(st, rt, root, sealer, orgSvc, appSvc)
	go keySvc.RunRetrier(ctx)

	srv := &http.Server{
		Addr: cfg.Listen,
		Handler: api.New(api.Deps{
			Auth:             authSvc,
			Orgs:             orgSvc,
			Logger:           logger,
			PublicURL:        cfg.PublicURL,
			RuntimePublicURL: cfg.RuntimePublicURL,
		}),
		ReadHeaderTimeout: 10 * time.Second,
	}
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	logger.Info("rtweb listening", "listen", cfg.Listen)

	select {
	case err := <-errc:
		return fmt.Errorf("rtweb: listen: %w", err)
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("rtweb: shutdown: %w", err)
	}
	return nil
}
