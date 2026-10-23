package runtime

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
)

// GetEnv: GET /v1/services/{s}/env.
func (s *Scoped) GetEnv(ctx context.Context, svcID string) (map[string]string, error) {
	out := map[string]string{}
	err := s.doJSON(ctx, http.MethodGet, svcPath(svcID)+"/env", nil, &out)
	return out, err
}

// PutEnv: PUT /v1/services/{s}/env (replaces the whole map).
func (s *Scoped) PutEnv(ctx context.Context, svcID string, env map[string]string) (map[string]string, error) {
	if env == nil {
		env = map[string]string{}
	}
	out := map[string]string{}
	err := s.doJSON(ctx, http.MethodPut, svcPath(svcID)+"/env", env, &out)
	return out, err
}

// ListSecrets: GET /v1/services/{s}/secrets (names only).
func (s *Scoped) ListSecrets(ctx context.Context, svcID string) ([]SecretName, error) {
	var out []SecretName
	err := s.doJSON(ctx, http.MethodGet, svcPath(svcID)+"/secrets", nil, &out)
	return out, err
}

// PutSecret: PUT /v1/services/{s}/secrets/{name}.
func (s *Scoped) PutSecret(ctx context.Context, svcID, name, value string) error {
	return s.doJSON(ctx, http.MethodPut, svcPath(svcID)+"/secrets/"+seg(name), PutSecretBody{Value: value}, nil)
}

// DeleteSecret: DELETE /v1/services/{s}/secrets/{name}.
func (s *Scoped) DeleteSecret(ctx context.Context, svcID, name string) error {
	return s.doJSON(ctx, http.MethodDelete, svcPath(svcID)+"/secrets/"+seg(name), nil, nil)
}

// ListSchedules: GET /v1/services/{s}/schedules.
func (s *Scoped) ListSchedules(ctx context.Context, svcID string) ([]Schedule, error) {
	var out []Schedule
	err := s.doJSON(ctx, http.MethodGet, svcPath(svcID)+"/schedules", nil, &out)
	return out, err
}

// CreateSchedule: POST /v1/services/{s}/schedules.
func (s *Scoped) CreateSchedule(ctx context.Context, svcID string, in ScheduleBody) (Schedule, error) {
	var out Schedule
	err := s.doJSON(ctx, http.MethodPost, svcPath(svcID)+"/schedules", in, &out)
	return out, err
}

// UpdateSchedule: PATCH /v1/services/{s}/schedules/{id}.
func (s *Scoped) UpdateSchedule(ctx context.Context, svcID, id string, in ScheduleBody) (Schedule, error) {
	var out Schedule
	err := s.doJSON(ctx, http.MethodPatch, svcPath(svcID)+"/schedules/"+seg(id), in, &out)
	return out, err
}

// DeleteSchedule: DELETE /v1/services/{s}/schedules/{id}.
func (s *Scoped) DeleteSchedule(ctx context.Context, svcID, id string) error {
	return s.doJSON(ctx, http.MethodDelete, svcPath(svcID)+"/schedules/"+seg(id), nil, nil)
}

// QueueStats: GET /v1/services/{s}/queue.
func (s *Scoped) QueueStats(ctx context.Context, svcID string) (QueueStats, error) {
	var out QueueStats
	err := s.doJSON(ctx, http.MethodGet, svcPath(svcID)+"/queue", nil, &out)
	return out, err
}

// Enqueue: POST /v1/services/{s}/queue.
func (s *Scoped) Enqueue(ctx context.Context, svcID string, in EnqueueBody) (Enqueued, error) {
	var out Enqueued
	err := s.doJSON(ctx, http.MethodPost, svcPath(svcID)+"/queue", in, &out)
	return out, err
}

// ListDLQ: GET /v1/services/{s}/dlq.
func (s *Scoped) ListDLQ(ctx context.Context, svcID string) (DLQ, error) {
	var out DLQ
	err := s.doJSON(ctx, http.MethodGet, svcPath(svcID)+"/dlq", nil, &out)
	return out, err
}

// PurgeDLQ: DELETE /v1/services/{s}/dlq.
func (s *Scoped) PurgeDLQ(ctx context.Context, svcID string) error {
	return s.doJSON(ctx, http.MethodDelete, svcPath(svcID)+"/dlq", nil, nil)
}

