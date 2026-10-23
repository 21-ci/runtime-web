package router

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

// CertStatus is one host entry of CertStatusReport.
type CertStatus struct {
	Status   string  `json:"status"` // pending | issued | error
	NotAfter *int64  `json:"not_after"`
	Error    *string `json:"error"`
}

// CertReporter posts custom-domain cert status to rtweb
// (POST /api/internal/router/cert-status) on certmagic events and every Interval.
type CertReporter struct {
	URL      string
	Secret   string
	Interval time.Duration // default 5m
	Table    *Table
	Client   *http.Client
	Logger   *slog.Logger
	// Lookup returns the expiry of an existing cert for host (cache or storage).
	Lookup func(ctx context.Context, host string) (time.Time, bool)

	mu    sync.Mutex
	state map[string]CertStatus
	kick  chan struct{}
	once  sync.Once
}

func (c *CertReporter) init() {
	c.once.Do(func() {
		c.state = map[string]CertStatus{}
		c.kick = make(chan struct{}, 1)
	})
}

// OnEvent is a certmagic Config.OnEvent hook.
func (c *CertReporter) OnEvent(_ context.Context, event string, data map[string]any) error {
	c.init()
	name, _ := data["identifier"].(string)
	h := normHost(name)
	if h == "" || !c.isCustom(h) {
		return nil
	}
	var st CertStatus
	switch event {
	case "cert_obtaining":
		st = CertStatus{Status: "pending"}
	case "cert_obtained":
		st = CertStatus{Status: "issued"}
	case "cert_failed":
		msg := "certificate issuance failed"
		if err, ok := data["error"].(error); ok && err != nil {
			msg = err.Error()
		}
		st = CertStatus{Status: "error", Error: &msg}
	default:
		return nil
	}
	c.mu.Lock()
	c.state[h] = st
	c.mu.Unlock()
	select {
	case c.kick <- struct{}{}:
	default:
	}
	return nil
}

func (c *CertReporter) isCustom(h string) bool {
	if c.Table == nil {
		return false
	}
	r := c.Table.Load()
	if r == nil {
		return false
	}
	_, ok := r.Hosts[h]
	return ok
}

// Snapshot builds the report for all active custom hosts.
func (c *CertReporter) Snapshot(ctx context.Context) map[string]CertStatus {
	c.init()
	out := map[string]CertStatus{}
	r := c.Table.Load()
	if r == nil {
		return out
	}
	c.mu.Lock()
	known := make(map[string]CertStatus, len(c.state))
	for k, v := range c.state {
		known[k] = v
	}
	c.mu.Unlock()
	for h := range r.Hosts {
		st, ok := known[h]
		if c.Lookup != nil && (!ok || st.Status == "issued") {
			if na, found := c.Lookup(ctx, h); found {
				ms := na.UnixMilli()
				out[h] = CertStatus{Status: "issued", NotAfter: &ms}
				continue
			}
		}
		if !ok {
			st = CertStatus{Status: "pending"}
		}
		out[h] = st
	}
	return out
}

// Report posts one snapshot.
func (c *CertReporter) Report(ctx context.Context) error {
	hosts := c.Snapshot(ctx)
	if len(hosts) == 0 {
		return nil
	}
	body, err := json.Marshal(map[string]any{"hosts": hosts})
	if err != nil {
		return fmt.Errorf("router: encode cert status: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.URL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("router: build cert status request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.Secret)
	req.Header.Set("Content-Type", "application/json")
	cl := c.Client
	if cl == nil {
		cl = &http.Client{Timeout: 10 * time.Second}
	}
	res, err := cl.Do(req)
	if err != nil {
		return fmt.Errorf("router: post cert status: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		return fmt.Errorf("router: post cert status: status %d", res.StatusCode)
	}
	return nil
}

// Run reports on every event and every Interval until ctx is done.
func (c *CertReporter) Run(ctx context.Context) {
	c.init()
	iv := c.Interval
	if iv <= 0 {
		iv = 5 * time.Minute
	}
	log := c.Logger
	if log == nil {
		log = slog.Default()
	}
	tick := time.NewTicker(iv)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		case <-c.kick:
		}
		if err := c.Report(ctx); err != nil && ctx.Err() == nil {
			log.Warn("cert status report failed", "err", err)
		}
	}
}
