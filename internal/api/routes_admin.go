package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/21cloud/runtime-web/internal/admin"
	"github.com/21cloud/runtime-web/internal/audit"
	"github.com/21cloud/runtime-web/internal/auth"
	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/orgs"
	"github.com/21cloud/runtime-web/internal/store/db"
	"github.com/21cloud/runtime-web/internal/users"
)

// registerAdminRoutes wires the instance-admin routes of api-web.md §6. Every route requires an
// instance admin; the session chain enforces it.
func (s *Server) registerAdminRoutes() {
	ia := authz.InstanceAdmin
	s.route(http.MethodGet, "/api/admin/users", ia, s.listAdminUsers)
	s.route(http.MethodPost, "/api/admin/users", ia, s.createAdminUser)
	s.route(http.MethodPatch, "/api/admin/users/{id}", ia, s.updateAdminUser)
	s.route(http.MethodDelete, "/api/admin/users/{id}", ia, s.deleteAdminUser)
	s.route(http.MethodPost, "/api/admin/users/{id}/reset-password", ia, s.resetAdminPassword)
	s.route(http.MethodDelete, "/api/admin/users/{id}/totp", ia, s.resetAdminTOTP)

	s.route(http.MethodGet, "/api/admin/orgs", ia, s.listAdminOrgs)
	s.route(http.MethodPost, "/api/admin/orgs", ia, s.createAdminOrg)
	s.route(http.MethodPatch, "/api/admin/orgs/{org}", ia, s.renameAdminOrg)
	s.route(http.MethodDelete, "/api/admin/orgs/{org}", ia, s.deleteAdminOrg)
	s.route(http.MethodGet, "/api/admin/orgs/{org}/usage", ia, s.getAdminOrgUsage)

	s.route(http.MethodGet, "/api/admin/node/status", ia, s.nodeStatus)
	s.route(http.MethodGet, "/api/admin/node/config", ia, s.nodeConfig)
	s.route(http.MethodPut, "/api/admin/node/config", ia, s.setNodeConfig)
	s.route(http.MethodGet, "/api/admin/node/scheduler", ia, s.nodeScheduler)
	s.route(http.MethodGet, "/api/admin/node/cache", ia, s.nodeCache)
	s.route(http.MethodGet, "/api/admin/node/version", ia, s.nodeVersion)
	s.route(http.MethodPost, "/api/admin/node/drain", ia, s.drainNode)

	s.route(http.MethodGet, "/api/admin/domains", ia, s.listAdminDomains)
	s.route(http.MethodGet, "/api/admin/audit", ia, s.listAdminAudit)
	s.route(http.MethodGet, "/api/admin/settings", ia, s.getSettings)
	s.route(http.MethodPut, "/api/admin/settings", ia, s.putSettings)
}

// adminUserJSON is the User shape of api-web.md §2 for a user from the users service.
func (s *Server) adminUserJSON(ctx context.Context, u users.User) (userJSON, error) {
	on, err := s.deps.Auth.TOTP.Enabled(ctx, u.ID)
	if err != nil {
		return userJSON{}, err
	}
	return userJSON{
		ID: u.ID, Email: u.Email, Name: u.Name, InstanceAdmin: u.IsInstanceAdmin,
		MustChangePassword: u.MustChangePassword, Disabled: u.Disabled, TOTPEnabled: on, CreatedAt: u.CreatedAt,
	}, nil
}

// listAdminUsers pages users by id after ?cursor, filtered by ?q against email and name.
func (s *Server) listAdminUsers(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	cursor, limit, err := listParams(r)
	if err != nil {
		return err
	}
	all, err := s.deps.Users.List(ctx)
	if err != nil {
		return err
	}
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	matched := make([]users.User, 0, len(all))
	for _, u := range all {
		if q == "" || strings.Contains(strings.ToLower(u.Email), q) || strings.Contains(strings.ToLower(u.Name), q) {
			matched = append(matched, u)
		}
	}
	start := 0
	if cursor != "" {
		start = -1
		for i, u := range matched {
			if u.ID == cursor {
				start = i + 1
				break
			}
		}
		if start < 0 {
			return invalid(fieldErrors{"cursor": "unknown cursor"})
		}
	}
	end := min(start+limit, len(matched))
	items := make([]userJSON, 0, end-start)
	for _, u := range matched[start:end] {
		v, err := s.adminUserJSON(ctx, u)
		if err != nil {
			return err
		}
		items = append(items, v)
	}
	next := ""
	if end < len(matched) && end > start {
		next = matched[end-1].ID
	}
	writeJSON(w, http.StatusOK, pageJSON[userJSON]{Items: items, NextCursor: nextCursor(next)})
	return nil
}

