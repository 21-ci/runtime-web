package api

import (
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/21cloud/runtime-web/internal/apps"
	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/domains"
	"github.com/21cloud/runtime-web/internal/runtime"
)

// Every app route is registered with appRoute: org membership is checked here, and the apps and domains
// services check the action on the app's project (they return 404 for a project the caller cannot see and
// 403 for a role too low for the action). The action is recorded in the registry.

const (
	appsPath = "/api/orgs/{org}/apps"
	appPath  = appsPath + "/{app}"
)

var appAccessModes = []string{"public", "key", "internal"}

// registerAppRoutes wires the app, code, config, observability and domain routes (api-web.md section 8).
func (s *Server) registerAppRoutes() {
	s.appRoute(http.MethodGet, appsPath, authz.AppRead, s.listApps)
	s.appRoute(http.MethodPost, appsPath, authz.AppCreate, s.createApp)
	s.appRoute(http.MethodGet, appPath, authz.AppRead, s.getApp)
	s.appRoute(http.MethodPatch, appPath, authz.AppUpdate, s.patchApp)
	s.appRoute(http.MethodDelete, appPath, authz.AppDelete, s.deleteApp)

	s.appRoute(http.MethodGet, appPath+"/files", authz.AppRead, s.getFiles)
	s.appRoute(http.MethodPut, appPath+"/files", authz.AppDeploy, s.putFiles)
	s.appRoute(http.MethodGet, appPath+"/versions", authz.AppRead, s.listVersions)
	s.appRoute(http.MethodPut, appPath+"/live", authz.AppDeploy, s.putLive)
	s.appRoute(http.MethodGet, appPath+"/versions/{v}/build-logs", authz.AppRead, s.buildLogs)
	s.appRoute(http.MethodPost, appPath+"/versions/{v}/rebuild", authz.AppDeploy, s.rebuildVersion)

	s.appRoute(http.MethodGet, appPath+"/events", authz.AppRead, s.listEvents)
	s.appRoute(http.MethodGet, appPath+"/stats", authz.AppRead, s.appStats)

	s.appRoute(http.MethodGet, appPath+"/env", authz.AppRead, s.getEnv)
	s.appRoute(http.MethodPut, appPath+"/env", authz.AppEnvWrite, s.putEnv)
	s.appRoute(http.MethodGet, appPath+"/secrets", authz.AppRead, s.listSecrets)
	s.appRoute(http.MethodPut, appPath+"/secrets/{name}", authz.AppSecretsWrite, s.putSecret)
	s.appRoute(http.MethodDelete, appPath+"/secrets/{name}", authz.AppSecretsWrite, s.deleteSecret)
	s.appRoute(http.MethodGet, appPath+"/schedules", authz.AppRead, s.listSchedules)
	s.appRoute(http.MethodPost, appPath+"/schedules", authz.AppSchedulesWrite, s.createSchedule)
	s.appRoute(http.MethodPatch, appPath+"/schedules/{id}", authz.AppSchedulesWrite, s.patchSchedule)
	s.appRoute(http.MethodDelete, appPath+"/schedules/{id}", authz.AppSchedulesWrite, s.deleteSchedule)
	s.appRoute(http.MethodGet, appPath+"/queue", authz.AppRead, s.getQueue)
	s.appRoute(http.MethodPost, appPath+"/queue", authz.AppQueueWrite, s.enqueue)
	s.appRoute(http.MethodGet, appPath+"/dlq", authz.AppRead, s.listDLQ)
	s.appRoute(http.MethodDelete, appPath+"/dlq", authz.AppQueueWrite, s.purgeDLQ)
	s.appRoute(http.MethodPost, appPath+"/dlq/redrive", authz.AppQueueWrite, s.redriveDLQ)

	s.appRoute(http.MethodGet, appPath+"/domains", authz.AppRead, s.listDomains)
	s.appRoute(http.MethodPost, appPath+"/domains", authz.DomainsManage, s.addDomain)
	s.appRoute(http.MethodPost, appPath+"/domains/{id}/verify", authz.DomainsManage, s.verifyDomain)
	s.appRoute(http.MethodDelete, appPath+"/domains/{id}", authz.DomainsManage, s.removeDomain)
}

