package runtimetest

import (
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/21cloud/runtime-web/internal/runtime"
)

// pendingTTL is how long a tenant's unverified host claim blocks others.
const pendingTTL = 7 * 24 * time.Hour

const (
	statusActive  = "active"
	statusPending = "pending_verification"
)

// hostEntry is a host mapped to a service. Operator claims are active at once;
// tenant claims stay pending with a verify token until their TTL lapses.
type hostEntry struct {
	host, svcID, status string
	token               string
	createdAt           int64
	expiresAt           time.Time // zero once active
}

// live reports whether the claim still holds the host at time now.
func (h *hostEntry) live(now time.Time) bool {
	return h.status == statusActive || now.Before(h.expiresAt)
}

func (h *hostEntry) view() runtime.Host {
	v := runtime.Host{Host: h.host, Status: h.status, CreatedAt: h.createdAt}
	if h.status == statusPending {
		tok := h.token
		v.VerifyToken = &tok
		ms := h.expiresAt.UnixMilli()
		v.ExpiresAt = &ms
	}
	return v
}

func normalizeHost(h string) string {
	return strings.ToLower(strings.TrimSuffix(h, "."))
}

func (f *Fake) hostRoutes(mux *http.ServeMux) {
	f.route(mux, "GET /v1/services/{s}/hosts", "services:read", f.listHosts)
	f.route(mux, "PUT /v1/services/{s}/hosts/{host}", "services:write", f.putHost)
	f.route(mux, "DELETE /v1/services/{s}/hosts/{host}", "services:write", f.deleteHost)
}

func (f *Fake) listHosts(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	now := time.Now()
	var hosts []string
	for name, h := range f.hosts {
		if h.svcID == s.id && h.live(now) {
			hosts = append(hosts, name)
		}
	}
	slices.Sort(hosts)
	items := []runtime.Host{}
	for _, name := range hosts {
		items = append(items, f.hosts[name].view())
	}
	writeJSON(w, http.StatusOK, items)
	return nil
}

func (f *Fake) putHost(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	host := normalizeHost(r.PathValue("host"))
	if host == "" {
		return invalid("host is required")
	}
	now := time.Now()
	cur := f.hosts[host]
	if cur != nil && cur.svcID != s.id && cur.live(now) {
		return conflict("host_taken", "host is already mapped")
	}
	h := &hostEntry{host: host, svcID: s.id, createdAt: nowMS()}
	if p.key == nil {
		h.status = statusActive
	} else {
		h.status = statusPending
		if cur != nil && cur.svcID == s.id && cur.status == statusPending && cur.live(now) {
			// A re-PUT of an own pending claim keeps its token and expiry.
			h.token, h.expiresAt, h.createdAt = cur.token, cur.expiresAt, cur.createdAt
		} else {
			h.token = randHex(16)
			h.expiresAt = now.Add(pendingTTL)
		}
	}
	f.hosts[host] = h
	writeJSON(w, http.StatusOK, h.view())
	return nil
}

func (f *Fake) deleteHost(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	host := normalizeHost(r.PathValue("host"))
	h := f.hosts[host]
	if h == nil || h.svcID != s.id || !h.live(time.Now()) {
		return notFound()
	}
	delete(f.hosts, host)
	w.WriteHeader(http.StatusNoContent)
	return nil
}