type createUserReq struct {
	Email         string `json:"email"`
	Name          string `json:"name"`
	InstanceAdmin bool   `json:"instance_admin"`
}

func (s *Server) createAdminUser(w http.ResponseWriter, r *http.Request) error {
	var in createUserReq
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	actor, err := actorFor(r)
	if err != nil {
		return err
	}
	u, temp, err := s.deps.Users.Create(r.Context(), actor, in.Email, in.Name, in.InstanceAdmin)
	if err != nil {
		return err
	}
	uj, err := s.adminUserJSON(r.Context(), u)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, map[string]any{"user": uj, "temp_password": temp})
	return nil
}

// updateUserReq is the PATCH body of an admin user. Absent fields are unchanged.
type updateUserReq struct {
	Name          *string `json:"name"`
	Disabled      *bool   `json:"disabled"`
	InstanceAdmin *bool   `json:"instance_admin"`
}

func (s *Server) updateAdminUser(w http.ResponseWriter, r *http.Request) error {
	var in updateUserReq
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	actor, err := actorFor(r)
	if err != nil {
		return err
	}
	u, err := s.deps.Users.Update(r.Context(), actor, r.PathValue("id"), users.Patch{
		Name: in.Name, Disabled: in.Disabled, InstanceAdmin: in.InstanceAdmin,
	})
	if err != nil {
		return err
	}
	uj, err := s.adminUserJSON(r.Context(), u)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, uj)
	return nil
}

func (s *Server) deleteAdminUser(w http.ResponseWriter, r *http.Request) error {
	actor, err := actorFor(r)
	if err != nil {
		return err
	}
	if err := s.deps.Users.Delete(r.Context(), actor, r.PathValue("id")); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) resetAdminPassword(w http.ResponseWriter, r *http.Request) error {
	actor, err := actorFor(r)
	if err != nil {
		return err
	}
	temp, err := s.deps.Users.ResetPassword(r.Context(), actor, r.PathValue("id"))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]string{"temp_password": temp})
	return nil
}

func (s *Server) resetAdminTOTP(w http.ResponseWriter, r *http.Request) error {
	actor, err := actorFor(r)
	if err != nil {
		return err
	}
	if err := s.deps.Users.ResetTOTP(r.Context(), actor, r.PathValue("id")); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// adminOrg resolves {org} (a slug) for the admin routes.
func (s *Server) adminOrg(r *http.Request) (orgs.Org, error) {
	return s.deps.Orgs.GetBySlug(r.Context(), r.PathValue("org"))
}

// adminOrgView is an org as the admin list shows it: the role is set only when the admin is a member.
func (s *Server) adminOrgView(r *http.Request, o orgs.Org) (orgJSON, error) {
	sub, err := instanceSubject(r)
	if err != nil {
		return orgJSON{}, err
	}
	m, err := s.deps.Orgs.Subject(r.Context(), sub.UserID, o.ID)
	if err != nil {
		return orgJSON{}, err
	}
	return orgView(o, m.OrgRole), nil
}

func (s *Server) listAdminOrgs(w http.ResponseWriter, r *http.Request) error {
	list, err := s.deps.Orgs.List(r.Context(), "")
	if err != nil {
		return err
	}
	items := make([]orgJSON, 0, len(list))
	for _, o := range list {
		v, err := s.adminOrgView(r, o)
		if err != nil {
			return err
		}
		items = append(items, v)
	}
	writeJSON(w, http.StatusOK, itemsJSON[orgJSON]{Items: items})
	return nil
}

type createOrgReq struct {
	Slug        string `json:"slug"`
	Name        string `json:"name"`
	OwnerUserID string `json:"owner_user_id"`
}

func (s *Server) createAdminOrg(w http.ResponseWriter, r *http.Request) error {
	var in createOrgReq
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	actor, err := actorFor(r)
	if err != nil {
		return err
	}
	o, err := s.deps.Orgs.Create(r.Context(), actor, in.Slug, in.Name, in.OwnerUserID)
	if err != nil {
		return err
	}
	v, err := s.adminOrgView(r, o)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, v)
	return nil
}

func (s *Server) renameAdminOrg(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Name string `json:"name"`
	}
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	o, err := s.adminOrg(r)
	if err != nil {
		return err
	}
	actor, err := actorFor(r)
	if err != nil {
		return err
	}
	if err := s.deps.Orgs.Rename(r.Context(), actor, o.ID, in.Name); err != nil {
		return err
	}
	o, err = s.deps.Orgs.Get(r.Context(), o.ID)
	if err != nil {
		return err
	}
	v, err := s.adminOrgView(r, o)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, v)
	return nil
}

