// Package admin holds the operator views: node status and config, scheduler and cache views, drain,
// runtime version, per-org usage and the instance-wide domain list. Runtime calls use the operator root
// credential. Every mutation is audited.
package admin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/audit"
	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/orgs"
	"github.com/21cloud/runtime-web/internal/runtime"
	"github.com/21cloud/runtime-web/internal/store"
	"github.com/21cloud/runtime-web/internal/store/db"
)

// RateLimit is the raw rate_limit object the runtime node config accepts. It is pending_restart.
type RateLimit = json.RawMessage

// NodeConfigPatch is the only set of node config fields the console writes. Nil fields are unchanged.
type NodeConfigPatch struct {
	DegradationMode *string
	DefaultProfile  *string
	RateLimit       *RateLimit
}

// DomainView is one custom domain with the org that owns it.
type DomainView struct {
	ID            string
	Host          string
	ProjectSlug   string
	ServiceID     string
	Status        string
	LastCheckedAt *int64
	CreatedAt     int64
	Org           OrgRef
}

// OrgRef identifies the org that owns a domain.
type OrgRef struct {
	Slug string
	Name string
}

// Service serves the instance admin operator views.
type Service struct {
	st   *store.Store
	rt   *runtime.Client
	root runtime.RootCred
	orgs *orgs.Service
	log  audit.Writer
}

// New returns an admin Service.
func New(st *store.Store, rt *runtime.Client, root runtime.RootCred, orgs *orgs.Service) *Service {
	return &Service{st: st, rt: rt, root: root, orgs: orgs, log: audit.Writer{Now: time.Now}}
}

// nodeConfigWire is the wire form of a node config patch. Unknown fields are rejected by
// DecodeNodeConfigPatch.
type nodeConfigWire struct {
	DegradationMode *string         `json:"degradation_mode"`
	DefaultProfile  *string         `json:"default_profile"`
	RateLimit       json.RawMessage `json:"rate_limit"`
}

// DecodeNodeConfigPatch parses a node config body. Only degradation_mode, default_profile and
// rate_limit are accepted; any other field, or an empty patch, is apperr.ErrInvalid.
func DecodeNodeConfigPatch(r io.Reader) (NodeConfigPatch, error) {
	dec := json.NewDecoder(r)
	dec.DisallowUnknownFields()
	var w nodeConfigWire
	if err := dec.Decode(&w); err != nil {
		return NodeConfigPatch{}, fmt.Errorf("admin: node config: %w: %v", apperr.ErrInvalid, err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return NodeConfigPatch{}, fmt.Errorf("admin: node config: trailing data: %w", apperr.ErrInvalid)
	}
	p := NodeConfigPatch{DegradationMode: w.DegradationMode, DefaultProfile: w.DefaultProfile}
	if rl := bytes.TrimSpace(w.RateLimit); len(rl) > 0 && !bytes.Equal(rl, []byte("null")) {
		rl := RateLimit(w.RateLimit)
		p.RateLimit = &rl
	}
	if p.DegradationMode == nil && p.DefaultProfile == nil && p.RateLimit == nil {
		return NodeConfigPatch{}, fmt.Errorf("admin: node config: no fields: %w", apperr.ErrInvalid)
	}
	return p, nil
}

// requireInstanceAdmin rejects every caller who is not an instance admin.
func requireInstanceAdmin(sub authz.Subject) error {
	if !authz.Can(sub, authz.InstanceAdmin, "") {
		return fmt.Errorf("admin: %w", apperr.ErrForbidden)
	}
	return nil
}

// NodeStatus returns the runtime node status.
func (s *Service) NodeStatus(ctx context.Context, sub authz.Subject) (runtime.NodeStatus, error) {
	if err := requireInstanceAdmin(sub); err != nil {
		return runtime.NodeStatus{}, err
	}
	out, err := s.rt.With(s.root).NodeStatus(ctx)
	if err != nil {
		return runtime.NodeStatus{}, fmt.Errorf("admin: node status: %w", err)
	}
	return out, nil
}

// NodeConfig returns the runtime node config object.
func (s *Service) NodeConfig(ctx context.Context, sub authz.Subject) (json.RawMessage, error) {
	if err := requireInstanceAdmin(sub); err != nil {
		return nil, err
	}
	out, err := s.rt.With(s.root).NodeConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("admin: node config: %w", err)
	}
	return out, nil
}

