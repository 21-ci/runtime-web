package runtimetest

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"net/http"
	"slices"

	"github.com/21cloud/runtime-web/internal/runtime"
)

// Node and service stub routes. They return fixed minimal shapes: enough for
// the BFF to exercise its client paths, not a model of node behaviour.

func (f *Fake) nodeRoutes(mux *http.ServeMux) {
	f.route(mux, "GET /v1/node/status", operatorScope, f.nodeStatus)
	f.route(mux, "GET /v1/node/config", operatorScope, f.nodeConfig)
	f.route(mux, "PUT /v1/node/config", operatorScope, f.putNodeConfig)
	f.route(mux, "GET /v1/node/scheduler", operatorScope, f.nodeScheduler)
	f.route(mux, "GET /v1/node/cache", operatorScope, f.nodeCache)
	f.route(mux, "POST /v1/node/drain", operatorScope, f.nodeDrain)
	f.route(mux, "GET /v1/services/{s}/stats", "logs:read", f.serviceStats)
	f.route(mux, "GET /v1/services/{s}/data/export", "data:admin", f.exportData)
}

func (f *Fake) nodeStatus(_ principal, w http.ResponseWriter, _ *http.Request) *apiError {
	writeJSON(w, http.StatusOK, runtime.NodeStatus{
		Version: fakeVersion, Mode: "normal", DefaultProfile: "balanced", V8Sandbox: true,
		Processors: 1, Kinds: json.RawMessage(`{}`),
		Memory: json.RawMessage(`{"budget_bytes":0,"pressure":0}`),
	})
	return nil
}

func (f *Fake) nodeConfig(_ principal, w http.ResponseWriter, _ *http.Request) *apiError {
	writeJSON(w, http.StatusOK, map[string]any{"default_profile": "balanced", "degradation_mode": "shed"})
	return nil
}

// putNodeConfig reports which fields apply live; rate_limit always needs a restart.
func (f *Fake) putNodeConfig(_ principal, w http.ResponseWriter, r *http.Request) *apiError {
	var in runtime.NodeConfigUpdate
	if e := decode(r, &in); e != nil {
		return e
	}
	applied := []string{}
	if in.DefaultProfile != nil {
		applied = append(applied, "default_profile")
	}
	if in.DegradationMode != nil {
		applied = append(applied, "degradation_mode")
	}
	pending := []string{}
	if len(in.RateLimit) > 0 {
		pending = append(pending, "rate_limit")
	}
	writeJSON(w, http.StatusOK, runtime.NodeConfigApplied{Applied: applied, PendingRestart: pending})
	return nil
}

func (f *Fake) nodeScheduler(_ principal, w http.ResponseWriter, _ *http.Request) *apiError {
	writeJSON(w, http.StatusOK, map[string]any{"processors": 1, "queued": 0, "inflight": 0})
	return nil
}

func (f *Fake) nodeCache(_ principal, w http.ResponseWriter, _ *http.Request) *apiError {
	writeJSON(w, http.StatusOK, map[string]any{"hits": 0, "misses": 0})
	return nil
}

func (f *Fake) nodeDrain(_ principal, w http.ResponseWriter, _ *http.Request) *apiError {
	w.WriteHeader(http.StatusAccepted)
	return nil
}

var statsWindows = []string{"5m", "1h", "24h"}

func (f *Fake) serviceStats(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	window := r.URL.Query().Get("window")
	if window == "" {
		window = "5m"
	}
	if !slices.Contains(statsWindows, window) {
		return invalid("window must be 5m, 1h or 24h")
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"service_id": s.id, "window": window,
		"requests": 0, "errors": 0, "error_rate": 0, "p50_ms": 0, "p95_ms": 0, "p99_ms": 0,
	})
	return nil
}

// exportData returns a small zip standing in for the SQLite snapshot.
func (f *Fake) exportData(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	fw, err := zw.Create("data.sqlite")
	if err != nil {
		return &apiError{status: http.StatusInternalServerError, code: "internal", msg: "zip: " + err.Error()}
	}
	if _, err := fw.Write([]byte("runtimetest snapshot of " + s.id)); err != nil {
		return &apiError{status: http.StatusInternalServerError, code: "internal", msg: "zip: " + err.Error()}
	}
	if err := zw.Close(); err != nil {
		return &apiError{status: http.StatusInternalServerError, code: "internal", msg: "zip: " + err.Error()}
	}
	w.Header().Set("Content-Type", "application/zip")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf.Bytes())
	return nil
}
