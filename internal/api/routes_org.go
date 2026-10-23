package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/apps"
	"github.com/21cloud/runtime-web/internal/audit"
	"github.com/21cloud/runtime-web/internal/auth"
	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/keys"
	"github.com/21cloud/runtime-web/internal/orgs"
	"github.com/21cloud/runtime-web/internal/runtime"
)

// orgCall is one resolved org request: the org, the caller's subject in it and the audit actor.
type orgCall struct {
	org   orgs.Org
	sub   authz.Subject
	actor audit.Actor
}

// orgHandler handles an org-scoped request after orgAccess has passed.
type orgHandler func(w http.ResponseWriter, r *http.Request, c orgCall) error

// orgRoute registers an org-scoped route. Every such route states its authz.Action, and orgAccess
// enforces it before h runs.
func (s *Server) orgRoute(method, pattern string, action authz.Action, h orgHandler) {
	s.route(method, pattern, action, func(w http.ResponseWriter, r *http.Request) error {
		c, err := s.orgAccess(r, action)
		if err != nil {
			return err
		}
		return h(w, r, c)
	})
}

// orgAccess resolves {org} to an org and the caller's subject. A non-member gets 404, as does a
// project outside the caller's grants. A member without the action's role gets 403. {p}, when the
// route has one, is the project slug the action applies to.
func (s *Server) orgAccess(r *http.Request, action authz.Action) (orgCall, error) {
	ctx := r.Context()
	p, ok := auth.FromContext(ctx)
	if !ok {
		return orgCall{}, auth.ErrNoSession
	}
	org, err := s.deps.Orgs.GetBySlug(ctx, r.PathValue("org"))
	if err != nil {
		return orgCall{}, err
	}
	sub, err := s.deps.Orgs.Subject(ctx, p.User.ID, org.ID)
	if err != nil {
		return orgCall{}, err
	}
	if !sub.InstanceAdmin && sub.OrgRole == "" {
		return orgCall{}, fmt.Errorf("api: org %s: %w", org.Slug, apperr.ErrNotFound)
	}
	proj := r.PathValue("p")
	if !authz.Can(sub, action, proj) {
		if !sub.InstanceAdmin && proj != "" && sub.ProjectRoles[proj] == "" {
			return orgCall{}, fmt.Errorf("api: project %s: %w", proj, apperr.ErrNotFound)
		}
		return orgCall{}, fmt.Errorf("api: %s: %w", action, apperr.ErrForbidden)
	}
	// Only an instance admin acting without a membership is recorded as acting as instance admin.
	asAdmin := sub.InstanceAdmin && sub.OrgRole == ""
	return orgCall{org: org, sub: sub, actor: audit.Actor{UserID: p.User.ID, AsInstanceAdmin: asAdmin}}, nil
}

// actorFor returns the audit actor for the signed-in caller.
func actorFor(r *http.Request) (audit.Actor, error) {
	p, ok := auth.FromContext(r.Context())
	if !ok {
		return audit.Actor{}, auth.ErrNoSession
	}
	return audit.Actor{UserID: p.User.ID, AsInstanceAdmin: p.User.IsInstanceAdmin}, nil
}

// instanceSubject is the subject of an instance admin acting outside any org.
func instanceSubject(r *http.Request) (authz.Subject, error) {
	p, ok := auth.FromContext(r.Context())
	if !ok {
		return authz.Subject{}, auth.ErrNoSession
	}
	return authz.Subject{UserID: p.User.ID, InstanceAdmin: true}, nil
}

// pageJSON is the Page<T> shape of api-web.md §1.6.
type pageJSON[T any] struct {
	Items      []T     `json:"items"`
	NextCursor *string `json:"next_cursor"`
}

// itemsJSON is the unpaged list shape {items: T[]} of api-web.md §1.6.
type itemsJSON[T any] struct {
	Items []T `json:"items"`
}

