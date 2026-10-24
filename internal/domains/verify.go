package domains

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/audit"
	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/store/db"
)

// Checker timing.
const (
	pendingEvery   = 60 * time.Second
	pendingTTL     = 24 * time.Hour
	activeEvery    = 6 * time.Hour
	maxTXTMisses   = 3
	reconcileEvery = 5 * time.Minute
	lookupTimeout  = 5 * time.Second

	// runtimePending is the runtime status of an unverified tenant host claim.
	runtimePending = "pending_verification"
)

// Resolver looks up TXT records. *net.Resolver implements it.
type Resolver interface {
	LookupTXT(ctx context.Context, name string) ([]string, error)
}

// DevResolver answers TXT lookups from dev overrides (seeded from RTWEB_DEV_DNS_OVERRIDE,
// `name=value;…`, a name may repeat; changed at runtime with Set) and falls back to Next.
// It exists only in dev mode.
type DevResolver struct {
	mu        sync.RWMutex
	overrides map[string][]string
	Next      Resolver
}

// NewDevResolver returns a DevResolver over overrides that falls back to the system resolver.
func NewDevResolver(overrides map[string][]string) *DevResolver {
	o := map[string][]string{}
	for k, v := range overrides {
		o[devName(k)] = v
	}
	return &DevResolver{overrides: o, Next: net.DefaultResolver}
}

func devName(name string) string {
	return strings.ToLower(strings.TrimSuffix(strings.TrimSpace(name), "."))
}

// Set replaces the values for name; empty values remove the override.
func (r *DevResolver) Set(name string, values []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(values) == 0 {
		delete(r.overrides, devName(name))
		return
	}
	r.overrides[devName(name)] = append([]string(nil), values...)
}

// LookupTXT returns the overridden values for name, or asks Next.
func (r *DevResolver) LookupTXT(ctx context.Context, name string) ([]string, error) {
	r.mu.RLock()
	v, ok := r.overrides[devName(name)]
	r.mu.RUnlock()
	if ok {
		return v, nil
	}
	return r.Next.LookupTXT(ctx, name)
}

// NewResolver returns the system resolver, or a *DevResolver when dev is set (seeded from
// RTWEB_DEV_DNS_OVERRIDE). Overrides are never honoured outside dev mode.
func NewResolver(dev bool, getenv func(string) string) Resolver {
	if !dev {
		return net.DefaultResolver
	}
	o := map[string][]string{}
	for _, pair := range strings.Split(getenv("RTWEB_DEV_DNS_OVERRIDE"), ";") {
		name, val, ok := strings.Cut(pair, "=")
		name = devName(name)
		if !ok || name == "" {
			continue
		}
		o[name] = append(o[name], strings.TrimSpace(val))
	}
	return NewDevResolver(o)
}

// txtMatches reports whether the TXT record at _rtweb.<host> holds token. Lookup errors count as a miss.
func (s *Service) txtMatches(ctx context.Context, d db.Domain) bool {
	ctx, cancel := context.WithTimeout(ctx, lookupTimeout)
	defer cancel()
	vals, err := s.opt.Resolver.LookupTXT(ctx, txtPrefix+d.Host)
	if err != nil {
		s.log.Debug("domains: txt lookup", "host", d.Host, "err", err)
		return false
	}
	for _, v := range vals {
		if strings.TrimSpace(v) == d.Token {
			return true
		}
	}
	return false
}

// Verify checks the TXT record now. On a match the domain becomes active (first org to verify wins;
// a loser is failed with Conflict{host_taken}); otherwise it stays as it was, with last_checked_at set.
func (s *Service) Verify(ctx context.Context, sub authz.Subject, orgID, id string) (Domain, error) {
	d, err := s.domain(ctx, sub, orgID, id, authz.DomainsManage)
	if err != nil {
		return Domain{}, err
	}
	if d.Status != StatusActive {
		actor := audit.Actor{UserID: sub.UserID, AsInstanceAdmin: sub.InstanceAdmin}
		if s.txtMatches(ctx, d) {
			if err := s.activate(ctx, d, actor); err != nil {
				return Domain{}, err
			}
		} else if err := s.markChecked(ctx, d, d.TxtMisses); err != nil {
			return Domain{}, err
		}
	}
	d, err = s.st.Q().GetDomain(ctx, id)
	if err != nil {
		return Domain{}, fmt.Errorf("domains: get %s: %w", id, err)
	}
	return s.view(d), nil
}

func (s *Service) markChecked(ctx context.Context, d db.Domain, misses int64) error {
	err := s.st.Q().SetDomainCheck(ctx, db.SetDomainCheckParams{At: s.nowMS(), TxtMisses: misses, ID: d.ID})
	if err != nil {
		return fmt.Errorf("domains: check %s: %w", d.Host, err)
	}
	return nil
}