func (s *Server) deleteAdminOrg(w http.ResponseWriter, r *http.Request) error {
	o, err := s.adminOrg(r)
	if err != nil {
		return err
	}
	actor, err := actorFor(r)
	if err != nil {
		return err
	}
	if err := s.deps.Orgs.Delete(r.Context(), actor, o.ID); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) getAdminOrgUsage(w http.ResponseWriter, r *http.Request) error {
	o, err := s.adminOrg(r)
	if err != nil {
		return err
	}
	sub, err := instanceSubject(r)
	if err != nil {
		return err
	}
	items, err := s.usageItems(r, sub, o)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, itemsJSON[usageJSON]{Items: items})
	return nil
}

// passthrough writes a runtime JSON object unchanged.
func passthrough(w http.ResponseWriter, raw json.RawMessage) error {
	writeJSON(w, http.StatusOK, raw)
	return nil
}

func (s *Server) nodeStatus(w http.ResponseWriter, r *http.Request) error {
	sub, err := instanceSubject(r)
	if err != nil {
		return err
	}
	st, err := s.deps.Admin.NodeStatus(r.Context(), sub)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, st)
	return nil
}

func (s *Server) nodeConfig(w http.ResponseWriter, r *http.Request) error {
	sub, err := instanceSubject(r)
	if err != nil {
		return err
	}
	raw, err := s.deps.Admin.NodeConfig(r.Context(), sub)
	if err != nil {
		return err
	}
	return passthrough(w, raw)
}

// setNodeConfig applies NodeConfigPatch. Any other field is a 422 (DecodeNodeConfigPatch).
func (s *Server) setNodeConfig(w http.ResponseWriter, r *http.Request) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	patch, err := admin.DecodeNodeConfigPatch(r.Body)
	if err != nil {
		return err
	}
	sub, err := instanceSubject(r)
	if err != nil {
		return err
	}
	out, err := s.deps.Admin.SetNodeConfig(r.Context(), sub, patch)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, out)
	return nil
}

func (s *Server) nodeScheduler(w http.ResponseWriter, r *http.Request) error {
	sub, err := instanceSubject(r)
	if err != nil {
		return err
	}
	raw, err := s.deps.Admin.Scheduler(r.Context(), sub)
	if err != nil {
		return err
	}
	return passthrough(w, raw)
}

func (s *Server) nodeCache(w http.ResponseWriter, r *http.Request) error {
	sub, err := instanceSubject(r)
	if err != nil {
		return err
	}
	raw, err := s.deps.Admin.Cache(r.Context(), sub)
	if err != nil {
		return err
	}
	return passthrough(w, raw)
}

func (s *Server) nodeVersion(w http.ResponseWriter, r *http.Request) error {
	sub, err := instanceSubject(r)
	if err != nil {
		return err
	}
	info, err := s.deps.Admin.Version(r.Context(), sub)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]string{"version": info.Version, "web_version": s.deps.WebVersion})
	return nil
}

// drainNode asks the node to drain. The body must confirm it with {confirm: "drain"}.
func (s *Server) drainNode(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Confirm string `json:"confirm"`
	}
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	if in.Confirm != "drain" {
		return invalid(fieldErrors{"confirm": `must be "drain"`})
	}
	sub, err := instanceSubject(r)
	if err != nil {
		return err
	}
	if err := s.deps.Admin.Drain(r.Context(), sub); err != nil {
		return err
	}
	writeJSON(w, http.StatusAccepted, map[string]any{})
	return nil
}

// adminDomainJSON is a custom domain with its owning org (api-web.md §6).
type adminDomainJSON struct {
	ID            string `json:"id"`
	Host          string `json:"host"`
	Project       string `json:"project"`
	Status        string `json:"status"`
	LastCheckedAt *int64 `json:"last_checked_at"`
	CreatedAt     int64  `json:"created_at"`
	Org           struct {
		Slug string `json:"slug"`
		Name string `json:"name"`
	} `json:"org"`
}

func (s *Server) listAdminDomains(w http.ResponseWriter, r *http.Request) error {
	sub, err := instanceSubject(r)
	if err != nil {
		return err
	}
	list, err := s.deps.Admin.Domains(r.Context(), sub)
	if err != nil {
		return err
	}
	items := make([]adminDomainJSON, 0, len(list))
	for _, d := range list {
		v := adminDomainJSON{ID: d.ID, Host: d.Host, Project: d.ProjectSlug, Status: d.Status,
			LastCheckedAt: d.LastCheckedAt, CreatedAt: d.CreatedAt}
		v.Org.Slug, v.Org.Name = d.Org.Slug, d.Org.Name
		items = append(items, v)
	}
	writeJSON(w, http.StatusOK, itemsJSON[adminDomainJSON]{Items: items})
	return nil
}