// SetNodeConfig applies patch to the runtime node config. It writes a pending audit row before the
// runtime call and an applied or failed row after it. A failed intent write aborts before the runtime
// is touched. A failed outcome write is logged at ERROR and the runtime result is still returned.
// An empty patch is apperr.ErrInvalid.
func (s *Service) SetNodeConfig(ctx context.Context, sub authz.Subject, p NodeConfigPatch) (runtime.NodeConfigApplied, error) {
	if err := requireInstanceAdmin(sub); err != nil {
		return runtime.NodeConfigApplied{}, err
	}
	if p.DegradationMode == nil && p.DefaultProfile == nil && p.RateLimit == nil {
		return runtime.NodeConfigApplied{}, fmt.Errorf("admin: set node config: no fields: %w", apperr.ErrInvalid)
	}
	detail := map[string]any{}
	if p.DegradationMode != nil {
		detail["degradation_mode"] = *p.DegradationMode
	}
	if p.DefaultProfile != nil {
		detail["default_profile"] = *p.DefaultProfile
	}
	if p.RateLimit != nil {
		detail["rate_limit"] = true
	}
	if err := s.intent(ctx, sub, actNodeConfig, detail); err != nil {
		return runtime.NodeConfigApplied{}, err
	}
	in := runtime.NodeConfigUpdate{DegradationMode: p.DegradationMode, DefaultProfile: p.DefaultProfile}
	if p.RateLimit != nil {
		in.RateLimit = *p.RateLimit
	}
	out, err := s.rt.With(s.root).PutNodeConfig(ctx, in)
	if err != nil {
		s.outcome(ctx, sub, actNodeConfig, detail, "failed", failCode(err))
		return runtime.NodeConfigApplied{}, fmt.Errorf("admin: set node config: %w", err)
	}
	detail["applied"] = out.Applied
	detail["pending_restart"] = out.PendingRestart
	s.outcome(ctx, sub, actNodeConfig, detail, "applied", "")
	return out, nil
}

// Scheduler returns the runtime scheduler view.
func (s *Service) Scheduler(ctx context.Context, sub authz.Subject) (json.RawMessage, error) {
	if err := requireInstanceAdmin(sub); err != nil {
		return nil, err
	}
	out, err := s.rt.With(s.root).NodeScheduler(ctx)
	if err != nil {
		return nil, fmt.Errorf("admin: scheduler: %w", err)
	}
	return out, nil
}

// Cache returns the runtime cache view.
func (s *Service) Cache(ctx context.Context, sub authz.Subject) (json.RawMessage, error) {
	if err := requireInstanceAdmin(sub); err != nil {
		return nil, err
	}
	out, err := s.rt.With(s.root).NodeCache(ctx)
	if err != nil {
		return nil, fmt.Errorf("admin: cache: %w", err)
	}
	return out, nil
}

// Drain asks the runtime node to drain. It is audited with an intent row before and an outcome row
// after the call, as SetNodeConfig is. The caller must already have confirmed it (the API requires
// body {confirm: "drain"}).
func (s *Service) Drain(ctx context.Context, sub authz.Subject) error {
	if err := requireInstanceAdmin(sub); err != nil {
		return err
	}
	if err := s.intent(ctx, sub, actDrain, nil); err != nil {
		return err
	}
	if err := s.rt.With(s.root).DrainNode(ctx); err != nil {
		s.outcome(ctx, sub, actDrain, nil, "failed", failCode(err))
		return fmt.Errorf("admin: drain: %w", err)
	}
	s.outcome(ctx, sub, actDrain, nil, "applied", "")
	return nil
}

// Version returns the runtime version.
func (s *Service) Version(ctx context.Context, sub authz.Subject) (runtime.VersionInfo, error) {
	if err := requireInstanceAdmin(sub); err != nil {
		return runtime.VersionInfo{}, err
	}
	out, err := s.rt.With(s.root).RuntimeVersion(ctx)
	if err != nil {
		return runtime.VersionInfo{}, fmt.Errorf("admin: version: %w", err)
	}
	return out, nil
}

