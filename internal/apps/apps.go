package apps

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/netip"
	"slices"
	"strings"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/runtime"
)

// SlugTakenMessage explains a slug_taken conflict on app create: slugs are unique per runtime node.
const SlugTakenMessage = "This app name is taken on this runtime"

// Status is an app's build and tier state.
type Status struct {
	BuildState string  `json:"build_state"`
	Tier       string  `json:"tier"`
	LastError  *string `json:"last_error"`
}

// Limits shows the requested limits, the resolved ones, and the dominant source: "plan" when any value
// is clamped by the plan, else "service" when the app requests any limit, else "profile".
type Limits struct {
	Requested json.RawMessage `json:"requested"`
	Effective json.RawMessage `json:"effective"`
	Source    string          `json:"source"`
}

// Summary is an app in a list.
type Summary struct {
	Slug        string  `json:"slug"`
	Name        *string `json:"name"`
	Project     string  `json:"project"`
	Environment string  `json:"environment"`
	LiveVersion *int    `json:"live_version"`
	Status      Status  `json:"status"`
}

// AppView is one app with its runtime object (Raw), ETag, status and limits.
type AppView struct {
	Raw    runtime.Service
	ETag   string
	Status Status
	Limits Limits
}

// Ingress is the app's ingress block. It replaces the runtime block as a whole.
type Ingress struct {
	Methods      []string        `json:"allowed_methods,omitempty"`
	PathPrefixes []string        `json:"allow_paths,omitempty"`
	IPAllow      []string        `json:"ip_allow,omitempty"` // CIDR prefixes
	RateLimit    json.RawMessage `json:"rate_limit,omitempty"`
}

// Call lists who may call the app (app slugs, ids or env:<environment>).
type Call struct {
	AllowedCallers []string `json:"allowed_callers"`
}

// AppPatch changes app settings. Every non-nil block REPLACES the whole runtime block (no merge);
// nil leaves it unchanged.
type AppPatch struct {
	Name    *string
	Profile *string
	Access  *string
	Scaling json.RawMessage
	Ingress *Ingress
	Egress  json.RawMessage
	Call    *Call
	Limits  json.RawMessage
}

func statusFrom(st runtime.ServiceStatus) Status {
	return Status{BuildState: st.BuildState, Tier: st.Tier, LastError: st.LastError}
}

func viewFrom(svc runtime.Service, etag string) AppView {
	if etag == "" {
		etag = svc.ETag
	}
	var req json.RawMessage
	if len(svc.Limits) > 0 && string(svc.Limits) != "null" {
		req = svc.Limits
	}
	return AppView{Raw: svc, ETag: etag, Status: statusFrom(svc.Status), Limits: Limits{
		Requested: req, Effective: svc.Effective, Source: limitSource(req, svc.Effective),
	}}
}

func limitSource(requested, effective json.RawMessage) string {
	var eff map[string]struct {
		Source string `json:"source"`
	}
	_ = json.Unmarshal(effective, &eff)
	service := false
	for _, v := range eff {
		switch {
		case v.Source == "plan" || strings.HasPrefix(v.Source, "plan:"):
			return "plan"
		case v.Source == "service":
			service = true
		}
	}
	if service || (len(requested) > 0 && string(requested) != "{}") {
		return "service"
	}
	return "profile"
}

// app resolves slug and checks a on its project (ErrNotFound when the caller cannot see it).
func (s *Service) app(ctx context.Context, sub authz.Subject, orgID, slug string, a authz.Action) (App, *runtime.Scoped, error) {
	if err := member(sub); err != nil {
		return App{}, nil, err
	}
	app, err := s.Resolve(ctx, orgID, slug)
	if err != nil {
		return App{}, nil, err
	}
	if err := authorize(sub, a, authz.AppRead, app.ProjectSlug); err != nil {
		return App{}, nil, err
	}
	cli, err := s.client(ctx, orgID)
	if err != nil {
		return App{}, nil, err
	}
	return app, cli, nil
}

// List returns the org's apps the caller may read, optionally narrowed to a project and environment.
func (s *Service) List(ctx context.Context, sub authz.Subject, orgID, projectSlug, environment string) ([]Summary, error) {
	if err := member(sub); err != nil {
		return nil, err
	}
	if projectSlug != "" {
		if err := authorize(sub, authz.AppRead, authz.AppRead, projectSlug); err != nil {
			return nil, err
		}
	}
	cli, err := s.client(ctx, orgID)
	if err != nil {
		return nil, err
	}
	out := []Summary{}
	f := runtime.ServiceFilter{Project: projectSlug, Environment: environment}
	for {
		page, err := cli.ListServices(ctx, f)
		if err != nil {
			return nil, mapErr("list apps", err)
		}
		for _, svc := range page.Items {
			if authz.Can(sub, authz.AppRead, svc.Project) {
				out = append(out, Summary{
					Slug: svc.Slug, Name: svc.Name, Project: svc.Project, Environment: svc.Environment,
					LiveVersion: svc.LiveVersion, Status: statusFrom(svc.Status),
				})
			}
		}
		if page.NextCursor == nil || *page.NextCursor == "" {
			return out, nil
		}
		f.Cursor = *page.NextCursor
	}
}

