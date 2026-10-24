package runtime

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
)

// maxSource bounds VersionSource reads.
const maxSource = 64 << 20

func versionPath(svcID string, v int) string {
	return svcPath(svcID) + "/versions/" + strconv.Itoa(v)
}

// UploadVersion: POST /v1/services/{s}/versions?activate=1&compile=. The
// contentType selects the format (application/json, application/typescript, …).
func (s *Scoped) UploadVersion(ctx context.Context, svcID string, body io.Reader, contentType string, opts UploadOpts) (Version, error) {
	q := url.Values{}
	if opts.Activate {
		q.Set("activate", "1")
	}
	if opts.Compile != "" {
		q.Set("compile", opts.Compile)
	}
	var out Version
	_, err := s.do(ctx, req{method: http.MethodPost, path: svcPath(svcID) + "/versions", query: q, body: body, ctype: contentType}, &out)
	return out, err
}

// GetVersion: GET /v1/services/{s}/versions/{v}.
func (s *Scoped) GetVersion(ctx context.Context, svcID string, v int) (Version, error) {
	var out Version
	err := s.doJSON(ctx, http.MethodGet, versionPath(svcID, v), nil, &out)
	return out, err
}

// ListVersions: GET /v1/services/{s}/versions.
func (s *Scoped) ListVersions(ctx context.Context, svcID string) ([]Version, error) {
	var out []Version
	err := s.doJSON(ctx, http.MethodGet, svcPath(svcID)+"/versions", nil, &out)
	return out, err
}

// VersionSource: GET /v1/services/{s}/versions/{v}/source (uploaded bytes).
func (s *Scoped) VersionSource(ctx context.Context, svcID string, v int) ([]byte, string, error) {
	resp, err := s.send(ctx, req{method: http.MethodGet, path: versionPath(svcID, v) + "/source"})
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxSource))
	if err != nil {
		return nil, "", fmt.Errorf("runtime: read source: %w", err)
	}
	return b, resp.Header.Get("Content-Type"), nil
}

// BuildLogs: GET /v1/services/{s}/versions/{v}/build/logs (raw SSE body).
func (s *Scoped) BuildLogs(ctx context.Context, svcID string, v int) (io.ReadCloser, error) {
	resp, err := s.send(ctx, req{method: http.MethodGet, path: versionPath(svcID, v) + "/build/logs", header: map[string]string{"Accept": "text/event-stream"}, stream: true})
	if err != nil {
		return nil, err
	}
	return resp.Body, nil
}

// Rebuild: POST /v1/services/{s}/versions/{v}/rebuild.
func (s *Scoped) Rebuild(ctx context.Context, svcID string, v int) (Version, error) {
	var out Version
	err := s.doJSON(ctx, http.MethodPost, versionPath(svcID, v)+"/rebuild", nil, &out)
	return out, err
}

// SetLive: PUT /v1/services/{s}/live with If-Match.
func (s *Scoped) SetLive(ctx context.Context, svcID string, version int, ifMatch string) (Service, error) {
	b, err := jsonBody(SetLiveBody{Version: version})
	if err != nil {
		return Service{}, err
	}
	var out Service
	_, err = s.do(ctx, req{method: http.MethodPut, path: svcPath(svcID) + "/live", body: b, ifMatch: ifMatch}, &out)
	return out, err
}

// StreamLogs: GET /v1/services/{s}/logs?follow=1 with Last-Event-ID (raw SSE body).
func (s *Scoped) StreamLogs(ctx context.Context, svcID, lastEventID string) (io.ReadCloser, error) {
	h := map[string]string{"Accept": "text/event-stream"}
	if lastEventID != "" {
		h["Last-Event-ID"] = lastEventID
	}
	resp, err := s.send(ctx, req{method: http.MethodGet, path: svcPath(svcID) + "/logs", query: url.Values{"follow": {"1"}}, header: h, stream: true})
	if err != nil {
		return nil, err
	}
	return resp.Body, nil
}
