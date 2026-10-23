package router

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"
)

// Routes mirrors the RouteTable JSON served by GET /api/internal/router/routes.
type Routes struct {
	ConsoleHost string               `json:"console_host"`
	BaseDomain  string               `json:"base_domain"`
	Hosts       map[string]HostRoute `json:"hosts"`
}

// HostRoute is one active custom domain.
type HostRoute struct {
	Slug string `json:"slug"`
}

// Table is an atomic snapshot of the current Routes.
type Table struct{ p atomic.Pointer[Routes] }

// Load returns the current snapshot (nil before the first successful poll).
func (t *Table) Load() *Routes { return t.p.Load() }

// Store replaces the snapshot.
func (t *Table) Store(r *Routes) { t.p.Store(r) }

// Poller fetches the route table from rtweb with ETag revalidation.
// On any error the last good table is kept.
type Poller struct {
	URL      string
	Secret   string
	Interval time.Duration // default 5s
	Table    *Table
	Client   *http.Client
	Logger   *slog.Logger

	etag string
}

// Poll performs one fetch.
func (p *Poller) Poll(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.URL, nil)
	if err != nil {
		return fmt.Errorf("router: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+p.Secret)
	if p.etag != "" {
		req.Header.Set("If-None-Match", p.etag)
	}
	c := p.Client
	if c == nil {
		c = &http.Client{Timeout: 10 * time.Second}
	}
	res, err := c.Do(req)
	if err != nil {
		return fmt.Errorf("router: fetch routes: %w", err)
	}
	defer res.Body.Close()
	switch res.StatusCode {
	case http.StatusNotModified:
		return nil
	case http.StatusOK:
	default:
		return fmt.Errorf("router: fetch routes: status %d", res.StatusCode)
	}
	var r Routes
	if err := json.NewDecoder(res.Body).Decode(&r); err != nil {
		return fmt.Errorf("router: decode routes: %w", err)
	}
	if r.Hosts == nil {
		r.Hosts = map[string]HostRoute{}
	}
	p.Table.Store(&r)
	p.etag = res.Header.Get("ETag")
	return nil
}

// Run polls immediately and then every Interval until ctx is done.
func (p *Poller) Run(ctx context.Context) {
	iv := p.Interval
	if iv <= 0 {
		iv = 5 * time.Second
	}
	log := p.Logger
	if log == nil {
		log = slog.Default()
	}
	tk := time.NewTicker(iv)
	defer tk.Stop()
	for {
		if err := p.Poll(ctx); err != nil && ctx.Err() == nil {
			log.Warn("route poll failed; keeping last table", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-tk.C:
		}
	}
}
