package apps

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/runtime"
)

// Log hub defaults (docs/api-web.md §8.6).
const (
	logBufSize    = 500
	logSubSlack   = 64
	logGrace      = 30 * time.Second
	logMaxPerOrg  = 8
	logMinBackoff = 500 * time.Millisecond
	logMaxBackoff = 30 * time.Second
	logMaxLine    = 1 << 20
)

// LogEvent is one SSE event for a browser: Event is "log", "gap" or "error". ID is the runtime seq
// for "log" and empty otherwise. Data is one line of JSON.
type LogEvent struct {
	ID    string
	Event string
	Data  json.RawMessage
}

// LogHub fans one upstream runtime log stream per app out to every browser viewing it. The org's
// default key may hold only a few SSE streams on the runtime, so viewers never open their own.
// Each upstream keeps a ring buffer for Last-Event-ID resume, reconnects with backoff after it
// ends, and closes a grace period after its last viewer leaves.
type LogHub struct {
	svc *Service

	bufSize    int
	subSlack   int
	grace      time.Duration
	maxPerOrg  int
	minBackoff time.Duration
	maxBackoff time.Duration

	mu      sync.Mutex
	streams map[cacheKey]*logStream
}

// NewLogHub returns a LogHub over svc. Close stops every upstream.
func NewLogHub(svc *Service) *LogHub {
	return &LogHub{
		svc: svc, bufSize: logBufSize, subSlack: logSubSlack, grace: logGrace, maxPerOrg: logMaxPerOrg,
		minBackoff: logMinBackoff, maxBackoff: logMaxBackoff, streams: map[cacheKey]*logStream{},
	}
}

type logStream struct {
	hub   *LogHub
	key   cacheKey
	svcID string

	cancel context.CancelFunc
	done   chan struct{}

	mu     sync.Mutex
	ring   []LogEvent // oldest first, at most hub.bufSize
	subs   map[*logSub]struct{}
	idle   *time.Timer
	closed bool
}

type logSub struct {
	ch chan LogEvent
}

// Subscribe streams the app's logs to the caller (app.logs.read). With lastEventID it first replays
// buffered events after that seq, preceded by a "gap" event when the seq is older than the buffer;
// without it the whole buffer is replayed. The channel closes when the stream ends: after a terminal
// "error" event, when the caller is too slow to keep up (it should reconnect with its last id), on
// cancel, or when ctx is done. cancel is idempotent. Too many upstreams in the org is
// apperr.ErrRateLimited.
func (h *LogHub) Subscribe(ctx context.Context, sub authz.Subject, orgID, slug, lastEventID string) (<-chan LogEvent, func(), error) {
	app, _, err := h.svc.app(ctx, sub, orgID, slug, authz.AppLogsRead)
	if err != nil {
		return nil, nil, err
	}
	k := cacheKey{orgID, slug}
	h.mu.Lock()
	st := h.streams[k]
	if st != nil && st.svcID != app.SvcID {
		// The slug now names another app: retire the old upstream.
		h.retireLocked(st)
		st = nil
	}
	if st == nil {
		if h.openLocked(orgID) >= h.maxPerOrg {
			h.mu.Unlock()
			return nil, nil, fmt.Errorf("apps: log streams in org: %w", apperr.ErrRateLimited)
		}
		st = h.start(k, app.SvcID)
	}
	s := st.add(lastEventID)
	h.mu.Unlock()

	var once sync.Once
	unsub := func() { once.Do(func() { st.remove(s) }) }
	stop := context.AfterFunc(ctx, unsub)
	cancel := func() {
		stop()
		unsub()
	}
	return s.ch, cancel, nil
}

// Close stops every upstream and closes every subscriber channel. It waits for the upstreams to exit.
func (h *LogHub) Close() {
	h.mu.Lock()
	var all []*logStream
	for _, st := range h.streams {
		all = append(all, st)
		h.retireLocked(st)
	}
	h.mu.Unlock()
	for _, st := range all {
		<-st.done
	}
}