// Get returns one app with its ETag.
func (s *Service) Get(ctx context.Context, sub authz.Subject, orgID, slug string) (AppView, error) {
	app, cli, err := s.app(ctx, sub, orgID, slug, authz.AppRead)
	if err != nil {
		return AppView{}, err
	}
	svc, etag, err := cli.GetService(ctx, app.SvcID)
	if err != nil {
		if runtime.IsNotFound(err) {
			s.evict(orgID, slug)
		}
		return AppView{}, mapErr("get app "+slug, err)
	}
	return viewFrom(svc, etag), nil
}

// Create creates an app in projectSlug/environment from a template, uploaded as version 1 (built
// eagerly and set live). The environment must be one of the project's. A slug held anywhere on the
// runtime node is apperr.Conflict{slug_taken}.
func (s *Service) Create(ctx context.Context, sub authz.Subject, orgID, projectSlug, environment, slug, template string) (AppView, error) {
	if err := member(sub); err != nil {
		return AppView{}, err
	}
	if err := authorize(sub, authz.AppCreate, authz.AppRead, projectSlug); err != nil {
		return AppView{}, err
	}
	src, ok := renderTemplate(template, slug)
	if !ok {
		return AppView{}, fmt.Errorf("apps: template %q: %w", template, apperr.ErrInvalid)
	}
	envs, err := s.environments(ctx, orgID, projectSlug)
	if err != nil {
		return AppView{}, err
	}
	if !slices.Contains(envs, environment) {
		return AppView{}, fmt.Errorf("apps: environment %q is not in project %s: %w", environment, projectSlug, apperr.ErrInvalid)
	}
	cli, err := s.client(ctx, orgID)
	if err != nil {
		return AppView{}, err
	}
	svc, err := cli.CreateService(ctx, runtime.ServiceCreate{Slug: slug, Runtime: "deno", Project: &projectSlug, Environment: &environment})
	if err != nil {
		if code, ok := runtimeConflict(err); ok && code == "slug_taken" {
			return AppView{}, fmt.Errorf("apps: create %s: %w", slug, apperr.Conflict{Code: "slug_taken", Message: SlugTakenMessage, Public: true})
		}
		return AppView{}, mapErr("create "+slug, err)
	}
	s.evict(orgID, slug)
	if s.beforeUpload != nil {
		s.beforeUpload()
	}
	if _, err := cli.UploadVersion(ctx, svc.ID, strings.NewReader(src), "application/typescript", runtime.UploadOpts{Activate: true, Compile: "eager"}); err != nil {
		// Best effort: do not leave an empty app holding the slug.
		if derr := cli.DeleteService(ctx, svc.ID, false); derr != nil {
			slog.Error("apps: delete app after failed template upload", "org_id", orgID, "svc_id", svc.ID, "err", derr)
		}
		s.evict(orgID, slug)
		return AppView{}, mapErr("upload template for "+slug, err)
	}
	svc, etag, err := cli.GetService(ctx, svc.ID)
	if err != nil {
		return AppView{}, mapErr("get app "+slug, err)
	}
	return viewFrom(svc, etag), nil
}

func runtimeConflict(err error) (string, bool) {
	e := mapErr("", err)
	return apperr.ConflictCode(e)
}

// Update applies patch under etag (required: else apperr.ErrPreconditionRequired). A stale etag is
// apperr.Conflict{stale}. Each present block replaces the runtime block.
func (s *Service) Update(ctx context.Context, sub authz.Subject, orgID, slug string, patch AppPatch, etag string) (AppView, error) {
	app, cli, err := s.app(ctx, sub, orgID, slug, authz.AppUpdate)
	if err != nil {
		return AppView{}, err
	}
	if etag == "" {
		return AppView{}, fmt.Errorf("apps: update %s: %w", slug, apperr.ErrPreconditionRequired)
	}
	in := runtime.ServicePatch{Name: patch.Name, Profile: patch.Profile, Access: patch.Access,
		Scaling: patch.Scaling, Egress: patch.Egress, Limits: patch.Limits}
	if patch.Ingress != nil {
		for i, c := range patch.Ingress.IPAllow {
			if _, err := netip.ParsePrefix(c); err != nil {
				return AppView{}, fmt.Errorf("apps: ingress.ip_allow[%d] %q: %w", i, c, apperr.ErrInvalid)
			}
		}
		if in.Ingress, err = json.Marshal(patch.Ingress); err != nil {
			return AppView{}, fmt.Errorf("apps: marshal ingress: %w", err)
		}
	}
	if patch.Call != nil {
		c := *patch.Call
		if c.AllowedCallers == nil {
			c.AllowedCallers = []string{}
		}
		if in.Call, err = json.Marshal(c); err != nil {
			return AppView{}, fmt.Errorf("apps: marshal call: %w", err)
		}
	}
	svc, err := cli.PatchService(ctx, app.SvcID, in, etag)
	s.evict(orgID, slug)
	if err != nil {
		return AppView{}, mapErr("update "+slug, err)
	}
	return viewFrom(svc, ""), nil
}

// Delete deletes the app and its data.
func (s *Service) Delete(ctx context.Context, sub authz.Subject, orgID, slug string) error {
	app, cli, err := s.app(ctx, sub, orgID, slug, authz.AppDelete)
	if err != nil {
		return err
	}
	err = cli.DeleteService(ctx, app.SvcID, false)
	s.evict(orgID, slug)
	if err != nil {
		return mapErr("delete "+slug, err)
	}
	return nil
}
