package main

// The container's edge and relay: the rules of deploy/Caddyfile without TLS (the platform or a reverse proxy in
// front terminates it).

import (
	"crypto/subtle"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"path"
	"regexp"
	"strings"
	"time"
)

var internalRe = regexp.MustCompile(`^(/s/[^/]+)?/api/internal(/|$)`)

func hostOnly(h string) string {
	if hh, _, err := net.SplitHostPort(h); err == nil {
		h = hh
	}
	return strings.ToLower(strings.TrimSuffix(h, "."))
}

// pathVariants: the decoded path, its cleaned form and the raw (escaped) form, lower-cased, so a rule cannot be
// dodged with //, /./, %2F or case tricks.
func pathVariants(u *url.URL) []string {
	p := u.Path
	if p == "" {
		p = "/"
	}
	unesc, _ := url.PathUnescape(u.EscapedPath())
	return []string{strings.ToLower(p), strings.ToLower(path.Clean(p)), strings.ToLower(u.EscapedPath()), strings.ToLower(path.Clean(unesc))}
}

// clientIP walks X-Forwarded-For from the right while the hop is a trusted proxy; without trusted proxies the
// TCP peer is the client and a client-sent header is ignored.
func clientIP(r *http.Request, trusted []netip.Prefix) (ip string, viaTrusted bool) {
	peerS, _, _ := net.SplitHostPort(r.RemoteAddr)
	peer, err := netip.ParseAddr(peerS)
	if err != nil {
		return peerS, false
	}
	isTrusted := func(a netip.Addr) bool {
		for _, p := range trusted {
			if p.Contains(a.Unmap()) {
				return true
			}
		}
		return false
	}
	if !isTrusted(peer) {
		return peer.Unmap().String(), false
	}
	hops := strings.Split(strings.Join(r.Header.Values("X-Forwarded-For"), ","), ",")
	cur := peer
	for i := len(hops) - 1; i >= 0; i-- {
		a, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if err != nil {
			break
		}
		cur = a
		if !isTrusted(a) {
			break
		}
	}
	return cur.Unmap().String(), true
}

func edgeHandler(c *config) http.Handler {
	target := &url.URL{Scheme: "http", Host: rtInvoke}
	consoleHost := hostOnly(c.consoleURL.Host)
	appsHost := hostOnly(c.appsURL.Host)
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.Host = pr.In.Host
			ip, viaTrusted := clientIP(pr.In, c.trusted)
			proto := "http"
			if pr.In.TLS != nil {
				proto = "https"
			} else if viaTrusted && pr.In.Header.Get("X-Forwarded-Proto") == "https" {
				proto = "https"
			}
			// Replace, never append: rt trusts this loopback hop and takes the value as the client.
			pr.Out.Header.Set("X-Forwarded-For", ip)
			pr.Out.Header.Set("X-Forwarded-Proto", proto)
			pr.Out.Header.Set("X-Forwarded-Host", pr.In.Host)
			pr.Out.Header.Del("X-Real-IP")
			pr.Out.Header.Del("Forwarded")
		},
		FlushInterval: -1, // log tails and streamed responses go out as they come
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "runtime unavailable", http.StatusBadGateway)
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !ready.Load() {
			w.Header().Set("Retry-After", "5")
			http.Error(w, "starting", http.StatusServiceUnavailable)
			return
		}
		host := hostOnly(r.Host)
		onApps := strings.HasSuffix(host, "."+appsHost)
		// Apps live only at <slug>.<apps host>: the bare apps host serves nothing, and the console (a service
		// too) is never served as <console slug>.<apps host>.
		if host == appsHost || (onApps && host == c.slug+"."+appsHost) {
			http.NotFound(w, r)
			return
		}
		for _, p := range pathVariants(r.URL) {
			// Internal routes (tls-ask, asset upload) are for the container itself.
			if internalRe.MatchString(p) {
				http.NotFound(w, r)
				return
			}
			// rt still path-routes /s/<slug>/ when no host rule matched (an unknown <x>.<apps host>): that would
			// serve one App, or the console, on another App's origin. Until rt can turn it off, block /s/ there.
			if onApps && (p == "/s" || strings.HasPrefix(p, "/s/")) {
				http.NotFound(w, r)
				return
			}
		}
		if host == consoleHost && c.consoleURL.Scheme == "https" {
			hsts{rp}.ServeHTTP(w, r)
			return
		}
		rp.ServeHTTP(w, r)
	})
}

// hsts adds HSTS on the console host only when the service did not send its own (one header, never two).
type hsts struct{ rp *httputil.ReverseProxy }

func (h hsts) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.rp.ServeHTTP(&hstsWriter{ResponseWriter: w}, r)
}

type hstsWriter struct {
	http.ResponseWriter
	wrote bool
}

func (w *hstsWriter) WriteHeader(code int) {
	if !w.wrote {
		w.wrote = true
		if w.Header().Get("Strict-Transport-Security") == "" {
			w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *hstsWriter) Write(b []byte) (int, error) {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(b)
}

func (w *hstsWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *hstsWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func serveEdge(c *config) error {
	srv := &http.Server{Addr: c.listen, Handler: edgeHandler(c), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 120 * time.Second}
	return srv.ListenAndServe()
}

// serveTLSAsk answers only the on-demand TLS question for a reverse proxy in front (Caddy `on_demand_tls ask`):
// 200 for an active custom domain. Opt-in (RTWEB_TLS_ASK_LISTEN); never publish it to the internet.
func serveTLSAsk(c *config) error {
	target := &url.URL{Scheme: "http", Host: rtInvoke}
	rp := &httputil.ReverseProxy{Rewrite: func(pr *httputil.ProxyRequest) {
		pr.SetURL(target)
		// The console host is mapped to the console service: no /s/ path routing needed.
		pr.Out.URL.Path = "/api/internal/tls-ask"
		pr.Out.URL.RawPath = ""
		pr.Out.Host = c.consoleURL.Host
		pr.Out.Header.Del("X-Forwarded-For")
	}}
	mux := http.NewServeMux()
	mux.Handle("GET /tls-ask", rp)
	srv := &http.Server{Addr: c.tlsAskListen, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	return srv.ListenAndServe()
}

var rtkRe = regexp.MustCompile(`^rtk_[A-Za-z0-9_-]+$`)

// serveRelay is the loopback relay of the rtctl-tenant binding: x-relay-auth must equal the secret, the
// per-org key in x-rtweb-key becomes Authorization, and both headers are dropped upstream.
func serveRelay(secret string) error {
	srv := &http.Server{Addr: relayAddr, Handler: relayHandler(secret), ReadHeaderTimeout: 10 * time.Second}
	return srv.ListenAndServe()
}

func relayHandler(secret string) http.Handler {
	target := &url.URL{Scheme: "http", Host: rtControl}
	rp := &httputil.ReverseProxy{Rewrite: func(pr *httputil.ProxyRequest) {
		pr.SetURL(target)
		pr.Out.Header.Set("Authorization", "Bearer "+pr.In.Header.Get("x-rtweb-key"))
		pr.Out.Header.Del("x-rtweb-key")
		pr.Out.Header.Del("x-relay-auth")
		pr.Out.Header.Del("x-rt-tenant")
	}, FlushInterval: -1}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("x-relay-auth")
		ok := len(secret) >= 32 && subtle.ConstantTimeCompare([]byte(got), []byte(secret)) == 1 && rtkRe.MatchString(r.Header.Get("x-rtweb-key"))
		if !ok {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		rp.ServeHTTP(w, r)
	})
}
