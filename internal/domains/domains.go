// Package domains manages custom domains for apps: validation, DNS TXT verification, activation on
// the runtime with the root token, a background checker, and the route table served to rtrouter.
//
// Several orgs may hold a pending claim on the same host; the first to verify wins (the store keeps a
// unique index on active hosts only). A host is mapped on the runtime and routed only while active.
package domains

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/idna"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/apps"
	"github.com/21cloud/runtime-web/internal/audit"
	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/config"
	"github.com/21cloud/runtime-web/internal/runtime"
	"github.com/21cloud/runtime-web/internal/store"
	"github.com/21cloud/runtime-web/internal/store/db"
)

// Domain statuses.
const (
	StatusPending = "pending"
	StatusActive  = "active"
	StatusFailed  = "failed"
)

// txtPrefix is the label in front of a host that holds its verification token.
const txtPrefix = "_rtweb."

// maxHostLen is the longest DNS name accepted.
const maxHostLen = 253

// Domain is the API view of a custom domain.
type Domain struct {
	ID            string  `json:"id"`
	Host          string  `json:"host"`
	App           string  `json:"app"`
	Status        string  `json:"status"`
	TXTName       string  `json:"txt_name"`
	TXTValue      string  `json:"txt_value"`
	CNAMETarget   string  `json:"cname_target"`
	LastCheckedAt *int64  `json:"last_checked_at"`
	VerifiedAt    *int64  `json:"verified_at"`
	CertStatus    string  `json:"cert_status"`
	CertNotAfter  *int64  `json:"cert_not_after"`
	CertError     *string `json:"cert_error"`
	CreatedAt     int64   `json:"created_at"`
}

// RouteTable is what rtrouter polls: active custom hosts only.
type RouteTable struct {
	ConsoleHost string               `json:"console_host"`
	BaseDomain  string               `json:"base_domain"`
	Hosts       map[string]RouteHost `json:"hosts"`
}

// RouteHost is the target of one custom host.
type RouteHost struct {
	Slug string `json:"slug"`
}

// CertStatus is one host's certificate state as reported by rtrouter.
type CertStatus struct {
	Status   string  `json:"status"`
	NotAfter *int64  `json:"not_after"`
	Error    *string `json:"error"`
}

// Options configures a Service.
type Options struct {
	// BaseDomain is the apps wildcard domain; it and every name under it are rejected.
	BaseDomain string
	// ConsoleHost (RTWEB_PUBLIC_URL) and RuntimeHost (RUNTIME_PUBLIC_URL) are rejected.
	ConsoleHost string
	RuntimeHost string
	// CNAMETarget is the router host users point their records at.
	CNAMETarget string
	Resolver    Resolver
	// Now defaults to time.Now; Log to slog.Default.
	Now func() time.Time
	Log *slog.Logger
}

// OptionsFromConfig derives Options from cfg, with the resolver chosen by NewResolver.
func OptionsFromConfig(cfg config.Config, getenv func(string) string) Options {
	console := hostOf(cfg.PublicURL)
	return Options{
		BaseDomain:  strings.ToLower(strings.TrimSuffix(cfg.BaseDomain, ".")),
		ConsoleHost: console,
		RuntimeHost: hostOf(cfg.RuntimePublicURL),
		CNAMETarget: console,
		Resolver:    NewResolver(cfg.Dev, getenv),
	}
}

// hostOf returns the lowercase hostname of a URL, or "" when it does not parse.
func hostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Hostname())
}

// Service manages custom domains.
type Service struct {
	st    *store.Store
	rt    *runtime.Client
	root  runtime.RootCred
	apps  *apps.Service
	opt   Options
	audit audit.Writer
	log   *slog.Logger

	// beforeActivate is a test seam run after the runtime PUT and before the row becomes active.
	beforeActivate func()

	mu            sync.Mutex
	lastReconcile time.Time
}

// New returns a domains Service. root is the operator token; it is scoped to each org's tenant per call.
func New(st *store.Store, rt *runtime.Client, root runtime.RootCred, appsSvc *apps.Service, opt Options) *Service {
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.Log == nil {
		opt.Log = slog.Default()
	}
	if opt.Resolver == nil {
		opt.Resolver = net.DefaultResolver
	}
	return &Service{st: st, rt: rt, root: root, apps: appsSvc, opt: opt, audit: audit.Writer{Now: opt.Now}, log: opt.Log}
}