// RedriveDLQ: POST /v1/services/{s}/dlq/redrive.
func (s *Scoped) RedriveDLQ(ctx context.Context, svcID string) (Redriven, error) {
	var out Redriven
	err := s.doJSON(ctx, http.MethodPost, svcPath(svcID)+"/dlq/redrive", nil, &out)
	return out, err
}

// ListHosts: GET /v1/services/{s}/hosts.
func (s *Scoped) ListHosts(ctx context.Context, svcID string) ([]Host, error) {
	var out []Host
	err := s.doJSON(ctx, http.MethodGet, svcPath(svcID)+"/hosts", nil, &out)
	return out, err
}

// PutHost: PUT /v1/services/{s}/hosts/{host}.
func (s *Scoped) PutHost(ctx context.Context, svcID, host string) (Host, error) {
	var out Host
	err := s.doJSON(ctx, http.MethodPut, svcPath(svcID)+"/hosts/"+seg(host), nil, &out)
	return out, err
}

// DeleteHost: DELETE /v1/services/{s}/hosts/{host}.
func (s *Scoped) DeleteHost(ctx context.Context, svcID, host string) error {
	return s.doJSON(ctx, http.MethodDelete, svcPath(svcID)+"/hosts/"+seg(host), nil, nil)
}

// Stats: GET /v1/services/{s}/stats?window=5m|1h|24h (free-form object).
func (s *Scoped) Stats(ctx context.Context, svcID, window string) (json.RawMessage, error) {
	q := url.Values{}
	if window != "" {
		q.Set("window", window)
	}
	var out json.RawMessage
	_, err := s.do(ctx, req{method: http.MethodGet, path: svcPath(svcID) + "/stats", query: q}, &out)
	return out, err
}

// Events: GET /v1/services/{s}/events?cursor=.
func (s *Scoped) Events(ctx context.Context, svcID, cursor string) (Page[Event], error) {
	var out Page[Event]
	_, err := s.do(ctx, req{method: http.MethodGet, path: svcPath(svcID) + "/events", query: pageQuery(cursor)}, &out)
	return out, err
}

// ExportData: GET /v1/services/{s}/data/export (SQLite snapshot stream).
// The caller closes the body.
func (s *Scoped) ExportData(ctx context.Context, svcID string) (io.ReadCloser, error) {
	resp, err := s.send(ctx, req{method: http.MethodGet, path: svcPath(svcID) + "/data/export", header: map[string]string{"Accept": "application/vnd.sqlite3"}, stream: true})
	if err != nil {
		return nil, err
	}
	return resp.Body, nil
}

// NodeStatus: GET /v1/node/status (operator).
func (s *Scoped) NodeStatus(ctx context.Context) (NodeStatus, error) {
	var out NodeStatus
	err := s.doJSON(ctx, http.MethodGet, "/v1/node/status", nil, &out)
	return out, err
}

// NodeConfig: GET /v1/node/config (free-form object).
func (s *Scoped) NodeConfig(ctx context.Context) (json.RawMessage, error) {
	var out json.RawMessage
	err := s.doJSON(ctx, http.MethodGet, "/v1/node/config", nil, &out)
	return out, err
}

// PutNodeConfig: PUT /v1/node/config.
func (s *Scoped) PutNodeConfig(ctx context.Context, in NodeConfigUpdate) (NodeConfigApplied, error) {
	var out NodeConfigApplied
	err := s.doJSON(ctx, http.MethodPut, "/v1/node/config", in, &out)
	return out, err
}

// NodeCache: GET /v1/node/cache (free-form object).
func (s *Scoped) NodeCache(ctx context.Context) (json.RawMessage, error) {
	var out json.RawMessage
	err := s.doJSON(ctx, http.MethodGet, "/v1/node/cache", nil, &out)
	return out, err
}

// NodeScheduler: GET /v1/node/scheduler (free-form object).
func (s *Scoped) NodeScheduler(ctx context.Context) (json.RawMessage, error) {
	var out json.RawMessage
	err := s.doJSON(ctx, http.MethodGet, "/v1/node/scheduler", nil, &out)
	return out, err
}

// DrainNode: POST /v1/node/drain.
func (s *Scoped) DrainNode(ctx context.Context) error {
	return s.doJSON(ctx, http.MethodPost, "/v1/node/drain", nil, nil)
}