// listParams reads ?cursor and ?limit (default 50, max 200).
func listParams(r *http.Request) (cursor string, limit int, err error) {
	q := r.URL.Query()
	limit = 50
	if raw := q.Get("limit"); raw != "" {
		n, convErr := strconv.Atoi(raw)
		if convErr != nil || n < 1 || n > 200 {
			return "", 0, invalid(fieldErrors{"limit": "must be between 1 and 200"})
		}
		limit = n
	}
	return q.Get("cursor"), limit, nil
}

// nextCursor returns the cursor pointer for a page: nil on the last page.
func nextCursor(next string) *string {
	if next == "" {
		return nil
	}
	return &next
}

// orgJSON is the Org shape of api-web.md §2. Role is nil when the caller is not a member.
type orgJSON struct {
	ID        string  `json:"id"`
	Slug      string  `json:"slug"`
	Name      string  `json:"name"`
	CreatedAt int64   `json:"created_at"`
	Role      *string `json:"role"`
}

func orgView(o orgs.Org, role string) orgJSON {
	v := orgJSON{ID: o.ID, Slug: o.Slug, Name: o.Name, CreatedAt: o.CreatedAt}
	if role != "" {
		v.Role = &role
	}
	return v
}

// memberJSON is the Member shape of api-web.md §2.
type memberJSON struct {
	User struct {
		ID    string `json:"id"`
		Email string `json:"email"`
		Name  string `json:"name"`
	} `json:"user"`
	Role   string            `json:"role"`
	Grants map[string]string `json:"grants"`
}

func memberView(m orgs.Member) memberJSON {
	var v memberJSON
	v.User.ID, v.User.Email, v.User.Name = m.UserID, m.Email, m.Name
	v.Role = m.Role
	v.Grants = m.Grants
	if v.Grants == nil {
		v.Grants = map[string]string{}
	}
	return v
}

// auditJSON is the AuditEntry shape of api-web.md §2.
type auditJSON struct {
	ID              string          `json:"id"`
	At              int64           `json:"at"`
	Actor           auditActor      `json:"actor"`
	AsInstanceAdmin bool            `json:"as_instance_admin"`
	Org             *auditOrgRef    `json:"org"`
	Action          string          `json:"action"`
	Target          string          `json:"target"`
	Detail          json.RawMessage `json:"detail"`
}

type auditActor struct {
	UserID *string `json:"user_id"`
	Name   *string `json:"name"`
	Email  *string `json:"email"`
}

type auditOrgRef struct {
	ID   string `json:"id"`
	Slug string `json:"slug"`
}

// auditViews turns audit entries into their API shape, resolving actors and orgs once each.
func (s *Server) auditViews(r *http.Request, entries []audit.Entry) ([]auditJSON, error) {
	ctx := r.Context()
	q := s.deps.Auth.Store.Q()
	users := map[string]auditActor{}
	orgRefs := map[string]*auditOrgRef{}
	out := make([]auditJSON, 0, len(entries))
	for _, e := range entries {
		actor, ok := users[e.ActorUserID]
		if !ok {
			actor = auditActor{}
			if e.ActorUserID != "" {
				id := e.ActorUserID
				actor.UserID = &id
				u, err := q.GetUserByID(ctx, e.ActorUserID)
				switch {
				case errors.Is(err, sql.ErrNoRows):
				case err != nil:
					return nil, fmt.Errorf("api: audit actor: %w", err)
				default:
					name, email := u.Name, u.Email
					actor.Name, actor.Email = &name, &email
				}
			}
			users[e.ActorUserID] = actor
		}
		var org *auditOrgRef
		if e.OrgID != nil {
			ref, ok := orgRefs[*e.OrgID]
			if !ok {
				o, err := s.deps.Orgs.Get(ctx, *e.OrgID)
				if err != nil {
					return nil, fmt.Errorf("api: audit org: %w", err)
				}
				ref = &auditOrgRef{ID: o.ID, Slug: o.Slug}
				orgRefs[*e.OrgID] = ref
			}
			org = ref
		}
		row := auditJSON{ID: e.ID, At: e.At, Actor: actor, AsInstanceAdmin: e.AsInstanceAdmin,
			Org: org, Action: e.Action, Target: e.Target}
		if e.Detail != "" && json.Valid([]byte(e.Detail)) {
			row.Detail = json.RawMessage(e.Detail)
		}
		out = append(out, row)
	}
	return out, nil
}