// Normalize validates host and returns its canonical form: lowercase, no trailing dot, punycode.
// IPs, wildcards, ports, names over 253 characters, single labels, BASE_DOMAIN and anything under
// it, and the console and runtime hosts are apperr.ErrInvalid.
func (s *Service) Normalize(host string) (string, error) {
	h := strings.TrimSpace(host)
	h = strings.TrimSuffix(h, ".")
	invalid := func(why string) (string, error) {
		return "", fmt.Errorf("domains: host %q: %s: %w", host, why, apperr.ErrInvalid)
	}
	if h == "" {
		return invalid("empty")
	}
	if strings.ContainsAny(h, ":*/[]@ \t") {
		return invalid("not a plain host name")
	}
	if net.ParseIP(h) != nil {
		return invalid("ip address")
	}
	a, err := idna.Lookup.ToASCII(h)
	if err != nil {
		return invalid("idna")
	}
	a = strings.ToLower(a)
	if len(a) > maxHostLen {
		return invalid("too long")
	}
	labels := strings.Split(a, ".")
	if len(labels) < 2 {
		return invalid("single label")
	}
	for _, l := range labels {
		if !validLabel(l) {
			return invalid("bad label")
		}
	}
	if allDigits(labels[len(labels)-1]) {
		return invalid("numeric tld")
	}
	if b := s.opt.BaseDomain; b != "" && (a == b || strings.HasSuffix(a, "."+b)) {
		return invalid("under BASE_DOMAIN")
	}
	if a == s.opt.ConsoleHost || a == s.opt.RuntimeHost {
		return invalid("reserved host")
	}
	return a, nil
}

func validLabel(l string) bool {
	if l == "" || len(l) > 63 || l[0] == '-' || l[len(l)-1] == '-' {
		return false
	}
	for i := 0; i < len(l); i++ {
		c := l[i]
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return true
}

func allDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return s != ""
}

// authorize checks a on project: invisible → ErrNotFound, visible but too low → ErrForbidden.
func authorize(sub authz.Subject, a authz.Action, project string) error {
	if authz.Can(sub, a, project) {
		return nil
	}
	if authz.Can(sub, authz.AppRead, project) {
		return fmt.Errorf("domains: %s on %s: %w", a, project, apperr.ErrForbidden)
	}
	return fmt.Errorf("domains: %s: %w", project, apperr.ErrNotFound)
}

// app resolves slug in orgID and checks a on its project.
func (s *Service) app(ctx context.Context, sub authz.Subject, orgID, slug string, a authz.Action) (apps.App, error) {
	if !authz.Can(sub, authz.OrgRead, "") {
		return apps.App{}, fmt.Errorf("domains: not a member: %w", apperr.ErrNotFound)
	}
	app, err := s.apps.Resolve(ctx, orgID, slug)
	if err != nil {
		return apps.App{}, err
	}
	if err := authorize(sub, a, app.ProjectSlug); err != nil {
		return apps.App{}, err
	}
	return app, nil
}

// domain loads id in orgID and checks a on its project. Another org's domain is ErrNotFound.
func (s *Service) domain(ctx context.Context, sub authz.Subject, orgID, id string, a authz.Action) (db.Domain, error) {
	if !authz.Can(sub, authz.OrgRead, "") {
		return db.Domain{}, fmt.Errorf("domains: not a member: %w", apperr.ErrNotFound)
	}
	d, err := s.st.Q().GetDomain(ctx, id)
	if errors.Is(err, sql.ErrNoRows) || err == nil && d.OrgID != orgID {
		return db.Domain{}, fmt.Errorf("domains: domain %s: %w", id, apperr.ErrNotFound)
	}
	if err != nil {
		return db.Domain{}, fmt.Errorf("domains: get %s: %w", id, err)
	}
	if err := authorize(sub, a, d.ProjectSlug); err != nil {
		return db.Domain{}, err
	}
	return d, nil
}

// List returns the app's domains.
func (s *Service) List(ctx context.Context, sub authz.Subject, orgID, slug string) ([]Domain, error) {
	app, err := s.app(ctx, sub, orgID, slug, authz.AppRead)
	if err != nil {
		return nil, err
	}
	rows, err := s.st.Q().ListDomainsByService(ctx, db.ListDomainsByServiceParams{OrgID: orgID, ServiceID: app.SvcID})
	if err != nil {
		return nil, fmt.Errorf("domains: list: %w", err)
	}
	out := make([]Domain, 0, len(rows))
	for _, r := range rows {
		out = append(out, s.view(r))
	}
	return out, nil
}

