package runtime

import (
	"context"
	"net/http"
	"net/url"
)

func svcPath(svcID string) string { return "/v1/services/" + seg(svcID) }

// ListServices: GET /v1/services?slug=&project=&environment=&cursor=.
// A slug filter yields 0 or 1 items.
func (s *Scoped) ListServices(ctx context.Context, f ServiceFilter) (Page[Service], error) {
	q := pageQuery(f.Cursor)
	if f.Slug != "" {
		q.Set("slug", f.Slug)
	}
	if f.Project != "" {
		q.Set("project", f.Project)
	}
	if f.Environment != "" {
		q.Set("environment", f.Environment)
	}
	var out Page[Service]
	_, err := s.do(ctx, req{method: http.MethodGet, path: "/v1/services", query: q}, &out)
	return out, err
}

// GetService: GET /v1/services/{s}; returns the ETag header.
func (s *Scoped) GetService(ctx context.Context, svcID string) (Service, string, error) {
	var out Service
	etag, err := s.do(ctx, req{method: http.MethodGet, path: svcPath(svcID)}, &out)
	if err == nil && etag == "" {
		etag = out.ETag
	}
	return out, etag, err
}

// CreateService: POST /v1/services (operator needs x-rt-tenant).
func (s *Scoped) CreateService(ctx context.Context, in ServiceCreate) (Service, error) {
	var out Service
	err := s.doJSON(ctx, http.MethodPost, "/v1/services", in, &out)
	return out, err
}

// PatchService: PATCH /v1/services/{s} with If-Match (412 when stale).
func (s *Scoped) PatchService(ctx context.Context, svcID string, in ServicePatch, ifMatch string) (Service, error) {
	b, err := jsonBody(in)
	if err != nil {
		return Service{}, err
	}
	var out Service
	_, err = s.do(ctx, req{method: http.MethodPatch, path: svcPath(svcID), body: b, ifMatch: ifMatch}, &out)
	return out, err
}

// DeleteService: DELETE /v1/services/{s}?keep_data=1 when keepData.
func (s *Scoped) DeleteService(ctx context.Context, svcID string, keepData bool) error {
	q := url.Values{}
	if keepData {
		q.Set("keep_data", "1")
	}
	_, err := s.do(ctx, req{method: http.MethodDelete, path: svcPath(svcID), query: q}, nil)
	return err
}
