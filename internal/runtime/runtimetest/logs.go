package runtimetest

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/21cloud/runtime-web/internal/runtime"
)

// logLine is one runtime log record. Its seq is the SSE event id.
type logLine struct {
	Seq       int64  `json:"seq"`
	TS        int64  `json:"ts"`
	Level     string `json:"level"`
	ServiceID string `json:"service_id"`
	Kind      string `json:"kind"`
	Msg       string `json:"msg"`
}

// logRoutes registers the log route outside f.route: a follow stream blocks,
// so it must not hold f.mu.
func (f *Fake) logRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/services/{s}/logs", f.serveLogs)
}

func (f *Fake) serveLogs(w http.ResponseWriter, r *http.Request) {
	p, aerr := f.authenticate(r)
	if aerr == nil {
		aerr = p.check("logs:read")
	}
	if aerr != nil {
		writeErr(w, aerr)
		return
	}
	if truthy(r.URL.Query().Get("follow")) {
		f.follow(p, w, r)
		return
	}
	f.mu.Lock()
	s, aerr := f.serviceFor(p, r.PathValue("s"))
	items := []logLine{}
	if aerr == nil {
		items = append(items, s.logs...)
	}
	f.mu.Unlock()
	if aerr != nil {
		writeErr(w, aerr)
		return
	}
	writeJSON(w, http.StatusOK, runtime.Page[logLine]{Items: items})
}

// follow streams log lines as SSE until the client leaves, the service is
// removed or the fake shuts down. Each key holds at most SSELimit streams.
func (f *Fake) follow(p principal, w http.ResponseWriter, r *http.Request) {
	key := rootKeyID
	if p.key != nil {
		key = p.key.id
	}
	f.mu.Lock()
	s, aerr := f.serviceFor(p, r.PathValue("s"))
	if aerr == nil && f.streams[key] >= f.SSELimit {
		aerr = &apiError{status: http.StatusTooManyRequests, code: "rate_limited", msg: "too many open log streams for this key", retry: time.Second}
	}
	if aerr != nil {
		f.mu.Unlock()
		writeErr(w, aerr)
		return
	}
	f.streams[key]++
	f.mu.Unlock()
	defer f.closeStream(key)

	cursor := lastEventID(r)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	rc := http.NewResponseController(w)
	_ = rc.Flush()

	for {
		f.mu.Lock()
		if f.services[s.id] != s {
			f.mu.Unlock()
			return
		}
		var pending []logLine
		for _, l := range s.logs {
			if l.Seq > cursor {
				pending = append(pending, l)
			}
		}
		wake := s.notify
		f.mu.Unlock()

		for _, l := range pending {
			data, _ := json.Marshal(l)
			_, _ = fmt.Fprintf(w, "id: %d\nevent: log\ndata: %s\n\n", l.Seq, data)
			cursor = l.Seq
		}
		if len(pending) > 0 {
			_ = rc.Flush()
		}
		select {
		case <-wake:
		case <-r.Context().Done():
			return
		case <-f.done:
			return
		}
	}
}

func lastEventID(r *http.Request) int64 {
	n, err := strconv.ParseInt(r.Header.Get("Last-Event-ID"), 10, 64)
	if err != nil {
		return 0
	}
	return n
}

func (f *Fake) closeStream(key string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.streams[key]--
	if f.streams[key] <= 0 {
		delete(f.streams, key)
	}
}

// OpenStreams reports the open log streams of key: a tenant key's id, or
// "root" for the operator token.
func (f *Fake) OpenStreams(key string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.streams[key]
}

// EmitLog appends an info line to svc's log and wakes its streams. An unknown
// service is ignored.
func (f *Fake) EmitLog(svc, line string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := f.services[svc]
	if s == nil {
		return
	}
	s.logSeq++
	s.logs = append(s.logs, logLine{Seq: s.logSeq, TS: nowMS(), Level: "info", ServiceID: s.id, Kind: "runtime", Msg: line})
	close(s.notify)
	s.notify = make(chan struct{})
}