// ifMatch returns the If-Match entity tag in the runtime's quoted form; "" when the header is missing,
// which the apps service turns into 428 precondition_required.
func ifMatch(r *http.Request) string {
	return quoteETag(strings.TrimPrefix(strings.TrimSpace(r.Header.Get("If-Match")), "W/"))
}

// quoteETag returns etag as a quoted entity tag, "" when there is none.
func quoteETag(etag string) string {
	if etag == "" || strings.HasPrefix(etag, `"`) {
		return etag
	}
	return `"` + etag + `"`
}

// offsetPage pages an in-memory list. The cursor is the offset of the next item.
func offsetPage[T any](items []T, cursor string, limit int) (pageJSON[T], error) {
	if items == nil {
		items = []T{}
	}
	start := 0
	if cursor != "" {
		n, err := strconv.Atoi(cursor)
		if err != nil || n < 0 {
			return pageJSON[T]{}, invalid(fieldErrors{"cursor": "is not valid"})
		}
		start = min(n, len(items))
	}
	end := min(start+limit, len(items))
	next := ""
	if end < len(items) {
		next = strconv.Itoa(end)
	}
	return pageJSON[T]{Items: items[start:end], NextCursor: nextCursor(next)}, nil
}

// appStatusJSON is the status of AppView: the summary fields plus inflight and admission.
type appStatusJSON struct {
	BuildState string             `json:"build_state"`
	Tier       string             `json:"tier"`
	LastError  *string            `json:"last_error"`
	Inflight   int                `json:"inflight"`
	Admission  *runtime.Admission `json:"admission"`
}

// appJSON is the AppView shape of api-web.md section 8.1. Runtime blocks pass through unchanged.
type appJSON struct {
	Slug        string          `json:"slug"`
	Name        *string         `json:"name"`
	Project     string          `json:"project"`
	Environment string          `json:"environment"`
	LiveVersion *int            `json:"live_version"`
	ETag        string          `json:"etag"`
	Runtime     string          `json:"runtime"`
	Profile     *string         `json:"profile"`
	Access      string          `json:"access"`
	URL         string          `json:"url"`
	Scaling     json.RawMessage `json:"scaling"`
	Ingress     json.RawMessage `json:"ingress"`
	Egress      json.RawMessage `json:"egress"`
	Call        json.RawMessage `json:"call"`
	Triggers    json.RawMessage `json:"triggers"`
	Status      appStatusJSON   `json:"status"`
	Limits      apps.Limits     `json:"limits"`
}

// writeApp writes an app with its ETag header.
func (s *Server) writeApp(w http.ResponseWriter, status int, v apps.AppView) {
	svc := v.Raw
	if etag := quoteETag(v.ETag); etag != "" {
		w.Header().Set("ETag", etag)
	}
	writeJSON(w, status, appJSON{
		Slug: svc.Slug, Name: svc.Name, Project: svc.Project, Environment: svc.Environment,
		LiveVersion: svc.LiveVersion, ETag: v.ETag, Runtime: svc.Runtime, Profile: svc.Profile, Access: svc.Access,
		URL:     strings.TrimSuffix(s.deps.RuntimePublicURL, "/") + "/s/" + svc.Slug + "/",
		Scaling: svc.Scaling, Ingress: svc.Ingress, Egress: svc.Egress, Call: svc.Call, Triggers: svc.Triggers,
		Status: appStatusJSON{
			BuildState: v.Status.BuildState, Tier: v.Status.Tier, LastError: v.Status.LastError,
			Inflight: svc.Status.Inflight, Admission: svc.Status.Admission,
		},
		Limits: v.Limits,
	})
}

func (s *Server) listApps(w http.ResponseWriter, r *http.Request, c orgCall) error {
	cursor, limit, err := listParams(r)
	if err != nil {
		return err
	}
	q := r.URL.Query()
	list, err := s.deps.Apps.List(r.Context(), c.sub, c.org.ID, q.Get("project"), q.Get("environment"))
	if err != nil {
		return err
	}
	page, err := offsetPage(list, cursor, limit)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, page)
	return nil
}

// appCreateJSON is the AppCreate body.
type appCreateJSON struct {
	Project     string  `json:"project"`
	Environment string  `json:"environment"`
	Slug        string  `json:"slug"`
	Template    string  `json:"template"`
	Name        *string `json:"name"`
}

