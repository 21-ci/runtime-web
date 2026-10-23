package runtime

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestDefaultHTTPClientsHaveTimeouts(t *testing.T) {
	control, stream := HTTPClients()
	if control.Timeout != ControlTimeout {
		t.Fatalf("control Timeout = %v, want %v", control.Timeout, ControlTimeout)
	}
	if stream.Timeout != 0 {
		t.Fatalf("stream Timeout = %v, want 0 (no overall limit)", stream.Timeout)
	}
	for name, hc := range map[string]*http.Client{"control": control, "stream": stream} {
		tr, ok := hc.Transport.(*http.Transport)
		if !ok {
			t.Fatalf("%s transport = %T, want *http.Transport", name, hc.Transport)
		}
		if tr.DialContext == nil || tr.TLSHandshakeTimeout != DialTimeout {
			t.Fatalf("%s: dial/TLS timeouts not set (tls=%v)", name, tr.TLSHandshakeTimeout)
		}
	}
	if tr := stream.Transport.(*http.Transport); tr.ResponseHeaderTimeout != StreamHeaderTimeout {
		t.Fatalf("stream ResponseHeaderTimeout = %v, want %v", tr.ResponseHeaderTimeout, StreamHeaderTimeout)
	}
}

// slowBody answers headers at once and then dribbles the body past the
// control client's timeout.
func slowBody(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		time.Sleep(300 * time.Millisecond)
		_, _ = io.WriteString(w, `{"status":"ok"}`)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestControlCallTimesOutButStreamDoesNot(t *testing.T) {
	srv := slowBody(t)
	c := NewWithStream(srv.URL, &http.Client{Timeout: 100 * time.Millisecond}, &http.Client{})
	s := c.With(nil)

	if _, err := s.NodeStatus(context.Background()); err == nil {
		t.Fatalf("control call err = %v, want timeout", err)
	}

	body, err := s.StreamLogs(context.Background(), "svc_1", "")
	if err != nil {
		t.Fatalf("StreamLogs: %v", err)
	}
	defer body.Close()
	if _, err := io.ReadAll(body); err != nil {
		t.Fatalf("stream read: %v (stream must not use the control timeout)", err)
	}
}
