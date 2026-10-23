package apps

import (
	"context"
	"fmt"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/runtime"
	"github.com/21cloud/runtime-web/internal/store/db"
)

// Project is a project as the caller sees it. Role is the caller's effective project role (org
// owners and admins, and instance admins, are "admin").
type Project struct {
	Slug         string   `json:"slug"`
	Name         string   `json:"name"`
	Environments []string `json:"environments"`
	CreatedAt    int64    `json:"created_at"`
	UpdatedAt    int64    `json:"updated_at"`
	Role         string   `json:"role"`
}

func projectFrom(sub authz.Subject, p runtime.Project) Project {
	role := sub.ProjectRoles[p.Slug]
	if authz.Can(sub, authz.ProjectCreate, "") { // org owner/admin or instance admin
		role = authz.RoleAdmin
	}
	return Project{Slug: p.Slug, Name: p.Name, Environments: p.Environments, CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt, Role: role}
}

// ListProjects returns the org's projects the caller may read; members see granted projects only.
func (s *Service) ListProjects(ctx context.Context, sub authz.Subject, orgID string) ([]Project, error) {
	if err := member(sub); err != nil {
		return nil, err
	}
	cli, err := s.client(ctx, orgID)
	if err != nil {
		return nil, err
	}
	out := []Project{}
	cursor := ""
	for {
		page, err := cli.ListProjects(ctx, cursor)
		if err != nil {
			return nil, mapErr("list projects", err)
		}
		for _, p := range page.Items {
			if authz.Can(sub, authz.ProjectRead, p.Slug) {
				out = append(out, projectFrom(sub, p))
			}
		}
		if page.NextCursor == nil || *page.NextCursor == "" {
			return out, nil
		}
		cursor = *page.NextCursor
	}
}

// GetProject returns one project.
func (s *Service) GetProject(ctx context.Context, sub authz.Subject, orgID, slug string) (Project, error) {
	if err := authorize(sub, authz.ProjectRead, authz.ProjectRead, slug); err != nil {
		return Project{}, err
	}
	cli, err := s.client(ctx, orgID)
	if err != nil {
		return Project{}, err
	}
	p, err := cli.GetProject(ctx, slug)
	if err != nil {
		return Project{}, mapErr("get project "+slug, err)
	}
	return projectFrom(sub, p), nil
}

// CreateProject creates a project. Empty name and nil envs take the runtime defaults. A slug in use in
// the org is apperr.Conflict{slug_taken}.
func (s *Service) CreateProject(ctx context.Context, sub authz.Subject, orgID, slug, name string, envs []string) (Project, error) {
	if err := member(sub); err != nil {
		return Project{}, err
	}
	if !authz.Can(sub, authz.ProjectCreate, "") {
		return Project{}, fmt.Errorf("apps: create project: %w", apperr.ErrForbidden)
	}
	cli, err := s.client(ctx, orgID)
	if err != nil {
		return Project{}, err
	}
	in := runtime.ProjectCreate{Slug: slug, Environments: envs}
	if name != "" {
		in.Name = &name
	}
	p, err := cli.CreateProject(ctx, in)
	if err != nil {
		return Project{}, mapErr("create project "+slug, err)
	}
	return projectFrom(sub, p), nil
}

// UpdateProject renames a project and/or replaces its environment list (nil leaves it).
func (s *Service) UpdateProject(ctx context.Context, sub authz.Subject, orgID, slug string, name *string, envs []string) (Project, error) {
	if err := authorize(sub, authz.ProjectUpdate, authz.ProjectRead, slug); err != nil {
		return Project{}, err
	}
	cli, err := s.client(ctx, orgID)
	if err != nil {
		return Project{}, err
	}
	p, err := cli.UpdateProject(ctx, slug, runtime.ProjectPatch{Name: name, Environments: envs})
	if err != nil {
		return Project{}, mapErr("update project "+slug, err)
	}
	return projectFrom(sub, p), nil
}

// DeleteProject deletes an empty project; one that still holds apps is
// apperr.Conflict{project_not_empty}.
func (s *Service) DeleteProject(ctx context.Context, sub authz.Subject, orgID, slug string) error {
	if err := authorize(sub, authz.ProjectDelete, authz.ProjectRead, slug); err != nil {
		return err
	}
	cli, err := s.client(ctx, orgID)
	if err != nil {
		return err
	}
	if err := cli.DeleteProject(ctx, slug); err != nil {
		return mapErr("delete project "+slug, err)
	}
	if _, err := s.st.Q().DeleteGrantsForProject(ctx, db.DeleteGrantsForProjectParams{OrgID: orgID, ProjectSlug: slug}); err != nil {
		return fmt.Errorf("apps: delete grants of %s: %w", slug, err)
	}
	return nil
}

// ListEnvironments returns a project's environments.
func (s *Service) ListEnvironments(ctx context.Context, sub authz.Subject, orgID, slug string) ([]string, error) {
	if err := authorize(sub, authz.ProjectRead, authz.ProjectRead, slug); err != nil {
		return nil, err
	}
	return s.environments(ctx, orgID, slug)
}

func (s *Service) environments(ctx context.Context, orgID, slug string) ([]string, error) {
	cli, err := s.client(ctx, orgID)
	if err != nil {
		return nil, err
	}
	e, err := cli.GetProjectEnvironments(ctx, slug)
	if err != nil {
		return nil, mapErr("environments of "+slug, err)
	}
	return e.Environments, nil
}