// registerOrgRoutes wires the org, member, token, project, usage, limits and audit routes.
func (s *Server) registerOrgRoutes() {
	s.route(http.MethodGet, "/api/orgs", "", s.listOrgs)
	s.orgRoute(http.MethodGet, "/api/orgs/{org}", authz.OrgRead, s.getOrg)
	s.orgRoute(http.MethodGet, "/api/orgs/{org}/members", authz.OrgRead, s.listMembers)
	s.orgRoute(http.MethodPost, "/api/orgs/{org}/members", authz.MembersManage, s.addMember)
	s.orgRoute(http.MethodPatch, "/api/orgs/{org}/members/{user}", authz.MembersManage, s.setMemberRole)
	s.orgRoute(http.MethodDelete, "/api/orgs/{org}/members/{user}", authz.MembersManage, s.removeMember)
	s.orgRoute(http.MethodPut, "/api/orgs/{org}/members/{user}/grants/{p}", authz.GrantsManage, s.setGrant)
	s.orgRoute(http.MethodDelete, "/api/orgs/{org}/members/{user}/grants/{p}", authz.GrantsManage, s.removeGrant)
	s.orgRoute(http.MethodGet, "/api/orgs/{org}/tokens", authz.TokensManage, s.listTokens)
	s.orgRoute(http.MethodPost, "/api/orgs/{org}/tokens", authz.TokensManage, s.createToken)
	s.orgRoute(http.MethodDelete, "/api/orgs/{org}/tokens/{id}", authz.TokensManage, s.revokeToken)
	s.orgRoute(http.MethodPost, "/api/orgs/{org}/default-key/rotate", authz.DefaultKeyRotate, s.rotateDefaultKey)
	s.orgRoute(http.MethodGet, "/api/orgs/{org}/limits", authz.OrgRead, s.getLimits)
	s.orgRoute(http.MethodGet, "/api/orgs/{org}/usage", authz.OrgUsageRead, s.getOrgUsage)
	s.orgRoute(http.MethodGet, "/api/orgs/{org}/audit", authz.OrgAuditRead, s.getOrgAudit)
	s.orgRoute(http.MethodGet, "/api/orgs/{org}/projects", authz.OrgRead, s.listProjects)
	s.orgRoute(http.MethodPost, "/api/orgs/{org}/projects", authz.ProjectCreate, s.createProject)
	s.orgRoute(http.MethodGet, "/api/orgs/{org}/projects/{p}", authz.ProjectRead, s.getProject)
	s.orgRoute(http.MethodPatch, "/api/orgs/{org}/projects/{p}", authz.ProjectUpdate, s.updateProject)
	s.orgRoute(http.MethodDelete, "/api/orgs/{org}/projects/{p}", authz.ProjectDelete, s.deleteProject)
	s.orgRoute(http.MethodGet, "/api/orgs/{org}/projects/{p}/environments", authz.ProjectRead, s.listEnvironments)
}

// listOrgs returns the caller's orgs; an instance admin sees every org.
func (s *Server) listOrgs(w http.ResponseWriter, r *http.Request) error {
	p, ok := auth.FromContext(r.Context())
	if !ok {
		return auth.ErrNoSession
	}
	forUser := p.User.ID
	if p.User.IsInstanceAdmin {
		forUser = ""
	}
	list, err := s.deps.Orgs.List(r.Context(), forUser)
	if err != nil {
		return err
	}
	items := make([]orgJSON, 0, len(list))
	for _, o := range list {
		sub, err := s.deps.Orgs.Subject(r.Context(), p.User.ID, o.ID)
		if err != nil {
			return err
		}
		items = append(items, orgView(o, sub.OrgRole))
	}
	writeJSON(w, http.StatusOK, itemsJSON[orgJSON]{Items: items})
	return nil
}

func (s *Server) getOrg(w http.ResponseWriter, _ *http.Request, c orgCall) error {
	writeJSON(w, http.StatusOK, orgView(c.org, c.sub.OrgRole))
	return nil
}