// OrgUsage returns the runtime usage rows of orgID's tenant. Instance admins may read any org; org
// owners and admins may read their own org (org.usage.read). A non-member gets apperr.ErrNotFound and
// a member without the right role gets apperr.ErrForbidden. Instance-admin reads are audited.
func (s *Service) OrgUsage(ctx context.Context, sub authz.Subject, orgID string) ([]runtime.Usage, error) {
	org, err := s.orgs.Get(ctx, orgID)
	if err != nil {
		return nil, fmt.Errorf("admin: org usage: %w", err)
	}
	// Re-resolve the caller's role in this org: sub may have been resolved for another org.
	own := sub
	if !sub.InstanceAdmin {
		own, err = s.orgs.Subject(ctx, sub.UserID, orgID)
		if err != nil {
			return nil, fmt.Errorf("admin: org usage: %w", err)
		}
	}
	if !own.InstanceAdmin {
		if own.OrgRole == "" {
			return nil, fmt.Errorf("admin: org usage: %s: %w", orgID, apperr.ErrNotFound)
		}
		if !authz.Can(own, authz.OrgUsageRead, "") {
			return nil, fmt.Errorf("admin: org usage: %w", apperr.ErrForbidden)
		}
	}
	out, err := s.rt.With(s.root).TenantUsage(ctx, org.TenantID)
	if err != nil {
		return nil, fmt.Errorf("admin: org usage: %w", err)
	}
	if own.InstanceAdmin {
		if err := s.record(ctx, own, "org.usage.read", nil, "applied", ""); err != nil {
			return nil, fmt.Errorf("admin: audit org usage read: %w", err)
		}
	}
	return out, nil
}

// Domains lists every org's custom domains for the admin domain view.
func (s *Service) Domains(ctx context.Context, sub authz.Subject) ([]DomainView, error) {
	if err := requireInstanceAdmin(sub); err != nil {
		return nil, err
	}
	rows, err := s.st.Q().ListAllDomains(ctx)
	if err != nil {
		return nil, fmt.Errorf("admin: domains: %w", err)
	}
	out := make([]DomainView, 0, len(rows))
	for _, r := range rows {
		d := DomainView{
			ID: r.ID, Host: r.Host, ProjectSlug: r.ProjectSlug, ServiceID: r.ServiceID,
			Status: r.Status, CreatedAt: r.CreatedAt, Org: OrgRef{Slug: r.OrgSlug, Name: r.OrgName},
		}
		if r.LastCheckedAt.Valid {
			v := r.LastCheckedAt.Int64
			d.LastCheckedAt = &v
		}
		out = append(out, d)
	}
	return out, nil
}

const (
	actNodeConfig = "node.config.update"
	actDrain      = "node.drain"
)

// intent writes the pending audit row for a mutation. Its failure aborts the mutation.
func (s *Service) intent(ctx context.Context, sub authz.Subject, action string, detail map[string]any) error {
	if err := s.record(ctx, sub, action, detail, "pending", ""); err != nil {
		return fmt.Errorf("admin: audit intent %s: %w", action, err)
	}
	return nil
}

// outcome writes the applied or failed audit row. A failure is logged at ERROR: the runtime change has
// already happened, so the caller still gets the runtime result.
func (s *Service) outcome(ctx context.Context, sub authz.Subject, action string, detail map[string]any, status, code string) {
	if err := s.record(ctx, sub, action, detail, status, code); err != nil {
		slog.Error("admin: audit outcome write failed; runtime change already applied",
			"action", action, "status", status, "err", err)
	}
}

// record appends one audit row, instance-wide, with status and optional error code in its detail.
func (s *Service) record(ctx context.Context, sub authz.Subject, action string, detail map[string]any, status, code string) error {
	d := make(map[string]any, len(detail)+2)
	for k, v := range detail {
		d[k] = v
	}
	d["status"] = status
	if code != "" {
		d["error_code"] = code
	}
	actor := audit.Actor{UserID: sub.UserID, AsInstanceAdmin: sub.InstanceAdmin}
	return s.st.Tx(ctx, func(q *db.Queries) error {
		return s.log.Log(ctx, q, actor, "", action, "node", d)
	})
}

// failCode is the runtime error code when there is one, else "internal".
func failCode(err error) string {
	var e *runtime.Error
	if errors.As(err, &e) && e.Code != "" {
		return e.Code
	}
	return "internal"
}