func (s *Server) createApp(w http.ResponseWriter, r *http.Request, c orgCall) error {
	var in appCreateJSON
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	fields := fieldErrors{}
	for name, v := range map[string]string{"project": in.Project, "environment": in.Environment, "slug": in.Slug, "template": in.Template} {
		if v == "" {
			fields[name] = "is required"
		}
	}
	if len(fields) > 0 {
		return invalid(fields)
	}
	ctx := r.Context()
	v, err := s.deps.Apps.Create(ctx, c.sub, c.org.ID, in.Project, in.Environment, in.Slug, in.Template)
	if err != nil {
		return err
	}
	if in.Name != nil {
		if v, err = s.deps.Apps.Update(ctx, c.sub, c.org.ID, in.Slug, apps.AppPatch{Name: in.Name}, v.ETag); err != nil {
			return err
		}
	}
	if err := s.auditProject(ctx, c, "app.create", in.Slug, map[string]string{
		"project": in.Project, "environment": in.Environment, "template": in.Template,
	}); err != nil {
		return err
	}
	s.writeApp(w, http.StatusCreated, v)
	return nil
}

func (s *Server) getApp(w http.ResponseWriter, r *http.Request, c orgCall) error {
	v, err := s.deps.Apps.Get(r.Context(), c.sub, c.org.ID, r.PathValue("app"))
	if err != nil {
		return err
	}
	s.writeApp(w, http.StatusOK, v)
	return nil
}

// ingressJSON is the web shape of the ingress block; it maps to the runtime block on write.
type ingressJSON struct {
	Methods      []string        `json:"methods"`
	PathPrefixes []string        `json:"path_prefixes"`
	IPAllow      []string        `json:"ip_allow"`
	RateLimit    json.RawMessage `json:"rate_limit"`
}

// appPatchJSON is the AppPatch body. A present block replaces the whole runtime block.
type appPatchJSON struct {
	Name    *string         `json:"name"`
	Profile *string         `json:"profile"`
	Access  *string         `json:"access"`
	Scaling json.RawMessage `json:"scaling"`
	Ingress *ingressJSON    `json:"ingress"`
	Egress  json.RawMessage `json:"egress"`
	Call    *struct {
		AllowedCallers []string `json:"allowed_callers"`
	} `json:"call"`
	Limits json.RawMessage `json:"limits"`
}

func (s *Server) patchApp(w http.ResponseWriter, r *http.Request, c orgCall) error {
	var in appPatchJSON
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	if in.Access != nil && !slices.Contains(appAccessModes, *in.Access) {
		return invalid(fieldErrors{"access": "must be public, key or internal"})
	}
	patch := apps.AppPatch{Name: in.Name, Profile: in.Profile, Access: in.Access,
		Scaling: in.Scaling, Egress: in.Egress, Limits: in.Limits}
	if in.Ingress != nil {
		patch.Ingress = &apps.Ingress{Methods: in.Ingress.Methods, PathPrefixes: in.Ingress.PathPrefixes,
			IPAllow: in.Ingress.IPAllow, RateLimit: in.Ingress.RateLimit}
	}
	if in.Call != nil {
		patch.Call = &apps.Call{AllowedCallers: in.Call.AllowedCallers}
	}
	slug := r.PathValue("app")
	v, err := s.deps.Apps.Update(r.Context(), c.sub, c.org.ID, slug, patch, ifMatch(r))
	if err != nil {
		return err
	}
	if err := s.auditProject(r.Context(), c, "app.update", slug, map[string]bool{
		"name": in.Name != nil, "profile": in.Profile != nil, "access": in.Access != nil,
		"scaling": in.Scaling != nil, "ingress": in.Ingress != nil, "egress": in.Egress != nil,
		"call": in.Call != nil, "limits": in.Limits != nil,
	}); err != nil {
		return err
	}
	s.writeApp(w, http.StatusOK, v)
	return nil
}