func (s *Server) listMembers(w http.ResponseWriter, r *http.Request, c orgCall) error {
	list, err := s.deps.Orgs.Members(r.Context(), c.org.ID)
	if err != nil {
		return err
	}
	items := make([]memberJSON, 0, len(list))
	for _, m := range list {
		items = append(items, memberView(m))
	}
	writeJSON(w, http.StatusOK, itemsJSON[memberJSON]{Items: items})
	return nil
}

type memberReq struct {
	UserID string `json:"user_id"`
	Role   string `json:"role"`
}

func (s *Server) addMember(w http.ResponseWriter, r *http.Request, c orgCall) error {
	var in memberReq
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	if err := s.deps.Orgs.AddMember(ctx, c.actor, c.sub, c.org.ID, in.UserID, in.Role); err != nil {
		return err
	}
	m, err := s.deps.Orgs.Member(ctx, c.org.ID, in.UserID)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, memberView(m))
	return nil
}

func (s *Server) setMemberRole(w http.ResponseWriter, r *http.Request, c orgCall) error {
	var in memberReq
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	user := r.PathValue("user")
	if err := s.deps.Orgs.SetRole(ctx, c.actor, c.sub, c.org.ID, user, in.Role); err != nil {
		return err
	}
	m, err := s.deps.Orgs.Member(ctx, c.org.ID, user)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, memberView(m))
	return nil
}

func (s *Server) removeMember(w http.ResponseWriter, r *http.Request, c orgCall) error {
	if err := s.deps.Orgs.RemoveMember(r.Context(), c.actor, c.sub, c.org.ID, r.PathValue("user")); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

type roleReq struct {
	Role string `json:"role"`
}

func (s *Server) setGrant(w http.ResponseWriter, r *http.Request, c orgCall) error {
	var in roleReq
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	user := r.PathValue("user")
	if err := s.deps.Orgs.SetGrant(ctx, c.actor, c.sub, c.org.ID, user, r.PathValue("p"), in.Role); err != nil {
		return err
	}
	m, err := s.deps.Orgs.Member(ctx, c.org.ID, user)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, memberView(m))
	return nil
}

func (s *Server) removeGrant(w http.ResponseWriter, r *http.Request, c orgCall) error {
	if err := s.deps.Orgs.RemoveGrant(r.Context(), c.actor, c.sub, c.org.ID, r.PathValue("user"), r.PathValue("p")); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) listTokens(w http.ResponseWriter, r *http.Request, c orgCall) error {
	list, err := s.deps.Keys.ListTokens(r.Context(), c.org.ID)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, itemsJSON[keys.Token]{Items: list})
	return nil
}

// tokenReq is TokenReq of api-web.md §7. Apps are app slugs; expires_at is unix ms.
type tokenReq struct {
	Name      string   `json:"name"`
	Scopes    []string `json:"scopes"`
	Apps      []string `json:"apps"`
	ExpiresAt *int64   `json:"expires_at"`
}

func (s *Server) createToken(w http.ResponseWriter, r *http.Request, c orgCall) error {
	var in tokenReq
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	req := keys.TokenRequest{Name: in.Name, Scopes: in.Scopes, Services: in.Apps}
	if in.ExpiresAt != nil {
		t := time.UnixMilli(*in.ExpiresAt)
		req.ExpiresAt = &t
	}
	tok, secret, err := s.deps.Keys.CreateToken(r.Context(), c.actor, c.sub, c.org.ID, req)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, map[string]any{"token": tok, "secret": secret})
	return nil
}

