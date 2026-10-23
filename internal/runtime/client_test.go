package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type captured struct {
	method, path, query, ctype string
	header                     http.Header
	body                       []byte
}

// stub serves one canned response and records the last request.
func stub(t *testing.T, status int, hdr map[string]string, body string) (*Client, *captured) {
	t.Helper()
	got := &captured{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		*got = captured{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("Content-Type"), r.Header.Clone(), b}
		for k, v := range hdr {
			w.Header().Set(k, v)
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return New(srv.URL, srv.Client()), got
}

func TestRootCredSetsTenantHeader(t *testing.T) {
	tests := []struct {
		name, tenant, want string
	}{
		{"with tenant", "ten_1", "ten_1"},
		{"without tenant", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, got := stub(t, 200, nil, `{"principal":"operator","scopes":[],"version":"1"}`)
			if _, err := c.With(RootCred{Token: "root", Tenant: tt.tenant}).Me(context.Background()); err != nil {
				t.Fatalf("Me: %v", err)
			}
			if a := got.header.Get("Authorization"); a != "Bearer root" {
				t.Errorf("Authorization = %q", a)
			}
			if h := got.header.Get("x-rt-tenant"); h != tt.want {
				t.Errorf("x-rt-tenant = %q, want %q", h, tt.want)
			}
		})
	}
}

func TestTenantKeyBearer(t *testing.T) {
	c, got := stub(t, 200, nil, `{"items":[]}`)
	if _, err := c.With(TenantKeyCred{Secret: "rtk_a_b"}).ListProjects(context.Background(), ""); err != nil {
		t.Fatalf("ListProjects: %v", err)
	}
	if a := got.header.Get("Authorization"); a != "Bearer rtk_a_b" {
		t.Errorf("Authorization = %q", a)
	}
	if h := got.header.Get("x-rt-tenant"); h != "" {
		t.Errorf("x-rt-tenant = %q, want empty", h)
	}
}

func TestRuntimeErrorMapping(t *testing.T) {
	env := func(code string) string { return `{"error":{"code":"` + code + `","message":"m","details":{}}}` }
	tests := []struct {
		name   string
		status int
		hdr    map[string]string
		body   string
		check  func(error) bool
		retry  time.Duration
	}{
		{"not found", 404, nil, env("not_found"), IsNotFound, 0},
		{"queue timeout", 503, nil, env("queue_timeout"), IsBusy, 0},
		{"overloaded", 503, nil, env("overloaded"), IsBusy, 0},
		{"build quota", 429, map[string]string{"Retry-After": "7"}, env("build_quota"), IsThrottled, 7 * time.Second},
		{"control disabled", 503, nil, env("control_disabled"), IsDisabled, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, _ := stub(t, tt.status, tt.hdr, tt.body)
			_, _, err := c.With(TenantKeyCred{Secret: "k"}).GetService(context.Background(), "svc_1")
			if !tt.check(err) {
				t.Fatalf("predicate false for %v", err)
			}
			var re *Error
			if !errors.As(err, &re) || re.RetryAfter != tt.retry {
				t.Errorf("RetryAfter = %v, want %v", re, tt.retry)
			}
		})
	}

	t.Run("disabled is not busy", func(t *testing.T) {
		c, _ := stub(t, 503, nil, env("control_disabled"))
		_, _, err := c.With(TenantKeyCred{Secret: "k"}).GetService(context.Background(), "svc_1")
		if IsBusy(err) || IsNotFound(err) || IsThrottled(err) {
			t.Errorf("unexpected predicate true for %v", err)
		}
	})

	t.Run("conn refused", func(t *testing.T) {
		srv := httptest.NewServer(http.NotFoundHandler())
		url := srv.URL
		srv.Close()
		_, err := New(url, nil).With(TenantKeyCred{Secret: "k"}).Me(context.Background())
		if !errors.Is(err, ErrUnavailable) {
			t.Fatalf("err = %v, want ErrUnavailable", err)
		}
	})

	t.Run("details preserved", func(t *testing.T) {
		body := `{"error":{"code":"validation_failed","message":"bad","details":{"diagnostics":[{"file":"main.ts","line":1,"col":2,"message":"x"}]}}}`
		c, _ := stub(t, 422, nil, body)
		_, err := c.With(TenantKeyCred{Secret: "k"}).UploadVersion(context.Background(), "svc_1", strings.NewReader("x"), "application/typescript", UploadOpts{})
		var re *Error
		if !errors.As(err, &re) {
			t.Fatalf("err = %v", err)
		}
		if re.Status != 422 || re.Code != "validation_failed" || re.Message != "bad" {
			t.Errorf("got %+v", re)
		}
		var d struct {
			Diagnostics []struct {
				File string `json:"file"`
				Line int    `json:"line"`
			} `json:"diagnostics"`
		}
		if err := json.Unmarshal(re.Details, &d); err != nil || len(d.Diagnostics) != 1 || d.Diagnostics[0].File != "main.ts" {
			t.Errorf("details = %s (%v)", re.Details, err)
		}
	})
}

