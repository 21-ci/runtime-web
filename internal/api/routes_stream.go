package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/21cloud/runtime-web/internal/apps"
	"github.com/21cloud/runtime-web/internal/authz"
)

// logRank orders the log levels for the ?level filter (reference/api.md §8.6).
var logRank = map[string]int{"debug": 0, "info": 1, "warn": 2, "error": 3}

// registerStreamRoutes registers the app log stream and the data export (reference/api.md §8.4, §8.6).
func (s *Server) registerStreamRoutes() {
	s.appRoute(http.MethodGet, "/api/orgs/{org}/apps/{app}/logs", authz.AppLogsRead, s.streamLogs)
	s.appRoute(http.MethodGet, "/api/orgs/{org}/apps/{app}/export", authz.AppDataExport, s.exportApp)
}

// streamLogs serves the app's logs as server-sent events. Errors before the stream starts use the
// JSON envelope; once it starts the handler ends only when the client leaves, the hub closes the
// subscription or a write fails.
func (s *Server) streamLogs(w http.ResponseWriter, r *http.Request, c orgCall) error {
	level := r.URL.Query().Get("level")
	if _, ok := logRank[level]; level != "" && !ok {
		return &validationError{message: "level must be debug, info, warn or error"}
	}
	last := r.Header.Get("Last-Event-ID")
	if last == "" {
		last = r.URL.Query().Get("last_event_id")
	}
	ch, cancel, err := s.deps.Logs.Subscribe(r.Context(), c.sub, c.org.ID, r.PathValue("app"), last)
	if errors.Is(err, apps.ErrLogHubClosed) {
		writeAPIError(w, apiError{status: http.StatusServiceUnavailable, code: "unavailable", message: "log streaming is shutting down"})
		return nil
	}
	if err != nil {
		return err
	}
	defer cancel()

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no")
	rc := http.NewResponseController(w)
	// Only SSE routes drop the server write deadline; the stream is bounded by the request context.
	_ = rc.SetWriteDeadline(time.Time{})
	w.WriteHeader(http.StatusOK)
	_ = rc.Flush()

	tick := time.NewTicker(s.sseHeartbeat)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return nil
		case <-tick.C:
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return nil
			}
			_ = rc.Flush()
		case ev, ok := <-ch:
			if !ok {
				return nil
			}
			if !keepLevel(ev, level) {
				continue
			}
			if err := writeSSE(w, ev); err != nil {
				return nil
			}
			_ = rc.Flush()
		}
	}
}

// keepLevel reports whether ev passes the ?level filter, a minimum severity. Only "log" events are
// filtered; gap and error events always pass. An empty min passes everything.
func keepLevel(ev apps.LogEvent, minLevel string) bool {
	if minLevel == "" || ev.Event != "log" {
		return true
	}
	var line struct {
		Level string `json:"level"`
	}
	if err := json.Unmarshal(ev.Data, &line); err != nil {
		return true
	}
	return logRank[line.Level] >= logRank[minLevel]
}

// writeSSE writes one event. Data is compacted so that it stays on one line.
func writeSSE(w io.Writer, ev apps.LogEvent) error {
	var compact bytes.Buffer
	if err := json.Compact(&compact, ev.Data); err != nil {
		return fmt.Errorf("api: sse data: %w", err)
	}
	var b bytes.Buffer
	if ev.ID != "" {
		fmt.Fprintf(&b, "id: %s\n", ev.ID)
	}
	fmt.Fprintf(&b, "event: %s\ndata: %s\n\n", ev.Event, compact.Bytes())
	_, err := w.Write(b.Bytes())
	return err
}

// exportFilename returns "<app>.sqlite" with only [a-z0-9-] kept from app, so the quoted header value
// is safe. An app name with nothing left is "app.sqlite".
func exportFilename(app string) string {
	var b strings.Builder
	for _, r := range app {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return "app.sqlite"
	}
	return b.String() + ".sqlite"
}

// exportApp streams a snapshot of the app's SQLite data (app.data.export).
func (s *Server) exportApp(w http.ResponseWriter, r *http.Request, c orgCall) error {
	app := r.PathValue("app")
	body, err := s.deps.Apps.ExportData(r.Context(), c.sub, c.org.ID, app)
	if err != nil {
		return err
	}
	defer func() { _ = body.Close() }()
	h := w.Header()
	h.Set("Content-Type", "application/vnd.sqlite3")
	h.Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, exportFilename(app)))
	w.WriteHeader(http.StatusOK)
	if _, err := io.Copy(w, body); err != nil {
		s.deps.Logger.Warn("api: export stream", "app", app, "err", err)
	}
	return nil
}
