package domains

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"net/http"
	"strings"
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
)

// Resolver looks up TXT records. *net.Resolver implements it.
type Resolver interface {
	LookupTXT(ctx context.Context, name string) ([]string, error)
}

// DevResolver answers TXT lookups from RTWEB_DEV_DNS_OVERRIDE (`name=value;…`, a name may repeat)
// and falls back to Next for other names.
type DevResolver struct {
	Overrides map[string][]string
	Next      Resolver
}

// LookupTXT returns the overridden values for name, or asks Next.
func (r DevResolver) LookupTXT(ctx context.Context, name string) ([]string, error) {
	if v, ok := r.Overrides[strings.ToLower(strings.TrimSuffix(name, "."))]; ok {
		return v, nil
	}
	return r.Next.LookupTXT(ctx, name)
}

// NewResolver returns the system resolver, wrapped in a DevResolver only when dev is set and
// RTWEB_DEV_DNS_OVERRIDE is non-empty. The override is never read outside dev mode.
func NewResolver(dev bool, getenv func(string) string) Resolver {
	if !dev {
		return net.DefaultResolver
	}
	raw := getenv("RTWEB_DEV_DNS_OVERRIDE")
	if raw == "" {
		return net.DefaultResolver
	}
	o := map[string][]string{}
	for _, pair := range strings.Split(raw, ";") {
		name, val, ok := strings.Cut(pair, "=")
		name = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(name), "."))
		if !ok || name == "" {
			continue
		}
		o[name] = append(o[name], strings.TrimSpace(val))
	}
	return DevResolver{Overrides: o, Next: net.DefaultResolver}
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

// activate marks d active (the unique index on active hosts decides races) and then maps the host on
// the runtime with the root token. A lost race or a runtime 409 leaves d failed with host_taken.
func (s *Service) activate(ctx context.Context, d db.Domain, actor audit.Actor) error {
	taken := fmt.Errorf("domains: activate %s: %w", d.Host, apperr.Conflict{Code: "host_taken"})
	err := s.st.Tx(ctx, func(q *db.Queries) error {
		_, err := q.ActivateDomain(ctx, db.ActivateDomainParams{At: s.nowMS(), ID: d.ID})
		return err
	})
	if isUnique(err) {
		s.setStatus(ctx, d, StatusFailed)
		return taken
	}
	if err != nil {
		return fmt.Errorf("domains: activate %s: %w", d.Host, err)
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
		s.setStatus(ctx, d, d.Status)
		return fmt.Errorf("domains: map %s: %w", d.Host, err)
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
	// Drop the route first so the host stops serving even if the runtime call fails.
	s.setStatus(ctx, d, StatusFailed)
	if err := s.unmap(ctx, d); err != nil {
		s.log.Error("domains: deactivate unmap", "host", d.Host, "err", err)
	}
	if err := s.audit.Log(ctx, s.st.Q(), audit.Actor{}, d.OrgID, "domain.deactivate", d.Host, map[string]any{"txt_misses": misses}); err != nil {
		s.log.Error("domains: audit deactivate", "host", d.Host, "err", err)
	}
	s.log.Info("domains: deactivated", "host", d.Host, "org", d.OrgID)
}

// reconcile re-PUTs active hosts that the runtime lost. Runtime hosts that are not active in the DB
// are left alone and logged.
func (s *Service) reconcile(ctx context.Context) {
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
		have := map[string]bool{}
		for _, h := range hosts {
			have[h.Host] = h.Status == StatusActive
		}
		want := map[string]bool{}
		for _, d := range ds {
			want[d.Host] = true
			if have[d.Host] {
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