// openLocked counts orgID's upstreams. h.mu is held.
func (h *LogHub) openLocked(orgID string) int {
	n := 0
	for k := range h.streams {
		if k.org == orgID {
			n++
		}
	}
	return n
}

// open counts orgID's upstreams.
func (h *LogHub) open(orgID string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.openLocked(orgID)
}

// streamDone returns the done channel of the upstream for (orgID, slug), or nil.
func (h *LogHub) streamDone(orgID, slug string) <-chan struct{} {
	h.mu.Lock()
	defer h.mu.Unlock()
	if st := h.streams[cacheKey{orgID, slug}]; st != nil {
		return st.done
	}
	return nil
}

// start registers and runs a new upstream. h.mu is held.
func (h *LogHub) start(k cacheKey, svcID string) *logStream {
	ctx, cancel := context.WithCancel(context.Background())
	st := &logStream{hub: h, key: k, svcID: svcID, cancel: cancel, done: make(chan struct{}), subs: map[*logSub]struct{}{}}
	h.streams[k] = st
	go st.run(ctx)
	return st
}

// retireLocked unregisters st, stops its upstream and closes its subscribers. h.mu is held.
func (h *LogHub) retireLocked(st *logStream) {
	if h.streams[st.key] == st {
		delete(h.streams, st.key)
	}
	st.cancel()
	st.mu.Lock()
	st.closeLocked()
	st.mu.Unlock()
}

// add registers a subscriber and queues its replay. h.mu is held.
func (st *logStream) add(lastEventID string) *logSub {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.idle != nil {
		st.idle.Stop()
		st.idle = nil
	}
	replay := st.replayLocked(lastEventID)
	s := &logSub{ch: make(chan LogEvent, len(replay)+st.hub.subSlack)}
	for _, ev := range replay {
		s.ch <- ev
	}
	st.subs[s] = struct{}{}
	return s
}

// replayLocked returns the buffered events after lastEventID (all of them when it is empty or not a
// seq), led by a gap event when lastEventID is older than the buffer. st.mu is held.
func (st *logStream) replayLocked(lastEventID string) []LogEvent {
	if len(st.ring) == 0 {
		return nil
	}
	last, err := strconv.ParseInt(lastEventID, 10, 64)
	if err != nil {
		return append([]LogEvent(nil), st.ring...)
	}
	oldest := seqOf(st.ring[0])
	if last < oldest-1 {
		gap := LogEvent{Event: "gap", Data: json.RawMessage(fmt.Sprintf(`{"from":%d}`, oldest))}
		return append([]LogEvent{gap}, st.ring...)
	}
	var out []LogEvent
	for _, ev := range st.ring {
		if seqOf(ev) > last {
			out = append(out, ev)
		}
	}
	return out
}

func seqOf(ev LogEvent) int64 {
	n, _ := strconv.ParseInt(ev.ID, 10, 64)
	return n
}

// remove drops s and, when it was the last subscriber, schedules the upstream's close.
func (st *logStream) remove(s *logSub) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if _, ok := st.subs[s]; !ok {
		return
	}
	delete(st.subs, s)
	close(s.ch)
	if len(st.subs) == 0 && !st.closed && st.idle == nil {
		st.idle = time.AfterFunc(st.hub.grace, st.idleClose)
	}
}

// idleClose retires the upstream unless a subscriber arrived during the grace period.
func (st *logStream) idleClose() {
	h := st.hub
	h.mu.Lock()
	defer h.mu.Unlock()
	st.mu.Lock()
	busy := len(st.subs) > 0
	st.mu.Unlock()
	if !busy {
		h.retireLocked(st)
	}
}

// closeLocked closes every subscriber channel. st.mu is held.
func (st *logStream) closeLocked() {
	st.closed = true
	if st.idle != nil {
		st.idle.Stop()
		st.idle = nil
	}
	for s := range st.subs {
		close(s.ch)
		delete(st.subs, s)
	}
}

