// Package runtime is a hand-written typed client for the 21 Cloud Runtime
// control API (/v1). Types mirror the openapi.json component schemas.
package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Runtime HTTP timeouts. Control calls are bounded end to end; streams
// (SSE logs, build logs, data export) are bounded only until headers arrive.
const (
	ControlTimeout      = 30 * time.Second
	StreamHeaderTimeout = 15 * time.Second
	DialTimeout         = 5 * time.Second
)

func transport() *http.Transport {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.DialContext = (&net.Dialer{Timeout: DialTimeout, KeepAlive: 30 * time.Second}).DialContext
	tr.TLSHandshakeTimeout = DialTimeout
	return tr
}

// HTTPClients returns the production control client (30 s overall timeout)
// and stream client (no overall timeout, 15 s response-header timeout).
func HTTPClients() (control, stream *http.Client) {
	st := transport()
	st.ResponseHeaderTimeout = StreamHeaderTimeout
	return &http.Client{Timeout: ControlTimeout, Transport: transport()}, &http.Client{Transport: st}
}

// Client talks to one runtime node. It holds no credential; use With.
type Client struct {
	base   string
	hc     *http.Client
	stream *http.Client
}

// New returns a client for baseURL (e.g. "http://runtime:8080"). A nil hc
// uses http.DefaultClient.
func New(baseURL string, hc *http.Client) *Client {
	if hc == nil {
		hc = http.DefaultClient
	}
	return NewWithStream(baseURL, hc, hc)
}

// NewWithStream is New with a separate client for long-lived streams.
func NewWithStream(baseURL string, control, stream *http.Client) *Client {
	if control == nil {
		control = http.DefaultClient
	}
	if stream == nil {
		stream = control
	}
	return &Client{base: strings.TrimRight(baseURL, "/"), hc: control, stream: stream}
}

// With binds a credential; all API methods live on *Scoped.
func (c *Client) With(cred Credential) *Scoped {
	return &Scoped{c: c, cred: cred}
}

// Scoped is a Client bound to one credential.
type Scoped struct {
	c    *Client
	cred Credential
}

// Page is a cursor-paginated list.
type Page[T any] struct {
	Items      []T     `json:"items"`
	NextCursor *string `json:"next_cursor"`
}

// req describes one control-API call.
type req struct {
	method  string
	path    string
	query   url.Values
	body    io.Reader
	ctype   string
	ifMatch string
	header  map[string]string
	stream  bool // long-lived body: use the stream client
}

func jsonBody(v any) (io.Reader, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("runtime: encode body: %w", err)
	}
	return bytes.NewReader(b), nil
}

// send performs r and returns the response on 2xx; the caller closes Body.
func (s *Scoped) send(ctx context.Context, r req) (*http.Response, error) {
	u := s.c.base + r.path
	if len(r.query) > 0 {
		u += "?" + r.query.Encode()
	}
	hr, err := http.NewRequestWithContext(ctx, r.method, u, r.body)
	if err != nil {
		return nil, fmt.Errorf("runtime: build request: %w", err)
	}
	if r.body != nil {
		ct := r.ctype
		if ct == "" {
			ct = "application/json"
		}
		hr.Header.Set("Content-Type", ct)
	}
	hr.Header.Set("Accept", "application/json")
	if r.ifMatch != "" {
		hr.Header.Set("If-Match", r.ifMatch)
	}
	for k, v := range r.header {
		hr.Header.Set(k, v)
	}
	if s.cred != nil {
		s.cred.apply(hr)
	}
	hc := s.c.hc
	if r.stream {
		hc = s.c.stream
	}
	resp, err := hc.Do(hr)
	if err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("runtime: %s %s: %w", r.method, r.path, ctx.Err())
		}
		return nil, fmt.Errorf("%w: %s %s: %v", ErrUnavailable, r.method, r.path, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		defer resp.Body.Close()
		return nil, decodeError(resp)
	}
	return resp, nil
}

// do performs r and decodes a JSON response into out (nil = discard).
// It returns the response ETag header.
func (s *Scoped) do(ctx context.Context, r req, out any) (string, error) {
	resp, err := s.send(ctx, r)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if out != nil && resp.StatusCode != http.StatusNoContent {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			return "", fmt.Errorf("runtime: decode %s %s: %w", r.method, r.path, err)
		}
	} else {
		_, _ = io.Copy(io.Discard, resp.Body)
	}
	return resp.Header.Get("ETag"), nil
}

// doJSON sends in as a JSON body (nil = no body) and decodes into out.
func (s *Scoped) doJSON(ctx context.Context, method, path string, in, out any) error {
	r := req{method: method, path: path}
	if in != nil {
		b, err := jsonBody(in)
		if err != nil {
			return err
		}
		r.body = b
	}
	_, err := s.do(ctx, r, out)
	return err
}

// seg escapes one path segment.
func seg(s string) string { return url.PathEscape(s) }

func pageQuery(cursor string) url.Values {
	q := url.Values{}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	return q
}