// Add claims host for the app as pending. A host already active anywhere is Conflict{host_taken}.
func (s *Service) Add(ctx context.Context, sub authz.Subject, orgID, slug, host string) (Domain, error) {
	app, err := s.app(ctx, sub, orgID, slug, authz.DomainsManage)
	if err != nil {
		return Domain{}, err
	}
	h, err := s.Normalize(host)
	if err != nil {
		return Domain{}, err
	}
	q := s.st.Q()
	if _, err := q.ActiveDomainByHost(ctx, h); err == nil {
		return Domain{}, fmt.Errorf("domains: add %s: %w", h, apperr.Conflict{Code: "host_taken"})
	} else if !errors.Is(err, sql.ErrNoRows) {
		return Domain{}, fmt.Errorf("domains: add %s: %w", h, err)
	}
	tok, err := newToken()
	if err != nil {
		return Domain{}, err
	}
	p := db.CreateDomainParams{
		ID: store.NewID("dom_"), OrgID: orgID, ProjectSlug: app.ProjectSlug, ServiceID: app.SvcID, AppSlug: app.Slug,
		Host: h, Token: tok, Status: StatusPending, CreatedAt: s.opt.Now().UnixMilli(),
	}
	err = s.st.Tx(ctx, func(q *db.Queries) error {
		if err := q.CreateDomain(ctx, p); err != nil {
			return err
		}
		return s.audit.Log(ctx, q, audit.Actor{UserID: sub.UserID, AsInstanceAdmin: sub.InstanceAdmin}, orgID, "domain.add", h, map[string]string{"app": app.Slug})
	})
	if isUnique(err) {
		return Domain{}, fmt.Errorf("domains: add %s: %w", h, apperr.Conflict{Code: "host_taken", Message: "This org already has the domain."})
	}
	if err != nil {
		return Domain{}, fmt.Errorf("domains: add %s: %w", h, err)
	}
	d, err := q.GetDomain(ctx, p.ID)
	if err != nil {
		return Domain{}, fmt.Errorf("domains: add %s: %w", h, err)
	}
	return s.view(d), nil
}

// Remove unmaps an active domain on the runtime, then deletes the row.
func (s *Service) Remove(ctx context.Context, sub authz.Subject, orgID, id string) error {
	d, err := s.domain(ctx, sub, orgID, id, authz.DomainsManage)
	if err != nil {
		return err
	}
	// The row (and so the route) goes first, together with a pending_unmaps marker for an active
	// host; the runtime DELETE follows and, if it fails, the checker retries it.
	var m *db.PendingUnmap
	err = s.st.Tx(ctx, func(q *db.Queries) error {
		if _, err := q.DeleteDomain(ctx, d.ID); err != nil {
			return fmt.Errorf("domains: delete %s: %w", d.Host, err)
		}
		if d.Status == StatusActive {
			if m, err = s.markUnmap(ctx, q, d); err != nil {
				return err
			}
		}
		return s.audit.Log(ctx, q, audit.Actor{UserID: sub.UserID, AsInstanceAdmin: sub.InstanceAdmin}, orgID, "domain.remove", d.Host, nil)
	})
	if err != nil {
		return err
	}
	if m != nil {
		s.unmap(ctx, *m)
	}
	return nil
}

// markUnmap records that d's runtime mapping must be deleted.
func (s *Service) markUnmap(ctx context.Context, q *db.Queries, d db.Domain) (*db.PendingUnmap, error) {
	m := db.PendingUnmap{ID: store.NewID("unm_"), OrgID: d.OrgID, ServiceID: d.ServiceID, Host: d.Host, CreatedAt: s.opt.Now().UnixMilli()}
	err := q.CreatePendingUnmap(ctx, db.CreatePendingUnmapParams{ID: m.ID, OrgID: m.OrgID, ServiceID: m.ServiceID, Host: m.Host, CreatedAt: m.CreatedAt})
	if err != nil {
		return nil, fmt.Errorf("domains: mark unmap %s: %w", d.Host, err)
	}
	return &m, nil
}