func (s *Server) revokeToken(w http.ResponseWriter, r *http.Request, c orgCall) error {
	if err := s.deps.Keys.RevokeToken(r.Context(), c.actor, c.org.ID, r.PathValue("id")); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) rotateDefaultKey(w http.ResponseWriter, r *http.Request, c orgCall) error {
	if err := s.deps.Keys.RotateDefault(r.Context(), c.actor, c.org.ID); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// limitsJSON is the read-only quota view. The plan name is not shown.
type limitsJSON struct {
	Day          string        `json:"day"`
	ResetsAt     int64         `json:"resets_at"`
	Invocations  runtime.Quota `json:"invocations"`
	EgressBytes  runtime.Quota `json:"egress_bytes"`
	StorageBytes runtime.Quota `json:"storage_bytes"`
	Services     runtime.Quota `json:"services"`
	Schedules    runtime.Quota `json:"schedules"`
}

func (s *Server) getLimits(w http.ResponseWriter, r *http.Request, c orgCall) error {
	l, err := s.deps.Orgs.Limits(r.Context(), c.org.ID)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, limitsJSON{Day: l.Day, ResetsAt: l.ResetsAt, Invocations: l.Invocations,
		EgressBytes: l.EgressBytes, StorageBytes: l.StorageBytes, Services: l.Services, Schedules: l.Schedules})
	return nil
}

// usageJSON is the Usage shape of api-web.md §6. App is the slug, nil for a deleted app.
type usageJSON struct {
	App          *string `json:"app"`
	Day          string  `json:"day"`
	Invocations  int64   `json:"invocations"`
	CPUMs        int64   `json:"cpu_ms"`
	EgressBytes  int64   `json:"egress_bytes"`
	StorageBytes int64   `json:"storage_bytes"`
}

// maxUsageSpanDays caps the ?from..?to usage window.
const maxUsageSpanDays = 90

// usageRange parses ?from and ?to (YYYY-MM-DD, inclusive). A missing bound defaults to today (to)
// or to 89 days before to (from). from after to, or a window over maxUsageSpanDays, is a 422.
func usageRange(r *http.Request, now time.Time) (string, string, error) {
	q := r.URL.Query()
	fields := fieldErrors{}
	parse := func(name string) (time.Time, bool) {
		raw := q.Get(name)
		if raw == "" {
			return time.Time{}, false
		}
		t, err := time.Parse("2006-01-02", raw)
		if err != nil {
			fields[name] = "must be a YYYY-MM-DD date"
			return time.Time{}, false
		}
		return t, true
	}
	from, hasFrom := parse("from")
	to, hasTo := parse("to")
	if len(fields) > 0 {
		return "", "", invalid(fields)
	}
	if !hasTo {
		to = time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	}
	if !hasFrom {
		from = to.AddDate(0, 0, -(maxUsageSpanDays - 1))
	}
	if from.After(to) {
		return "", "", invalid(fieldErrors{"from": "must not be after to"})
	}
	if to.Sub(from).Hours()/24 > maxUsageSpanDays-1 {
		return "", "", invalid(fieldErrors{"to": fmt.Sprintf("range must be at most %d days", maxUsageSpanDays)})
	}
	return from.Format("2006-01-02"), to.Format("2006-01-02"), nil
}

// usageItems returns orgID's usage rows within ?from..?to (YYYY-MM-DD, inclusive), with service ids
// mapped to app slugs.
func (s *Server) usageItems(r *http.Request, sub authz.Subject, org orgs.Org) ([]usageJSON, error) {
	from, to, err := usageRange(r, time.Now().UTC())
	if err != nil {
		return nil, err
	}
	ctx := r.Context()
	rows, err := s.deps.Admin.OrgUsage(ctx, sub, org.ID)
	if err != nil {
		return nil, err
	}
	slugs, err := s.deps.Apps.SlugsByServiceID(ctx, sub, org.ID)
	if err != nil {
		return nil, err
	}
	items := []usageJSON{}
	for _, u := range rows {
		if (from != "" && u.Day < from) || (to != "" && u.Day > to) {
			continue
		}
		item := usageJSON{Day: u.Day, Invocations: u.Invocations, CPUMs: u.CPUMs,
			EgressBytes: u.EgressBytes, StorageBytes: u.StorageBytes}
		if slug, ok := slugs[u.ServiceID]; ok {
			item.App = &slug
		}
		items = append(items, item)
	}
	return items, nil
}

func (s *Server) getOrgUsage(w http.ResponseWriter, r *http.Request, c orgCall) error {
	items, err := s.usageItems(r, c.sub, c.org)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, itemsJSON[usageJSON]{Items: items})
	return nil
}