func (s *Service) nowMS() sql.NullInt64 {
	return sql.NullInt64{Int64: s.opt.Now().UnixMilli(), Valid: true}
}

// activate maps the host on the runtime with the root token and only then marks d active, so
// Routes never serves a host the runtime does not route. A host already active elsewhere, a runtime
// 409, or a lost race on the unique index of active hosts leaves d failed with host_taken; after a
// lost race the mapping just made is undone.
func (s *Service) activate(ctx context.Context, d db.Domain, actor audit.Actor) error {
	taken := fmt.Errorf("domains: activate %s: %w", d.Host, apperr.Conflict{Code: "host_taken"})
	if other, err := s.st.Q().ActiveDomainByHost(ctx, d.Host); err == nil && other.ID != d.ID {
		s.setStatus(ctx, d, StatusFailed)
		return taken
	}
	cli, err := s.rootFor(ctx, d.OrgID)
	if err == nil {
		_, err = cli.PutHost(ctx, d.ServiceID, d.Host)
	}
	if err != nil {
		if runtimeStatus(err) == http.StatusConflict {
			s.setStatus(ctx, d, StatusFailed)
			return taken
		}
		return fmt.Errorf("domains: map %s: %w", d.Host, err)
	}
	if s.beforeActivate != nil {
		s.beforeActivate()
	}
	var m *db.PendingUnmap
	err = s.st.Tx(ctx, func(q *db.Queries) error {
		_, err := q.ActivateDomain(ctx, db.ActivateDomainParams{At: s.nowMS(), ID: d.ID})
		if err == nil {
			return nil
		}
		if isUnique(err) {
			if _, uerr := q.UpdateDomainStatus(ctx, db.UpdateDomainStatusParams{Status: StatusFailed, ID: d.ID}); uerr != nil {
				return uerr
			}
		}
		var merr error
		if m, merr = s.markUnmap(ctx, q, d); merr != nil {
			return merr
		}
		return err
	})
	if err != nil {
		if m != nil {
			s.unmap(ctx, *m)
		}
		if isUnique(err) {
			return taken
		}
		return fmt.Errorf("domains: activate %s: %w", d.Host, err)
	}
	if err := s.audit.Log(ctx, s.st.Q(), actor, d.OrgID, "domain.verify", d.Host, map[string]string{"app": d.AppSlug}); err != nil {
		s.log.Error("domains: audit verify", "host", d.Host, "err", err)
	}
	return nil
}

// setStatus is a best-effort status write used on failure paths.
func (s *Service) setStatus(ctx context.Context, d db.Domain, status string) {
	if _, err := s.st.Q().UpdateDomainStatus(ctx, db.UpdateDomainStatusParams{Status: status, ID: d.ID}); err != nil {
		s.log.Error("domains: set status", "host", d.Host, "status", status, "err", err)
	}
}