// deleteApp deletes the app, then its custom domains. The app delete is authorised first, so a caller
// who may not delete the app removes no domains.
func (s *Server) deleteApp(w http.ResponseWriter, r *http.Request, c orgCall) error {
	ctx := r.Context()
	slug := r.PathValue("app")
	app, err := s.deps.Apps.Resolve(ctx, c.org.ID, slug)
	if err != nil {
		return err
	}
	if err := s.deps.Apps.Delete(ctx, c.sub, c.org.ID, slug); err != nil {
		return err
	}
	if err := s.deps.Domains.RemoveApp(ctx, c.sub, c.org.ID, app.SvcID); err != nil {
		return err
	}
	if err := s.auditProject(ctx, c, "app.delete", slug, nil); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// filesJSON is the Files shape of section 8.2 with the version number.
type filesJSON struct {
	Version int `json:"version"`
	apps.Files
}

func (s *Server) getFiles(w http.ResponseWriter, r *http.Request, c orgCall) error {
	ctx := r.Context()
	slug := r.PathValue("app")
	version := 0
	if raw := r.URL.Query().Get("version"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			return invalid(fieldErrors{"version": "must be a positive integer"})
		}
		version = n
	}
	files, err := s.deps.Apps.Files(ctx, c.sub, c.org.ID, slug, version)
	if err != nil {
		return err
	}
	if version == 0 {
		v, err := s.deps.Apps.Get(ctx, c.sub, c.org.ID, slug)
		if err != nil {
			return err
		}
		if v.Raw.LiveVersion != nil {
			version = *v.Raw.LiveVersion
		}
	}
	writeJSON(w, http.StatusOK, filesJSON{Version: version, Files: files})
	return nil
}

// filesBody is the PUT files body.
type filesBody struct {
	Entry string            `json:"entry"`
	Files map[string]string `json:"files"`
}

// saveJSON is the save response: the new version and its ETag.
type saveJSON struct {
	Version apps.Version `json:"version"`
	ETag    string       `json:"etag"`
}

func (s *Server) putFiles(w http.ResponseWriter, r *http.Request, c orgCall) error {
	var in filesBody
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	slug := r.PathValue("app")
	ctx := r.Context()
	v, err := s.deps.Apps.Save(ctx, c.sub, c.org.ID, slug, apps.Files{Entry: in.Entry, Files: in.Files}, ifMatch(r))
	if err != nil {
		return err
	}
	if err := s.auditProject(ctx, c, "app.deploy", slug, map[string]int{"version": v.Version}); err != nil {
		return err
	}
	if etag := quoteETag(v.ETag); etag != "" {
		w.Header().Set("ETag", etag)
	}
	writeJSON(w, http.StatusOK, saveJSON{Version: v, ETag: v.ETag})
	return nil
}

func (s *Server) listVersions(w http.ResponseWriter, r *http.Request, c orgCall) error {
	list, err := s.deps.Apps.Versions(r.Context(), c.sub, c.org.ID, r.PathValue("app"))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, itemsJSON[apps.Version]{Items: nonNil(list)})
	return nil
}

// liveBody is the PUT live body.
type liveBody struct {
	Version int `json:"version"`
}

func (s *Server) putLive(w http.ResponseWriter, r *http.Request, c orgCall) error {
	var in liveBody
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	slug := r.PathValue("app")
	v, err := s.deps.Apps.Promote(ctx, c.sub, c.org.ID, slug, in.Version, ifMatch(r))
	if err != nil {
		return err
	}
	if err := s.auditProject(ctx, c, "app.live", slug, map[string]int{"version": v.Version}); err != nil {
		return err
	}
	if etag := quoteETag(v.ETag); etag != "" {
		w.Header().Set("ETag", etag)
	}
	writeJSON(w, http.StatusOK, map[string]any{"live_version": v.Version, "etag": v.ETag})
	return nil
}

// versionParam reads the {v} path value.
func versionParam(r *http.Request) (int, error) {
	n, err := strconv.Atoi(r.PathValue("v"))
	if err != nil || n < 1 {
		return 0, invalid(fieldErrors{"v": "must be a positive integer"})
	}
	return n, nil
}

func (s *Server) buildLogs(w http.ResponseWriter, r *http.Request, c orgCall) error {
	n, err := versionParam(r)
	if err != nil {
		return err
	}
	lines, err := s.deps.Apps.BuildLogs(r.Context(), c.sub, c.org.ID, r.PathValue("app"), n)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, itemsJSON[apps.LogLine]{Items: nonNil(lines)})
	return nil
}

