package runtimetest

import (
	"net/http"
	"slices"

	"github.com/21cloud/runtime-web/internal/runtime"
)

const (
	maxProjectsPerTenant = 100
	maxProjectEnvs       = 20
)

// project groups a tenant's services and lists their environments.
type project struct {
	id, tenantID, slug, name string
	environments             []string
	createdAt, updatedAt     int64
}

func newProject(tenantID, slug, name string, envs []string) *project {
	now := nowMS()
	return &project{
		id: newID("prj_"), tenantID: tenantID, slug: slug, name: name,
		environments: slices.Clone(envs), createdAt: now, updatedAt: now,
	}
}

func (pr *project) view() runtime.Project {
	return runtime.Project{
		ID: pr.id, TenantID: pr.tenantID, Slug: pr.slug, Name: pr.name,
		Environments: pr.environments, CreatedAt: pr.createdAt, UpdatedAt: pr.updatedAt,
	}
}

// projectFor resolves a slug or prj_ id within tenantID; nil when absent.
func (f *Fake) projectFor(tenantID, ref string) *project {
	if pr := f.projects[ref]; pr != nil && pr.tenantID == tenantID {
		return pr
	}
	for _, pr := range f.projects {
		if pr.tenantID == tenantID && pr.slug == ref {
			return pr
		}
	}
	return nil
}

// projectList returns the tenant's projects sorted by slug.
func (f *Fake) projectList(tenantID string) []*project {
	var out []*project
	for _, pr := range f.projects {
		if pr.tenantID == tenantID {
			out = append(out, pr)
		}
	}
	slices.SortFunc(out, func(a, b *project) int {
		switch {
		case a.slug < b.slug:
			return -1
		case a.slug > b.slug:
			return 1
		}
		return 0
	})
	return out
}

// serviceCount counts the tenant's services placed in the project slug.
func (f *Fake) serviceCount(tenantID, slug string) int {
	n := 0
	for _, s := range f.services {
		if s.tenantID == tenantID && s.project == slug {
			n++
		}
	}
	return n
}

func (f *Fake) projectRoutes(mux *http.ServeMux) {
	f.route(mux, "GET /v1/projects", "services:read", f.listProjects)
	f.route(mux, "POST /v1/projects", "services:write", f.createProject)
	f.route(mux, "GET /v1/projects/{p}", "services:read", f.getProject)
	f.route(mux, "PATCH /v1/projects/{p}", "services:write", f.patchProject)
	f.route(mux, "DELETE /v1/projects/{p}", "services:write", f.deleteProject)
	f.route(mux, "GET /v1/projects/{p}/environments", "services:read", f.projectEnvironments)
}

// projectTenant returns the acting tenant. Writes also need a key that is not
// limited to some services.
func projectTenant(p principal, write bool) (string, *apiError) {
	if p.tenant == "" {
		return "", invalid("x-rt-tenant is required")
	}
	if write && p.key != nil && len(p.key.serviceIDs) > 0 {
		return "", insufficientScope(nil)
	}
	return p.tenant, nil
}

// validEnvironments checks a complete environment list: 1 to 20 distinct labels.
func validEnvironments(envs []string) *apiError {
	if len(envs) == 0 || len(envs) > maxProjectEnvs {
		return invalid("environments must hold 1 to %d labels", maxProjectEnvs)
	}
	seen := map[string]bool{}
	for _, e := range envs {
		if !envRE.MatchString(e) {
			return invalid("environment %q is not valid", e)
		}
		if seen[e] {
			return invalid("environment %q is repeated", e)
		}
		seen[e] = true
	}
	return nil
}

func (f *Fake) listProjects(p principal, w http.ResponseWriter, _ *http.Request) *apiError {
	tid, e := projectTenant(p, false)
	if e != nil {
		return e
	}
	items := []runtime.Project{}
	for _, pr := range f.projectList(tid) {
		items = append(items, pr.view())
	}
	writeJSON(w, http.StatusOK, runtime.Page[runtime.Project]{Items: items})
	return nil
}

func (f *Fake) createProject(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	tid, e := projectTenant(p, true)
	if e != nil {
		return e
	}
	var in runtime.ProjectCreate
	if e := decode(r, &in); e != nil {
		return e
	}
	if !slugRE.MatchString(in.Slug) {
		return invalid("slug %q is not valid", in.Slug)
	}
	envs := in.Environments
	if len(envs) == 0 {
		envs = []string{"production"}
	}
	if e := validEnvironments(envs); e != nil {
		return e
	}
	if f.projectFor(tid, in.Slug) != nil {
		return conflict("project_slug_taken", "project slug is already in use")
	}
	if len(f.projectList(tid)) >= maxProjectsPerTenant {
		return forbidden("quota_exceeded", "plan project limit reached", map[string]any{"quota": "projects"})
	}
	name := in.Slug
	if in.Name != nil && *in.Name != "" {
		name = *in.Name
	}
	pr := newProject(tid, in.Slug, name, envs)
	f.projects[pr.id] = pr
	writeJSON(w, http.StatusCreated, pr.view())
	return nil
}

// projectOf resolves the {p} path value for the acting tenant.
func (f *Fake) projectOf(p principal, write bool, ref string) (*project, *apiError) {
	tid, e := projectTenant(p, write)
	if e != nil {
		return nil, e
	}
	pr := f.projectFor(tid, ref)
	if pr == nil {
		return nil, notFound()
	}
	return pr, nil
}

func (f *Fake) getProject(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	pr, e := f.projectOf(p, false, r.PathValue("p"))
	if e != nil {
		return e
	}
	writeJSON(w, http.StatusOK, pr.view())
	return nil
}

// patchProject replaces the given fields. Dropping an environment a service is
// in is a conflict.
func (f *Fake) patchProject(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	pr, e := f.projectOf(p, true, r.PathValue("p"))
	if e != nil {
		return e
	}
	var in runtime.ProjectPatch
	if e := decode(r, &in); e != nil {
		return e
	}
	if in.Environments != nil {
		if e := validEnvironments(in.Environments); e != nil {
			return e
		}
		for _, s := range f.services {
			if s.tenantID == pr.tenantID && s.project == pr.slug && !slices.Contains(in.Environments, s.environment) {
				return conflict("environment_in_use", "a service runs in environment "+s.environment)
			}
		}
		pr.environments = slices.Clone(in.Environments)
	}
	if in.Name != nil {
		pr.name = *in.Name
	}
	pr.updatedAt = nowMS()
	writeJSON(w, http.StatusOK, pr.view())
	return nil
}

func (f *Fake) deleteProject(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	pr, e := f.projectOf(p, true, r.PathValue("p"))
	if e != nil {
		return e
	}
	if f.serviceCount(pr.tenantID, pr.slug) > 0 {
		return conflict("project_not_empty", "project still holds services")
	}
	delete(f.projects, pr.id)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (f *Fake) projectEnvironments(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	pr, e := f.projectOf(p, false, r.PathValue("p"))
	if e != nil {
		return e
	}
	writeJSON(w, http.StatusOK, runtime.ProjectEnvironments{Project: pr.slug, Environments: pr.environments})
	return nil
}