// RunChecker runs CheckOnce every 60 s until ctx ends.
func (s *Service) RunChecker(ctx context.Context) {
	t := time.NewTicker(pendingEvery)
	defer t.Stop()
	for {
		s.CheckOnce(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// CheckOnce is one checker pass: pending domains are re-verified (failed after 24 h), active ones
// are re-checked every 6 h and deactivated after 3 consecutive TXT misses, and active hosts are
// reconciled with the runtime at most every 5 minutes. Errors are logged.
func (s *Service) CheckOnce(ctx context.Context) {
	q := s.st.Q()
	now := s.opt.Now()
	pending, err := q.ListDomainsByStatus(ctx, StatusPending)
	if err != nil {
		s.log.Error("domains: list pending", "err", err)
	}
	for _, d := range pending {
		s.checkPending(ctx, d, now)
	}
	active, err := q.ListDomainsByStatus(ctx, StatusActive)
	if err != nil {
		s.log.Error("domains: list active", "err", err)
		return
	}
	for _, d := range active {
		s.checkActive(ctx, d, now)
	}
	s.mu.Lock()
	due := s.lastReconcile.IsZero() || now.Sub(s.lastReconcile) >= reconcileEvery
	if due {
		s.lastReconcile = now
	}
	s.mu.Unlock()
	if due {
		s.reconcile(ctx)
	}
}

func since(now time.Time, ms sql.NullInt64) time.Duration {
	if !ms.Valid {
		return time.Duration(1<<63 - 1)
	}
	return now.Sub(time.UnixMilli(ms.Int64))
}

func (s *Service) checkPending(ctx context.Context, d db.Domain, now time.Time) {
	sys := audit.Actor{}
	if now.Sub(time.UnixMilli(d.CreatedAt)) >= pendingTTL {
		s.setStatus(ctx, d, StatusFailed)
		if err := s.audit.Log(ctx, s.st.Q(), sys, d.OrgID, "domain.expire", d.Host, nil); err != nil {
			s.log.Error("domains: audit expire", "host", d.Host, "err", err)
		}
		return
	}
	if since(now, d.LastCheckedAt) < pendingEvery {
		return
	}
	if s.txtMatches(ctx, d) {
		if err := s.activate(ctx, d, sys); err != nil {
			s.log.Warn("domains: activate", "host", d.Host, "err", err)
		}
		return
	}
	if err := s.markChecked(ctx, d, 0); err != nil {
		s.log.Error("domains: mark checked", "err", err)
	}
}

func (s *Service) checkActive(ctx context.Context, d db.Domain, now time.Time) {
	if since(now, d.LastCheckedAt) < activeEvery {
		return
	}
	if s.txtMatches(ctx, d) {
		if err := s.markChecked(ctx, d, 0); err != nil {
			s.log.Error("domains: mark checked", "err", err)
		}
		return
	}
	misses := d.TxtMisses + 1
	if err := s.markChecked(ctx, d, misses); err != nil {
		s.log.Error("domains: mark checked", "err", err)
		return
	}
	if misses < maxTXTMisses {
		return
	}
	// Drop the route and record the pending runtime DELETE in one tx; reconcile retries a failed DELETE.
	var m *db.PendingUnmap
	err := s.st.Tx(ctx, func(q *db.Queries) error {
		if _, err := q.UpdateDomainStatus(ctx, db.UpdateDomainStatusParams{Status: StatusFailed, ID: d.ID}); err != nil {
			return err
		}
		var err error
		m, err = s.markUnmap(ctx, q, d)
		return err
	})
	if err != nil {
		s.log.Error("domains: deactivate", "host", d.Host, "err", err)
		return
	}
	s.unmap(ctx, *m)
	if err := s.audit.Log(ctx, s.st.Q(), audit.Actor{}, d.OrgID, "domain.deactivate", d.Host, map[string]any{"txt_misses": misses}); err != nil {
		s.log.Error("domains: audit deactivate", "host", d.Host, "err", err)
	}
	s.log.Info("domains: deactivated", "host", d.Host, "org", d.OrgID)
}

// reconcile first retries pending runtime DELETEs (pending_unmaps), then re-PUTs active hosts the
// runtime lost. An active DB host is re-PUT only when the runtime lacks it or holds it as
// pending_verification (a root PUT makes it active); any other runtime status is logged and left
// alone so an unknown state cannot cause a PUT loop. Runtime hosts not active in the DB are logged.
func (s *Service) reconcile(ctx context.Context) {
	unmaps, err := s.st.Q().ListPendingUnmaps(ctx)
	if err != nil {
		s.log.Error("domains: list pending unmaps", "err", err)
	}
	for _, m := range unmaps {
		s.unmap(ctx, m)
	}
	active, err := s.st.Q().ListDomainsByStatus(ctx, StatusActive)
	if err != nil {
		s.log.Error("domains: reconcile list", "err", err)
		return
	}
	type svcKey struct{ org, svc string }
	bySvc := map[svcKey][]db.Domain{}
	for _, d := range active {
		k := svcKey{d.OrgID, d.ServiceID}
		bySvc[k] = append(bySvc[k], d)
	}
	for k, ds := range bySvc {
		cli, err := s.rootFor(ctx, k.org)
		if err != nil {
			s.log.Error("domains: reconcile", "err", err)
			continue
		}
		hosts, err := cli.ListHosts(ctx, k.svc)
		if err != nil {
			s.log.Warn("domains: reconcile list hosts", "service", k.svc, "err", err)
			continue
		}
		have := map[string]string{}
		for _, h := range hosts {
			have[h.Host] = h.Status
		}
		want := map[string]bool{}
		for _, d := range ds {
			want[d.Host] = true
			st, ok := have[d.Host]
			if st == StatusActive {
				continue
			}
			if ok && st != runtimePending {
				s.log.Warn("domains: runtime host in unexpected state", "host", d.Host, "status", st)
				continue
			}
			if _, err := cli.PutHost(ctx, d.ServiceID, d.Host); err != nil {
				s.log.Warn("domains: reconcile put host", "host", d.Host, "err", err)
				continue
			}
			s.log.Info("domains: reconcile restored host", "host", d.Host, "service", d.ServiceID)
		}
		for h := range have {
			if !want[h] {
				s.log.Info("domains: runtime host not active in web", "host", h, "service", k.svc)
			}
		}
	}
}