func (s *Server) rebuildVersion(w http.ResponseWriter, r *http.Request, c orgCall) error {
	n, err := versionParam(r)
	if err != nil {
		return err
	}
	slug := r.PathValue("app")
	ctx := r.Context()
	v, err := s.deps.Apps.Rebuild(ctx, c.sub, c.org.ID, slug, n)
	if err != nil {
		return err
	}
	if err := s.auditProject(ctx, c, "app.rebuild", slug, map[string]int{"version": n}); err != nil {
		return err
	}
	writeJSON(w, http.StatusAccepted, v)
	return nil
}

func (s *Server) listEvents(w http.ResponseWriter, r *http.Request, c orgCall) error {
	cursor, _, err := listParams(r)
	if err != nil {
		return err
	}
	page, err := s.deps.Apps.Events(r.Context(), c.sub, c.org.ID, r.PathValue("app"), cursor)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, pageJSON[runtime.Event]{Items: nonNil(page.Items), NextCursor: page.NextCursor})
	return nil
}

func (s *Server) appStats(w http.ResponseWriter, r *http.Request, c orgCall) error {
	window := r.URL.Query().Get("window")
	if window == "" {
		window = "5m"
	}
	if !slices.Contains([]string{"5m", "1h", "24h"}, window) {
		return invalid(fieldErrors{"window": "must be 5m, 1h or 24h"})
	}
	raw, err := s.deps.Apps.Stats(r.Context(), c.sub, c.org.ID, r.PathValue("app"), window)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, raw)
	return nil
}

// envBody is the env map; PUT replaces it whole.
type envBody struct {
	Env map[string]string `json:"env"`
}

func (s *Server) getEnv(w http.ResponseWriter, r *http.Request, c orgCall) error {
	env, err := s.deps.Apps.Env(r.Context(), c.sub, c.org.ID, r.PathValue("app"))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, envBody{Env: nonNilMap(env)})
	return nil
}

func (s *Server) putEnv(w http.ResponseWriter, r *http.Request, c orgCall) error {
	var in envBody
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	slug := r.PathValue("app")
	env, err := s.deps.Apps.SetEnv(ctx, c.sub, c.org.ID, slug, nonNilMap(in.Env))
	if err != nil {
		return err
	}
	if err := s.auditProject(ctx, c, "app.env.write", slug, map[string]int{"keys": len(env)}); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, envBody{Env: nonNilMap(env)})
	return nil
}

func (s *Server) listSecrets(w http.ResponseWriter, r *http.Request, c orgCall) error {
	list, err := s.deps.Apps.Secrets(r.Context(), c.sub, c.org.ID, r.PathValue("app"))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, itemsJSON[runtime.SecretName]{Items: nonNil(list)})
	return nil
}

// secretBody is the write-only secret value.
type secretBody struct {
	Value string `json:"value"`
}

func (s *Server) putSecret(w http.ResponseWriter, r *http.Request, c orgCall) error {
	var in secretBody
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	slug, name := r.PathValue("app"), r.PathValue("name")
	if err := s.deps.Apps.SetSecret(ctx, c.sub, c.org.ID, slug, name, in.Value); err != nil {
		return err
	}
	if err := s.auditProject(ctx, c, "app.secret.set", slug, map[string]string{"name": name}); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) deleteSecret(w http.ResponseWriter, r *http.Request, c orgCall) error {
	ctx := r.Context()
	slug, name := r.PathValue("app"), r.PathValue("name")
	if err := s.deps.Apps.DeleteSecret(ctx, c.sub, c.org.ID, slug, name); err != nil {
		return err
	}
	if err := s.auditProject(ctx, c, "app.secret.delete", slug, map[string]string{"name": name}); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) listSchedules(w http.ResponseWriter, r *http.Request, c orgCall) error {
	list, err := s.deps.Apps.Schedules(r.Context(), c.sub, c.org.ID, r.PathValue("app"))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, itemsJSON[runtime.Schedule]{Items: nonNil(list)})
	return nil
}

func (s *Server) createSchedule(w http.ResponseWriter, r *http.Request, c orgCall) error {
	var in runtime.ScheduleBody
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	slug := r.PathValue("app")
	sch, err := s.deps.Apps.CreateSchedule(ctx, c.sub, c.org.ID, slug, in)
	if err != nil {
		return err
	}
	if err := s.auditProject(ctx, c, "app.schedule.create", slug, map[string]string{"id": sch.ID, "kind": sch.Kind}); err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, sch)
	return nil
}