func TestUploadVersionJSON(t *testing.T) {
	tests := []struct {
		name      string
		opts      UploadOpts
		wantQuery string
	}{
		{"eager no activate", UploadOpts{Compile: "eager"}, "compile=eager"},
		{"activate", UploadOpts{Activate: true}, "activate=1"},
		{"none", UploadOpts{}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, got := stub(t, 202, nil, `{"version":3,"source_digest":"sha256:a","build_state":"building","created_at":1700000000000,"failure":null,"lock_digest":null}`)
			src := `{"entry":"main.ts","files":{"main.ts":"export default {}"}}`
			v, err := c.With(TenantKeyCred{Secret: "k"}).UploadVersion(context.Background(), "svc_1", strings.NewReader(src), "application/json", tt.opts)
			if err != nil {
				t.Fatalf("UploadVersion: %v", err)
			}
			if got.method != http.MethodPost || got.path != "/v1/services/svc_1/versions" {
				t.Errorf("request = %s %s", got.method, got.path)
			}
			if got.ctype != "application/json" {
				t.Errorf("Content-Type = %q", got.ctype)
			}
			if got.query != tt.wantQuery {
				t.Errorf("query = %q, want %q", got.query, tt.wantQuery)
			}
			if string(got.body) != src {
				t.Errorf("body = %q", got.body)
			}
			if v.Version != 3 || v.BuildState != "building" || v.Failure != nil {
				t.Errorf("version = %+v", v)
			}
		})
	}
}

func TestListServicesBySlug(t *testing.T) {
	c, got := stub(t, 200, nil, `{"items":[{"id":"svc_1","slug":"x","tenant_id":"ten_1","runtime":"deno","etag":"\"1\"","project":"default","environment":"production","access":"public","status":{"build_state":"ready","tier":"T1","inflight":0}}],"next_cursor":null}`)
	p, err := c.With(TenantKeyCred{Secret: "k"}).ListServices(context.Background(), ServiceFilter{Slug: "x"})
	if err != nil {
		t.Fatalf("ListServices: %v", err)
	}
	if got.path != "/v1/services" || got.query != "slug=x" {
		t.Errorf("request = %s?%s", got.path, got.query)
	}
	if len(p.Items) != 1 || p.Items[0].ID != "svc_1" || p.NextCursor != nil {
		t.Errorf("page = %+v", p)
	}
}

func TestGetServiceETag(t *testing.T) {
	c, got := stub(t, 200, map[string]string{"ETag": `"7"`}, `{"id":"svc_1","etag":"\"7\""}`)
	s, etag, err := c.With(TenantKeyCred{Secret: "k"}).GetService(context.Background(), "svc_1")
	if err != nil || etag != `"7"` || s.ID != "svc_1" {
		t.Fatalf("GetService = %+v %q %v", s, etag, err)
	}
	if got.path != "/v1/services/svc_1" {
		t.Errorf("path = %s", got.path)
	}
}

func TestSetLiveIfMatch(t *testing.T) {
	c, got := stub(t, 200, nil, `{"id":"svc_1","live_version":2}`)
	s, err := c.With(TenantKeyCred{Secret: "k"}).SetLive(context.Background(), "svc_1", 2, `"7"`)
	if err != nil || s.LiveVersion == nil || *s.LiveVersion != 2 {
		t.Fatalf("SetLive = %+v %v", s, err)
	}
	if got.method != http.MethodPut || got.path != "/v1/services/svc_1/live" || got.header.Get("If-Match") != `"7"` {
		t.Errorf("request = %s %s If-Match=%q", got.method, got.path, got.header.Get("If-Match"))
	}
	if strings.TrimSpace(string(got.body)) != `{"version":2}` {
		t.Errorf("body = %s", got.body)
	}
}