// listAdminAudit lists instance-wide audit entries; ?org narrows to one org by slug.
func (s *Server) listAdminAudit(w http.ResponseWriter, r *http.Request) error {
	var orgID *string
	if slug := r.URL.Query().Get("org"); slug != "" {
		o, err := s.deps.Orgs.GetBySlug(r.Context(), slug)
		if err != nil {
			return err
		}
		orgID = &o.ID
	}
	return s.writeAuditPage(w, r, orgID, r.URL.Query().Get("actor"))
}

// oauthProviderJSON is one OAuth provider of api-web.md §6. The client secret is write-only:
// only client_secret_set is returned.
type oauthProviderJSON struct {
	ID              string `json:"id"`
	Enabled         bool   `json:"enabled"`
	ClientID        string `json:"client_id"`
	ClientSecretSet bool   `json:"client_secret_set"`
	Issuer          string `json:"issuer,omitempty"`
	Name            string `json:"name,omitempty"`
}

// instanceSettingsJSON is the InstanceSettings shape of api-web.md §6.
type instanceSettingsJSON struct {
	PublicURL             string              `json:"public_url"`
	Require2FA            bool                `json:"require_2fa"`
	PasswordLoginDisabled bool                `json:"password_login_disabled"`
	Providers             []oauthProviderJSON `json:"providers"`
}

func (s *Server) settingsView(r *http.Request) (instanceSettingsJSON, error) {
	ctx := r.Context()
	pol, err := s.deps.Auth.Policy(ctx)
	if err != nil {
		return instanceSettingsJSON{}, err
	}
	settings, err := s.oauth().Settings(ctx)
	if err != nil {
		return instanceSettingsJSON{}, err
	}
	providers := make([]oauthProviderJSON, 0, len(settings))
	for _, ps := range settings {
		providers = append(providers, oauthProviderJSON{ID: ps.ID, Enabled: ps.Enabled, ClientID: ps.ClientID,
			ClientSecretSet: ps.SecretSet, Issuer: ps.Issuer, Name: ps.Name})
	}
	return instanceSettingsJSON{
		PublicURL: s.deps.PublicURL, Require2FA: pol.Require2FA,
		PasswordLoginDisabled: pol.PasswordLoginDisabled, Providers: providers,
	}, nil
}

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) error {
	v, err := s.settingsView(r)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, v)
	return nil
}

// settingsReq is InstanceSettingsWrite. Absent fields keep their stored value. A provider entry
// replaces that provider; an empty client_secret keeps the stored secret.
type settingsReq struct {
	Require2FA            *bool `json:"require_2fa"`
	PasswordLoginDisabled *bool `json:"password_login_disabled"`
	Providers             *[]struct {
		ID           string `json:"id"`
		Enabled      bool   `json:"enabled"`
		ClientID     string `json:"client_id"`
		ClientSecret string `json:"client_secret"`
		Issuer       string `json:"issuer"`
		Name         string `json:"name"`
	} `json:"providers"`
}

// putSettings saves the providers, then the policy and its audit row in one transaction.
// Password login cannot be disabled without an enabled provider (sso_not_configured, mapped to 422).
func (s *Server) putSettings(w http.ResponseWriter, r *http.Request) error {
	var in settingsReq
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	actor, err := actorFor(r)
	if err != nil {
		return err
	}
	changed := []string{}
	if in.Providers != nil {
		o := s.oauth()
		for _, p := range *in.Providers {
			if err := o.SetProvider(ctx, auth.ProviderConfig{ID: p.ID, Enabled: p.Enabled, ClientID: p.ClientID,
				ClientSecret: p.ClientSecret, Issuer: p.Issuer, Name: p.Name}); err != nil {
				return err
			}
			changed = append(changed, p.ID)
		}
	}
	pol, err := s.deps.Auth.Policy(ctx)
	if err != nil {
		return err
	}
	if in.Require2FA != nil {
		pol.Require2FA = *in.Require2FA
	}
	if in.PasswordLoginDisabled != nil {
		pol.PasswordLoginDisabled = *in.PasswordLoginDisabled
	}
	detail := map[string]any{"require_2fa": pol.Require2FA, "password_login_disabled": pol.PasswordLoginDisabled, "providers": changed}
	err = s.deps.Auth.SetPolicyWith(ctx, pol, func(q *db.Queries) error {
		return audit.Writer{}.Log(ctx, q, actor, "", "settings.update", "instance", detail)
	})
	if err != nil {
		return err
	}
	v, err := s.settingsView(r)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, v)
	return nil
}
