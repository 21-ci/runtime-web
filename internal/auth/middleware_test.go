package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func errCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body %q: %v", rec.Body.String(), err)
	}
	return body.Error.Code
}

var okHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })

func TestCookieFlags(t *testing.T) {
	tests := []struct {
		name     string
		dev      bool
		wantName string
		secure   bool
	}{
		{"prod", false, "__Host-rtw_session", true},
		{"dev", true, "rtw_session", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := &Sessions{Dev: tt.dev}
			rec := httptest.NewRecorder()
			s.SetCookie(rec, "abc")
			res := rec.Result()
			cs := res.Cookies()
			if len(cs) != 1 {
				t.Fatalf("cookies = %d, want 1", len(cs))
			}
			c := cs[0]
			if c.Name != tt.wantName || c.Value != "abc" || c.Secure != tt.secure || !c.HttpOnly ||
				c.SameSite != http.SameSiteLaxMode || c.Path != "/" || c.Domain != "" {
				t.Errorf("cookie = %+v", c)
			}
			raw := res.Header.Get("Set-Cookie")
			if strings.Contains(strings.ToLower(raw), "domain=") {
				t.Errorf("Set-Cookie has Domain: %q", raw)
			}

			rec = httptest.NewRecorder()
			s.ClearCookie(rec)
			c = rec.Result().Cookies()[0]
			if c.Name != tt.wantName || c.MaxAge >= 0 || c.Secure != tt.secure || c.Path != "/" {
				t.Errorf("cleared cookie = %+v", c)
			}
		})
	}
}

func TestRequireSession(t *testing.T) {
	e := newEnv(t, plainHasher{})
	u := e.mkUser(t, "a@example.com", "password-123456")
	c, csrf := e.mkSession(t, u.ID)
	var got Principal
	h := e.svc.Sessions.RequireSession(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ = FromContext(r.Context())
	}))

	req := httptest.NewRequest("GET", "/api/me", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 401 || errCode(t, rec) != "unauthenticated" {
		t.Fatalf("no cookie: %d %s", rec.Code, rec.Body)
	}

	req = httptest.NewRequest("GET", "/api/me", nil)
	req.AddCookie(&http.Cookie{Name: "__Host-rtw_session", Value: c})
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 || got.User.ID != u.ID || got.CSRF != csrf || got.SessionID == "" {
		t.Fatalf("with cookie: %d %+v", rec.Code, got)
	}
}

func TestCSRFRejectsMissingOrWrong(t *testing.T) {
	p := Principal{User: User{ID: "usr_1"}, SessionID: "sid", CSRF: "the-csrf-token"}
	h := RequireCSRF(okHandler)
	tests := []struct {
		name   string
		method string
		header string
		noPrin bool
		want   int
	}{
		{"get passes", "GET", "", false, 204},
		{"head passes", "HEAD", "", false, 204},
		{"post missing", "POST", "", false, 403},
		{"post wrong", "POST", "the-csrf-tokeX", false, 403},
		{"post prefix", "POST", "the-csrf", false, 403},
		{"delete wrong", "DELETE", "nope", false, 403},
		{"post right", "POST", "the-csrf-token", false, 204},
		{"patch right", "PATCH", "the-csrf-token", false, 204},
		{"no principal", "POST", "the-csrf-token", true, 403},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, "/api/x", nil)
			if !tt.noPrin {
				req = req.WithContext(NewContext(req.Context(), p))
			}
			if tt.header != "" {
				req.Header.Set("X-CSRF-Token", tt.header)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tt.want {
				t.Fatalf("code = %d, want %d", rec.Code, tt.want)
			}
			if tt.want == 403 && errCode(t, rec) != "csrf_invalid" {
				t.Errorf("code = %q, want csrf_invalid", errCode(t, rec))
			}
		})
	}
}

func TestOriginRejectedOnUnsafe(t *testing.T) {
	h := CheckOrigin("https://console.example.com/")(okHandler)
	tests := []struct {
		name   string
		method string
		path   string
		origin string
		want   int
	}{
		{"login foreign", "POST", "/api/auth/login", "https://evil.example.net", 403},
		{"setup foreign", "POST", "/api/setup", "https://evil.example.net", 403},
		{"login missing", "POST", "/api/auth/login", "", 403},
		{"login null", "POST", "/api/auth/login", "null", 403},
		{"scheme mismatch", "POST", "/api/setup", "http://console.example.com", 403},
		{"port mismatch", "DELETE", "/api/x", "https://console.example.com:8443", 403},
		{"subdomain", "PUT", "/api/x", "https://a.console.example.com", 403},
		{"login same", "POST", "/api/auth/login", "https://console.example.com", 204},
		{"case-insensitive host", "POST", "/api/setup", "https://Console.Example.com", 204},
		{"get foreign ok", "GET", "/api/me", "https://evil.example.net", 204},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, tt.path, nil)
			if tt.origin != "" {
				req.Header.Set("Origin", tt.origin)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tt.want {
				t.Fatalf("code = %d, want %d", rec.Code, tt.want)
			}
			if tt.want == 403 && errCode(t, rec) != "origin_invalid" {
				t.Errorf("code = %q, want origin_invalid", errCode(t, rec))
			}
		})
	}
}

func TestRequireInstanceAdmin(t *testing.T) {
	h := RequireInstanceAdmin(okHandler)
	for _, tt := range []struct {
		admin bool
		want  int
	}{{false, 403}, {true, 204}} {
		req := httptest.NewRequest("GET", "/api/admin/users", nil)
		req = req.WithContext(NewContext(context.Background(), Principal{User: User{IsInstanceAdmin: tt.admin}}))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != tt.want {
			t.Errorf("admin=%v: code = %d, want %d", tt.admin, rec.Code, tt.want)
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/admin/users", nil))
	if rec.Code != 401 {
		t.Errorf("no principal: code = %d, want 401", rec.Code)
	}
}

func TestRequirePasswordChanged(t *testing.T) {
	mux := http.NewServeMux()
	for _, p := range []string{"GET /api/apps", "GET /api/me", "POST /api/me/password", "POST /api/auth/logout"} {
		mux.Handle(p, okHandler)
	}
	h := RequirePasswordChanged("/api/me", "/api/me/password", "/api/auth/logout")(mux)
	tests := []struct {
		name   string
		must   bool
		method string
		path   string
		want   int
	}{
		{"apps blocked", true, "GET", "/api/apps", 403},
		{"me passes", true, "GET", "/api/me", 204},
		{"password passes", true, "POST", "/api/me/password", 204},
		{"logout passes", true, "POST", "/api/auth/logout", 204},
		{"apps when changed", false, "GET", "/api/apps", 204},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, tt.path, nil)
			req = req.WithContext(NewContext(req.Context(), Principal{User: User{MustChangePassword: tt.must}}))
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tt.want {
				t.Fatalf("code = %d, want %d", rec.Code, tt.want)
			}
			if tt.want == 403 && errCode(t, rec) != "password_change_required" {
				t.Errorf("code = %q", errCode(t, rec))
			}
		})
	}
}
