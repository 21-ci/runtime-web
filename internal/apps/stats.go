package apps

import (
	"context"
	"encoding/json"
	"io"

	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/runtime"
)

// Stats returns the runtime's request stats for the app over window (5m, 1h or 24h; "" is the
// runtime default), passed through unchanged.
func (s *Service) Stats(ctx context.Context, sub authz.Subject, orgID, slug, window string) (json.RawMessage, error) {
	app, cli, err := s.app(ctx, sub, orgID, slug, authz.AppLogsRead)
	if err != nil {
		return nil, err
	}
	out, err := cli.Stats(ctx, app.SvcID, window)
	if err != nil {
		return nil, mapErr("stats "+slug, err)
	}
	return out, nil
}

// Events returns a page of the app's runtime events (deploys, config changes) for the events panel.
func (s *Service) Events(ctx context.Context, sub authz.Subject, orgID, slug, cursor string) (runtime.Page[runtime.Event], error) {
	app, cli, err := s.app(ctx, sub, orgID, slug, authz.AppLogsRead)
	if err != nil {
		return runtime.Page[runtime.Event]{}, err
	}
	page, err := cli.Events(ctx, app.SvcID, cursor)
	if err != nil {
		return runtime.Page[runtime.Event]{}, mapErr("events "+slug, err)
	}
	if page.Items == nil {
		page.Items = []runtime.Event{}
	}
	return page, nil
}

// ExportData streams a snapshot of the app's data (app.data.export). The caller copies the body to
// the client without buffering it and closes it.
func (s *Service) ExportData(ctx context.Context, sub authz.Subject, orgID, slug string) (io.ReadCloser, error) {
	app, cli, err := s.app(ctx, sub, orgID, slug, authz.AppDataExport)
	if err != nil {
		return nil, err
	}
	body, err := cli.ExportData(ctx, app.SvcID)
	if err != nil {
		return nil, mapErr("export "+slug, err)
	}
	return body, nil
}