// schedulePatchJSON is the partial schedule body; the kind cannot change.
type schedulePatchJSON struct {
	Cron         *string         `json:"cron"`
	EverySeconds *int64          `json:"every_seconds"`
	Timezone     *string         `json:"timezone"`
	Payload      json.RawMessage `json:"payload"`
	Enabled      *bool           `json:"enabled"`
}

func (s *Server) patchSchedule(w http.ResponseWriter, r *http.Request, c orgCall) error {
	var in schedulePatchJSON
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	slug, id := r.PathValue("app"), r.PathValue("id")
	sch, err := s.deps.Apps.UpdateSchedule(ctx, c.sub, c.org.ID, slug, id, apps.SchedulePatch{
		Cron: in.Cron, EverySeconds: in.EverySeconds, Timezone: in.Timezone, Payload: in.Payload, Enabled: in.Enabled,
	})
	if err != nil {
		return err
	}
	if err := s.auditProject(ctx, c, "app.schedule.update", slug, map[string]string{"id": id}); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, sch)
	return nil
}

func (s *Server) deleteSchedule(w http.ResponseWriter, r *http.Request, c orgCall) error {
	ctx := r.Context()
	slug, id := r.PathValue("app"), r.PathValue("id")
	if err := s.deps.Apps.DeleteSchedule(ctx, c.sub, c.org.ID, slug, id); err != nil {
		return err
	}
	if err := s.auditProject(ctx, c, "app.schedule.delete", slug, map[string]string{"id": id}); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) getQueue(w http.ResponseWriter, r *http.Request, c orgCall) error {
	q, err := s.deps.Apps.Queue(r.Context(), c.sub, c.org.ID, r.PathValue("app"))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, q)
	return nil
}

func (s *Server) enqueue(w http.ResponseWriter, r *http.Request, c orgCall) error {
	var in runtime.EnqueueBody
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	id, err := s.deps.Apps.Enqueue(r.Context(), c.sub, c.org.ID, r.PathValue("app"), in)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, id)
	return nil
}

func (s *Server) listDLQ(w http.ResponseWriter, r *http.Request, c orgCall) error {
	list, err := s.deps.Apps.DLQ(r.Context(), c.sub, c.org.ID, r.PathValue("app"))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, itemsJSON[runtime.DLQItem]{Items: nonNil(list)})
	return nil
}

func (s *Server) purgeDLQ(w http.ResponseWriter, r *http.Request, c orgCall) error {
	if err := s.deps.Apps.PurgeDLQ(r.Context(), c.sub, c.org.ID, r.PathValue("app")); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) redriveDLQ(w http.ResponseWriter, r *http.Request, c orgCall) error {
	n, err := s.deps.Apps.RedriveDLQ(r.Context(), c.sub, c.org.ID, r.PathValue("app"))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, n)
	return nil
}

func (s *Server) listDomains(w http.ResponseWriter, r *http.Request, c orgCall) error {
	list, err := s.deps.Domains.List(r.Context(), c.sub, c.org.ID, r.PathValue("app"))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, itemsJSON[domains.Domain]{Items: nonNil(list)})
	return nil
}

// domainBody is the POST domains body.
type domainBody struct {
	Host string `json:"host"`
}

func (s *Server) addDomain(w http.ResponseWriter, r *http.Request, c orgCall) error {
	var in domainBody
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	d, err := s.deps.Domains.Add(r.Context(), c.sub, c.org.ID, r.PathValue("app"), in.Host)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, d)
	return nil
}

func (s *Server) verifyDomain(w http.ResponseWriter, r *http.Request, c orgCall) error {
	d, err := s.deps.Domains.Verify(r.Context(), c.sub, c.org.ID, r.PathValue("id"))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, d)
	return nil
}

func (s *Server) removeDomain(w http.ResponseWriter, r *http.Request, c orgCall) error {
	if err := s.deps.Domains.Remove(r.Context(), c.sub, c.org.ID, r.PathValue("id")); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// nonNil returns an empty slice for a nil one, so JSON shows [] rather than null.
func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

// nonNilMap returns an empty map for a nil one.
func nonNilMap(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}