// Routes returns the route table (active domains only) and its ETag.
func (s *Service) Routes(ctx context.Context) (RouteTable, string, error) {
	rows, err := s.st.Q().ListActiveRoutes(ctx)
	if err != nil {
		return RouteTable{}, "", fmt.Errorf("domains: routes: %w", err)
	}
	t := RouteTable{ConsoleHost: s.opt.ConsoleHost, BaseDomain: s.opt.BaseDomain, Hosts: make(map[string]RouteHost, len(rows))}
	for _, r := range rows {
		t.Hosts[r.Host] = RouteHost{Slug: r.AppSlug}
	}
	b, err := json.Marshal(t) // map keys are sorted, so equal tables hash equally
	if err != nil {
		return RouteTable{}, "", fmt.Errorf("domains: routes: %w", err)
	}
	sum := sha256.Sum256(b)
	return t, `"` + hex.EncodeToString(sum[:16]) + `"`, nil
}

// certStatuses are the statuses rtrouter may report.
var certStatuses = map[string]bool{"pending": true, "issued": true, "error": true}

// SetCertStatus stores rtrouter's certificate report. Hosts that are not active and unknown
// statuses are ignored.
func (s *Service) SetCertStatus(ctx context.Context, report map[string]CertStatus) error {
	q := s.st.Q()
	for host, c := range report {
		if !certStatuses[c.Status] {
			continue
		}
		p := db.SetDomainCertParams{CertStatus: c.Status, Host: strings.ToLower(host)}
		if c.NotAfter != nil {
			p.CertNotAfter = sql.NullInt64{Int64: *c.NotAfter, Valid: true}
		}
		if c.Error != nil {
			p.CertError = sql.NullString{String: *c.Error, Valid: true}
		}
		if _, err := q.SetDomainCert(ctx, p); err != nil {
			return fmt.Errorf("domains: cert status %s: %w", host, err)
		}
	}
	return nil
}

func (s *Service) view(d db.Domain) Domain {
	v := Domain{
		ID: d.ID, Host: d.Host, App: d.AppSlug, Status: d.Status, TXTName: txtPrefix + d.Host, TXTValue: d.Token,
		CNAMETarget: s.opt.CNAMETarget, CertStatus: d.CertStatus, CreatedAt: d.CreatedAt,
	}
	if d.LastCheckedAt.Valid {
		v.LastCheckedAt = &d.LastCheckedAt.Int64
	}
	if d.VerifiedAt.Valid {
		v.VerifiedAt = &d.VerifiedAt.Int64
	}
	if d.CertNotAfter.Valid {
		v.CertNotAfter = &d.CertNotAfter.Int64
	}
	if d.CertError.Valid {
		v.CertError = &d.CertError.String
	}
	return v
}

// rootFor returns a runtime client acting as the operator on orgID's tenant.
func (s *Service) rootFor(ctx context.Context, orgID string) (*runtime.Scoped, error) {
	org, err := s.st.Q().GetOrgByID(ctx, orgID)
	if err != nil {
		return nil, fmt.Errorf("domains: org %s: %w", orgID, err)
	}
	return s.rt.With(runtime.RootCred{Token: s.root.Token, Tenant: org.TenantID}), nil
}

// unmap deletes m's host on the runtime (an already missing host is fine) and then clears the
// marker. On failure the marker stays for reconcile to retry. It reports whether it succeeded.
func (s *Service) unmap(ctx context.Context, m db.PendingUnmap) bool {
	if a, err := s.st.Q().ActiveDomainByHost(ctx, m.Host); err == nil && a.ServiceID == m.ServiceID {
		// The host was re-verified for the same app since; its mapping is wanted again.
		s.clearUnmap(ctx, m)
		return true
	}
	cli, err := s.rootFor(ctx, m.OrgID)
	if errors.Is(err, sql.ErrNoRows) {
		// The org (and its tenant) is gone; nothing left to unmap.
		s.clearUnmap(ctx, m)
		return true
	}
	if err == nil {
		err = cli.DeleteHost(ctx, m.ServiceID, m.Host)
		if runtimeStatus(err) == http.StatusNotFound {
			err = nil
		}
	}
	if err != nil {
		s.log.Warn("domains: unmap failed, will retry", "host", m.Host, "service", m.ServiceID, "err", err)
		return false
	}
	s.clearUnmap(ctx, m)
	return true
}

func (s *Service) clearUnmap(ctx context.Context, m db.PendingUnmap) {
	if err := s.st.Q().DeletePendingUnmap(ctx, m.ID); err != nil {
		s.log.Error("domains: clear unmap", "host", m.Host, "err", err)
	}
}

func runtimeStatus(err error) int {
	var re *runtime.Error
	if errors.As(err, &re) {
		return re.Status
	}
	return 0
}

func isUnique(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}

// newToken returns 32 random hex characters.
func newToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("domains: token: %w", err)
	}
	return hex.EncodeToString(b), nil
}