func (s *Server) getOrgAudit(w http.ResponseWriter, r *http.Request, c orgCall) error {
	return s.writeAuditPage(w, r, &c.org.ID, r.URL.Query().Get("actor"))
}

// writeAuditPage lists audit entries for orgID (nil: every org) filtered by ?actor and ?action.
func (s *Server) writeAuditPage(w http.ResponseWriter, r *http.Request, orgID *string, actor string) error {
	cursor, limit, err := listParams(r)
	if err != nil {
		return err
	}
	entries, next, err := audit.List(r.Context(), s.deps.Auth.Store.Q(), audit.Filter{
		OrgID: orgID, ActorUserID: actor, Action: r.URL.Query().Get("action"), Before: cursor, Limit: limit,
	})
	if err != nil {
		return err
	}
	items, err := s.auditViews(r, entries)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, pageJSON[auditJSON]{Items: items, NextCursor: nextCursor(next)})
	return nil
}

func (s *Server) listProjects(w http.ResponseWriter, r *http.Request, c orgCall) error {
	list, err := s.deps.Apps.ListProjects(r.Context(), c.sub, c.org.ID)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, itemsJSON[apps.Project]{Items: list})
	return nil
}

// projectReq is the body of POST /projects and PATCH /projects/{p}.
type projectReq struct {
	Slug         string    `json:"slug"`
	Name         *string   `json:"name"`
	Environments *[]string `json:"environments"`
}

func (s *Server) createProject(w http.ResponseWriter, r *http.Request, c orgCall) error {
	var in projectReq
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	name := ""
	if in.Name != nil {
		name = *in.Name
	}
	var envs []string
	if in.Environments != nil {
		envs = *in.Environments
	}
	ctx := r.Context()
	proj, err := s.deps.Apps.CreateProject(ctx, c.sub, c.org.ID, in.Slug, name, envs)
	if err != nil {
		return err
	}
	if err := s.auditProject(ctx, c, "project.create", in.Slug, nil); err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, proj)
	return nil
}

func (s *Server) getProject(w http.ResponseWriter, r *http.Request, c orgCall) error {
	proj, err := s.deps.Apps.GetProject(r.Context(), c.sub, c.org.ID, r.PathValue("p"))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, proj)
	return nil
}

func (s *Server) updateProject(w http.ResponseWriter, r *http.Request, c orgCall) error {
	var in projectReq
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	var envs []string
	if in.Environments != nil {
		envs = *in.Environments
		if envs == nil {
			envs = []string{}
		}
	}
	slug := r.PathValue("p")
	ctx := r.Context()
	proj, err := s.deps.Apps.UpdateProject(ctx, c.sub, c.org.ID, slug, in.Name, envs)
	if err != nil {
		return err
	}
	if err := s.auditProject(ctx, c, "project.update", slug, map[string]any{
		"name": in.Name != nil, "environments": in.Environments != nil,
	}); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, proj)
	return nil
}

func (s *Server) deleteProject(w http.ResponseWriter, r *http.Request, c orgCall) error {
	slug := r.PathValue("p")
	ctx := r.Context()
	if err := s.deps.Apps.DeleteProject(ctx, c.sub, c.org.ID, slug); err != nil {
		return err
	}
	if err := s.auditProject(ctx, c, "project.delete", slug, nil); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) listEnvironments(w http.ResponseWriter, r *http.Request, c orgCall) error {
	envs, err := s.deps.Apps.ListEnvironments(r.Context(), c.sub, c.org.ID, r.PathValue("p"))
	if err != nil {
		return err
	}
	if envs == nil {
		envs = []string{}
	}
	writeJSON(w, http.StatusOK, itemsJSON[string]{Items: envs})
	return nil
}

// auditProject records a project mutation at the API layer, because the apps service has no actor.
// Instance-admin actions carry as_instance_admin.
func (s *Server) auditProject(ctx context.Context, c orgCall, action, slug string, detail any) error {
	if err := (audit.Writer{}).Log(ctx, s.deps.Auth.Store.Q(), c.actor, c.org.ID, action, slug, detail); err != nil {
		return fmt.Errorf("api: audit %s: %w", action, err)
	}
	return nil
}
