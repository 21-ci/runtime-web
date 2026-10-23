package api

import (
	"net/http"

	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/invites"
)

// registerInviteRoutes wires the invite routes of api-web.md §5.2. Management is by invite id and
// scoped to the org in the path (or instance-wide under /api/admin). The public accept routes take
// the single-use token instead of a session and CSRF token.
func (s *Server) registerInviteRoutes() {
	s.orgRoute(http.MethodGet, "/api/orgs/{org}/invites", authz.InvitesManage, s.listOrgInvites)
	s.orgRoute(http.MethodPost, "/api/orgs/{org}/invites", authz.InvitesManage, s.createOrgInvite)
	s.orgRoute(http.MethodDelete, "/api/orgs/{org}/invites/{id}", authz.InvitesManage, s.revokeOrgInvite)

	s.route(http.MethodGet, "/api/admin/invites", authz.InstanceAdmin, s.listAdminInvites)
	s.route(http.MethodPost, "/api/admin/invites", authz.InstanceAdmin, s.createAdminInvite)
	s.route(http.MethodDelete, "/api/admin/invites/{id}", authz.InstanceAdmin, s.revokeAdminInvite)

	s.routePublic(http.MethodGet, "/api/invites/accept/{token}", s.previewInvite)
	s.routePublic(http.MethodPost, "/api/invites/accept/{token}", s.acceptInvite)
}

// inviteJSON is the Invite shape of api-web.md §5.2.
type inviteJSON struct {
	ID        string            `json:"id"`
	Email     string            `json:"email"`
	Org       *inviteOrgJSON    `json:"org"`
	Role      *string           `json:"role"`
	CreatedBy inviteCreatorJSON `json:"created_by"`
	CreatedAt int64             `json:"created_at"`
	ExpiresAt int64             `json:"expires_at"`
}

type inviteOrgJSON struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
}

type inviteCreatorJSON struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func inviteView(inv invites.Invite) inviteJSON {
	v := inviteJSON{
		ID: inv.ID, Email: inv.Email, Role: inv.Role,
		CreatedBy: inviteCreatorJSON{ID: inv.CreatedBy, Name: inv.CreatedByName},
		CreatedAt: inv.CreatedAt, ExpiresAt: inv.ExpiresAt,
	}
	if inv.Org != nil {
		v.Org = &inviteOrgJSON{Slug: inv.Org.Slug, Name: inv.Org.Name}
	}
	return v
}

func inviteViews(list []invites.Invite) []inviteJSON {
	out := make([]inviteJSON, 0, len(list))
	for _, inv := range list {
		out = append(out, inviteView(inv))
	}
	return out
}

// inviteReq is InviteReq of api-web.md §5.2. Org is a slug and is read only by the admin routes.
type inviteReq struct {
	Email string `json:"email"`
	Org   string `json:"org"`
	Role  string `json:"role"`
}

// inviteCreated is the 201 body of an invite create: the invite and its link, shown once.
type inviteCreated struct {
	Invite inviteJSON `json:"invite"`
	Link   string     `json:"link"`
}

// optRole maps an empty role to nil, meaning the default role.
func optRole(role string) *string {
	if role == "" {
		return nil
	}
	return &role
}

func (s *Server) listOrgInvites(w http.ResponseWriter, r *http.Request, c orgCall) error {
	list, err := s.deps.Invites.List(r.Context(), c.org.ID)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, itemsJSON[inviteJSON]{Items: inviteViews(list)})
	return nil
}

func (s *Server) createOrgInvite(w http.ResponseWriter, r *http.Request, c orgCall) error {
	var in inviteReq
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	inv, link, err := s.deps.Invites.Create(r.Context(), c.actor, in.Email, &c.org.ID, optRole(in.Role))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, inviteCreated{Invite: inviteView(inv), Link: link})
	return nil
}