func TestStreamLogs(t *testing.T) {
	c, got := stub(t, 200, map[string]string{"Content-Type": "text/event-stream"}, "id: 1\nevent: log\ndata: {}\n\n")
	rc, err := c.With(TenantKeyCred{Secret: "k"}).StreamLogs(context.Background(), "svc_1", "41")
	if err != nil {
		t.Fatalf("StreamLogs: %v", err)
	}
	defer rc.Close()
	b, _ := io.ReadAll(rc)
	if !strings.HasPrefix(string(b), "id: 1") {
		t.Errorf("body = %q", b)
	}
	if got.query != "follow=1" || got.header.Get("Last-Event-ID") != "41" {
		t.Errorf("query=%q Last-Event-ID=%q", got.query, got.header.Get("Last-Event-ID"))
	}
}

// Fixtures follow the openapi.json component schemas (ServiceView,
// VersionView, HostView, MeView, KeyCreated, LimitsView) incl. null unions.
func TestDecodeNullableFields(t *testing.T) {
	t.Run("service", func(t *testing.T) {
		var s Service
		raw := `{"id":"svc_1","tenant_id":"ten_1","slug":"x","runtime":"deno","name":null,"profile":null,"project":"default","environment":"production","live_version":null,"etag":"\"1\"","limits":{},"scaling":{},"access":"public","triggers":{"http":true},"ingress":{},"egress":{},"call":{"allowed_callers":[]},"status":{"build_state":"pending","tier":"T1","inflight":0,"last_error":null,"admission":null},"effective":{"cpu_ms":{"value":1000,"source":"profile:balanced"}}}`
		if err := json.Unmarshal([]byte(raw), &s); err != nil {
			t.Fatal(err)
		}
		if s.Name != nil || s.LiveVersion != nil || s.Status.LastError != nil || s.Status.Admission != nil {
			t.Errorf("nullables not nil: %+v", s)
		}
		if s.Status.Tier != "T1" || len(s.Effective) == 0 {
			t.Errorf("service = %+v", s)
		}
	})
	t.Run("version failure", func(t *testing.T) {
		var v Version
		raw := `{"version":1,"source_digest":"d","lock_digest":"l","build_state":"failed","failure":{"reason":"syntax","message":"m","diagnostics":[]},"created_at":1}`
		if err := json.Unmarshal([]byte(raw), &v); err != nil {
			t.Fatal(err)
		}
		if v.Failure == nil || v.Failure.Reason != "syntax" || v.LockDigest == nil {
			t.Errorf("version = %+v", v)
		}
	})
	t.Run("host pending", func(t *testing.T) {
		var h Host
		raw := `{"host":"a.example.com","status":"pending_verification","verify_token":"tok","created_at":1,"expires_at":2}`
		if err := json.Unmarshal([]byte(raw), &h); err != nil || h.ExpiresAt == nil || *h.VerifyToken != "tok" {
			t.Errorf("host = %+v %v", h, err)
		}
	})
	t.Run("me operator", func(t *testing.T) {
		var m Me
		raw := `{"principal":"operator","tenant_id":null,"key_id":null,"scopes":["*"],"service_ids":null,"plan":null,"version":"0.1.0"}`
		if err := json.Unmarshal([]byte(raw), &m); err != nil || m.Plan != nil || m.TenantID != nil {
			t.Errorf("me = %+v %v", m, err)
		}
	})
	t.Run("key created", func(t *testing.T) {
		var k KeyCreated
		raw := `{"id":"key_1","name":null,"scopes":["deploy"],"service_ids":null,"created_at":1,"expires_at":null,"last_used_at":null,"secret":"rtk_key_1_s"}`
		if err := json.Unmarshal([]byte(raw), &k); err != nil || k.Secret != "rtk_key_1_s" || k.ID != "key_1" || k.ExpiresAt != nil {
			t.Errorf("key = %+v %v", k, err)
		}
	})
	t.Run("limits unlimited", func(t *testing.T) {
		var l Limits
		raw := `{"plan":"free","day":"2026-10-23","resets_at":1,"invocations":{"limit":null,"used":5,"remaining":null,"period":"day"},"egress_bytes":{"limit":10,"used":1,"remaining":9,"period":"day"},"storage_bytes":{"used":0,"period":"total"},"services":{"used":1,"period":"total"},"schedules":{"used":0,"period":"per_service"}}`
		if err := json.Unmarshal([]byte(raw), &l); err != nil || l.Invocations.Limit != nil || *l.EgressBytes.Remaining != 9 {
			t.Errorf("limits = %+v %v", l, err)
		}
	})
}
