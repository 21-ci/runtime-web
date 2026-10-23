// Package router is the custom-domain and console request router (rtrouter).
// It holds no runtime credentials; it only forwards requests.
package router

import (
	"context"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

// Upstreams are the proxy targets.
type Upstreams struct {
	Runtime *url.URL // runtime public URL
	Console *url.URL // rtweb
}

type ctxKey struct{}

const notFoundHTML = `<!doctype html><html><head><meta charset="utf-8"><title>Not found</title></head>` +
	`<body><h1>404</h1><p>No app is served at this address.</p></body></html>`

// Resolve returns the upstream for host, or nil when the host is unknown.
func Resolve(r *Routes, up Upstreams, host string) *url.URL {
	if r == nil {
		return nil
	}
	h := strings.ToLower(host)
	if hh, _, err := net.SplitHostPort(h); err == nil {
		h = hh
	}
	h = strings.TrimSuffix(h, ".")
	switch {
	case r.ConsoleHost != "" && h == strings.ToLower(r.ConsoleHost):
		return up.Console
	case r.BaseDomain != "":
		if sub, ok := strings.CutSuffix(h, "."+strings.ToLower(r.BaseDomain)); ok && sub != "" && !strings.Contains(sub, ".") {
			return up.Runtime
		}
	}
	if _, ok := r.Hosts[h]; ok {
		return up.Runtime
	}
	return nil
}

// Handler proxies by Host using the current table snapshot.
func Handler(t *Table, up Upstreams) http.Handler {
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			target := pr.In.Context().Value(ctxKey{}).(*url.URL)
			pr.SetURL(target)
			pr.Out.Host = pr.In.Host
			pr.SetXForwarded()
		},
		FlushInterval: -1,
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		target := Resolve(t.Load(), up, r.Host)
		if target == nil {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(notFoundHTML))
			return
		}
		rp.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, target)))
	})
}