// publish buffers ev and sends it to every subscriber. A subscriber whose channel is full is dropped
// (its channel closes) so it never holds up the others; it reconnects with its last id.
func (st *logStream) publish(ev LogEvent) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.closed {
		return
	}
	if ev.Event == "log" {
		if len(st.ring) >= st.hub.bufSize {
			n := len(st.ring) - st.hub.bufSize + 1
			st.ring = append(st.ring[:0], st.ring[n:]...)
		}
		st.ring = append(st.ring, ev)
	}
	for s := range st.subs {
		select {
		case s.ch <- ev:
		default:
			close(s.ch)
			delete(st.subs, s)
		}
	}
	if len(st.subs) == 0 && st.idle == nil {
		st.idle = time.AfterFunc(st.hub.grace, st.idleClose)
	}
}

// lastID is the seq of the newest buffered event, or "".
func (st *logStream) lastID() string {
	st.mu.Lock()
	defer st.mu.Unlock()
	if len(st.ring) == 0 {
		return ""
	}
	return st.ring[len(st.ring)-1].ID
}

// run keeps the upstream open until ctx ends or the runtime refuses it for good.
func (st *logStream) run(ctx context.Context) {
	defer close(st.done)
	backoff := st.hub.minBackoff
	for {
		got, err := st.follow(ctx)
		if ctx.Err() != nil {
			return
		}
		if terminal(err) {
			st.fail(err)
			return
		}
		if err != nil {
			slog.Debug("apps: log upstream", "org", st.key.org, "app", st.key.slug, "err", err)
		}
		if got {
			backoff = st.hub.minBackoff
		}
		t := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
		backoff = min(backoff*2, st.hub.maxBackoff)
	}
}

// follow reads one upstream connection until it ends. got reports whether any event arrived.
func (st *logStream) follow(ctx context.Context) (got bool, err error) {
	cli, err := st.hub.svc.client(ctx, st.key.org)
	if err != nil {
		return false, err
	}
	body, err := cli.StreamLogs(ctx, st.svcID, st.lastID())
	if err != nil {
		return false, err
	}
	defer body.Close()
	err = readSSE(body, func(id, event string, data []byte) {
		if event != "" && event != "log" {
			return
		}
		var l LogLine
		if json.Unmarshal(data, &l) != nil {
			return
		}
		b, err := json.Marshal(l)
		if err != nil {
			return
		}
		if id == "" {
			id = strconv.Itoa(l.Seq)
		}
		got = true
		st.publish(LogEvent{ID: id, Event: "log", Data: b})
	})
	return got, err
}

// terminal reports whether err means the app's logs are gone for good (deleted app, revoked access).
func terminal(err error) bool {
	var re *runtime.Error
	if !errors.As(err, &re) {
		return errors.Is(err, apperr.ErrNotFound)
	}
	return re.Status == http.StatusNotFound || re.Status == http.StatusForbidden
}

// fail sends a terminal error event to every subscriber and retires the upstream.
func (st *logStream) fail(err error) {
	code, msg := "internal", "log stream ended"
	var re *runtime.Error
	switch {
	case errors.As(err, &re) && re.Status == http.StatusNotFound, errors.Is(err, apperr.ErrNotFound):
		code, msg = "not_found", "app not found"
	case errors.As(err, &re) && re.Status == http.StatusForbidden:
		code, msg = "forbidden", "log access refused"
	}
	b, _ := json.Marshal(map[string]string{"code": code, "message": msg})
	st.publish(LogEvent{Event: "error", Data: b})
	h := st.hub
	h.mu.Lock()
	h.retireLocked(st)
	h.mu.Unlock()
}

// readSSE calls fn for every event in r until r ends. Comments and unknown fields are skipped.
func readSSE(r io.Reader, fn func(id, event string, data []byte)) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), logMaxLine)
	var id, event string
	var data []byte
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			if data != nil {
				fn(id, event, data)
			}
			id, event, data = "", "", nil
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, val, _ := strings.Cut(line, ":")
		val = strings.TrimPrefix(val, " ")
		switch field {
		case "id":
			id = val
		case "event":
			event = val
		case "data":
			if data != nil {
				data = append(data, '\n')
			}
			data = append(data, val...)
		}
	}
	if err := sc.Err(); err != nil {
		return fmt.Errorf("apps: read log stream: %w", err)
	}
	return nil
}