// revokeOrgInvite cancels an invite of this org. Another org's invite is 404.
func (s *Server) revokeOrgInvite(w http.ResponseWriter, r *http.Request, c orgCall) error {
	if err := s.deps.Invites.Revoke(r.Context(), c.actor, c.org.ID, r.PathValue("id")); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// listAdminInvites lists pending invites across orgs; ?org=<slug> narrows to one org.
func (s *Server) listAdminInvites(w http.ResponseWriter, r *http.Request) error {
	orgID := ""
	if slug := r.URL.Query().Get("org"); slug != "" {
		org, err := s.deps.Orgs.GetBySlug(r.Context(), slug)
		if err != nil {
			return err
		}
		orgID = org.ID
	}
	list, err := s.deps.Invites.List(r.Context(), orgID)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, itemsJSON[inviteJSON]{Items: inviteViews(list)})
	return nil
}

// createAdminInvite issues an invite, bound to the org named by slug or unbound when org is empty.
func (s *Server) createAdminInvite(w http.ResponseWriter, r *http.Request) error {
	var in inviteReq
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	actor, err := actorFor(r)
	if err != nil {
		return err
	}
	var orgID *string
	if in.Org != "" {
		org, err := s.deps.Orgs.GetBySlug(r.Context(), in.Org)
		if err != nil {
			return err
		}
		orgID = &org.ID
	}
	inv, link, err := s.deps.Invites.Create(r.Context(), actor, in.Email, orgID, optRole(in.Role))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, inviteCreated{Invite: inviteView(inv), Link: link})
	return nil
}

// revokeAdminInvite cancels any pending invite (instance scope).
func (s *Server) revokeAdminInvite(w http.ResponseWriter, r *http.Request) error {
	actor, err := actorFor(r)
	if err != nil {
		return err
	}
	if err := s.deps.Invites.Revoke(r.Context(), actor, "", r.PathValue("id")); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// invitePreviewJSON is what the public accept page shows: the invited email and the org name.
type invitePreviewJSON struct {
	Email   string  `json:"email"`
	OrgName *string `json:"org_name"`
}

// previewInvite reads a pending invite by token. It changes nothing.
func (s *Server) previewInvite(w http.ResponseWriter, r *http.Request) error {
	pv, err := s.deps.Invites.Preview(r.Context(), r.PathValue("token"))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, invitePreviewJSON{Email: pv.Email, OrgName: pv.OrgName})
	return nil
}

type acceptInviteReq struct {
	Name     string `json:"name"`
	Password string `json:"password"`
}

// acceptInviteResp: a new account gets a session (csrf is absent while the MFA step is pending).
// An existing account gets no session and no password change.
type acceptInviteResp struct {
	Email       string `json:"email"`
	MFARequired bool   `json:"mfa_required"`
	CSRF        string `json:"csrf,omitempty"`
}

// acceptInvite redeems a token. The caller's session, when there is one, identifies an existing
// account; otherwise the account is created from name and password.
func (s *Server) acceptInvite(w http.ResponseWriter, r *http.Request) error {
	var in acceptInviteReq
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	res, err := s.deps.Invites.Accept(r.Context(), r.PathValue("token"), s.optionalCallerID(r),
		in.Name, in.Password, clientIP(r), r.UserAgent())
	if err != nil {
		return err
	}
	if res.Existing {
		writeJSON(w, http.StatusOK, acceptInviteResp{Email: res.User.Email})
		return nil
	}
	s.deps.Auth.Sessions.SetCookie(w, res.Session.Cookie)
	writeJSON(w, http.StatusOK, acceptInviteResp{
		Email: res.User.Email, MFARequired: res.Session.MFARequired, CSRF: res.Session.CSRF,
	})
	return nil
}

// optionalCallerID returns the user id of a valid session on r, or "" when there is none.
func (s *Server) optionalCallerID(r *http.Request) string {
	c, err := r.Cookie(s.deps.Auth.Sessions.CookieName())
	if err != nil {
		return ""
	}
	_, u, err := s.deps.Auth.Sessions.Lookup(r.Context(), c.Value)
	if err != nil {
		return ""
	}
	return u.ID
}
