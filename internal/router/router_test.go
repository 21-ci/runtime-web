package router

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testTable() *Table {
	t := &Table{}
	t.Store(&Routes{
		ConsoleHost: "console.example.com",
		BaseDomain:  "apps.example.com",
		Hosts:       map[string]HostRoute{"shop.acme.io": {Slug: "shop"}},
	})
	return t
}

type echo struct{ host, xff string }

func setup(t *testing.T, runtime http.Handler) (*httptest.Server, *httptest.Server, chan echo) {
	t.Helper()
	seen := make(chan echo, 4)
	rec := func(w http.ResponseWriter, r *http.Request, who string) {
		seen <- echo{host: r.Host, xff: r.Header.Get("X-Forwarded-For")}
		io.WriteString(w, who)
	}
	if runtime == nil {
		runtime = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { rec(w, r, "runtime") })
	}
	rt := httptest.NewServer(runtime)
	t.Cleanup(rt.Close)
	console := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { rec(w, r, "console") }))
	t.Cleanup(console.Close)
	ru, _ := url.Parse(rt.URL)
	cu, _ := url.Parse(console.URL)
	front := httptest.NewServer(Handler(testTable(), Upstreams{Runtime: ru, Console: cu}))
	t.Cleanup(front.Close)
	return front, rt, seen
}

func get(t *testing.T, front *httptest.Server, host string, hdr map[string]string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest("GET", front.URL+"/x", nil)
	req.Host = host
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res, string(b)
}

func TestUnknownHost404(t *testing.T) {
	front, _, _ := setup(t, nil)
	res, body := get(t, front, "nope.other.com", nil)
	if res.StatusCode != 404 || !strings.Contains(res.Header.Get("Content-Type"), "text/html") || !strings.Contains(body, "<html") {
		t.Fatalf("got %d %q %q", res.StatusCode, res.Header.Get("Content-Type"), body)
	}
}

func TestRouting(t *testing.T) {
	tests := []struct{ name, host, want string }{
		{"TestKnownHostProxiedWithHost", "shop.acme.io", "runtime"},
		{"TestBaseDomainSubdomain", "myapp.apps.example.com", "runtime"},
		{"TestConsoleHostToRTWeb", "console.example.com", "console"},
		{"host with port", "shop.acme.io:443", "runtime"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			front, _, seen := setup(t, nil)
			res, body := get(t, front, tt.host, nil)
			if res.StatusCode != 200 || body != tt.want {
				t.Fatalf("got %d %q", res.StatusCode, body)
			}
			if e := <-seen; e.host != tt.host {
				t.Fatalf("host not preserved: %q", e.host)
			}
		})
	}
}

func TestBaseDomainRejectsNested(t *testing.T) {
	front, _, _ := setup(t, nil)
	for _, h := range []string{"a.b.apps.example.com", "apps.example.com"} {
		if res, _ := get(t, front, h, nil); res.StatusCode != 404 {
			t.Fatalf("%s: got %d", h, res.StatusCode)
		}
	}
}

func TestIncomingXFFDropped(t *testing.T) {
	front, _, seen := setup(t, nil)
	get(t, front, "shop.acme.io", map[string]string{"X-Forwarded-For": "6.6.6.6"})
	e := <-seen
	if strings.Contains(e.xff, "6.6.6.6") || e.xff != "127.0.0.1" {
		t.Fatalf("xff = %q", e.xff)
	}
}

func TestBusyPassthrough(t *testing.T) {
	front, _, _ := setup(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "7")
		w.WriteHeader(503)
		io.WriteString(w, "busy")
	}))
	res, body := get(t, front, "shop.acme.io", nil)
	if res.StatusCode != 503 || res.Header.Get("Retry-After") != "7" || body != "busy" {
		t.Fatalf("got %d %q %q", res.StatusCode, res.Header.Get("Retry-After"), body)
	}
}

func TestStreamingNotBuffered(t *testing.T) {
	release := make(chan struct{})
	front, _, _ := setup(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: one\n\n")
		w.(http.Flusher).Flush()
		<-release
	}))
	defer close(release)
	req, _ := http.NewRequest("GET", front.URL, nil)
	req.Host = "shop.acme.io"
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	got := make(chan string, 1)
	go func() {
		line, _ := bufio.NewReader(res.Body).ReadString('\n')
		got <- line
	}()
	select {
	case l := <-got:
		if l != "data: one\n" {
			t.Fatalf("line %q", l)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stream buffered")
	}
}

func TestPollerKeepsLastGoodOnError(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer s3cret" {
			w.WriteHeader(401)
			return
		}
		switch calls.Add(1) {
		case 1:
			w.Header().Set("ETag", `"v1"`)
			io.WriteString(w, `{"console_host":"c.example","base_domain":"b.example","hosts":{"x.io":{"slug":"x"}}}`)
		case 2:
			if r.Header.Get("If-None-Match") != `"v1"` {
				t.Errorf("If-None-Match = %q", r.Header.Get("If-None-Match"))
			}
			w.WriteHeader(304)
		case 3:
			w.WriteHeader(500)
		default:
			io.WriteString(w, `{not json`)
		}
	}))
	defer srv.Close()
	tbl := &Table{}
	p := &Poller{URL: srv.URL, Secret: "s3cret", Table: tbl}
	ctx := context.Background()
	if err := p.Poll(ctx); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		err := p.Poll(ctx)
		if (i == 0) != (err == nil) {
			t.Fatalf("poll %d err=%v", i, err)
		}
		r := tbl.Load()
		if r == nil || r.Hosts["x.io"].Slug != "x" || r.ConsoleHost != "c.example" {
			t.Fatalf("poll %d lost table: %+v", i, r)
		}
	}
}
