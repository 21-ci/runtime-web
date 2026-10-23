// Package authz decides what a user may do in an org: org roles, project grants keyed by project slug,
// and the instance admin override. It is pure logic with no I/O.
package authz

// Action is one permission in the closed set below.
type Action string

const (
	OrgRead           Action = "org.read"
	OrgUpdate         Action = "org.update"
	OrgDelete         Action = "org.delete"
	OrgAuditRead      Action = "org.audit.read"
	OrgUsageRead      Action = "org.usage.read"
	MembersManage     Action = "members.manage"
	MembersOwners     Action = "members.owners"
	InvitesManage     Action = "invites.manage"
	TokensManage      Action = "tokens.manage"
	DefaultKeyRotate  Action = "defaultkey.rotate"
	ProjectCreate     Action = "project.create"
	ProjectRead       Action = "project.read"
	ProjectUpdate     Action = "project.update"
	ProjectDelete     Action = "project.delete"
	GrantsManage      Action = "grants.manage"
	DomainsManage     Action = "domains.manage"
	AppRead           Action = "app.read"
	AppCreate         Action = "app.create"
	AppUpdate         Action = "app.update"
	AppDelete         Action = "app.delete"
	AppDeploy         Action = "app.deploy"
	AppEnvWrite       Action = "app.env.write"
	AppSecretsWrite   Action = "app.secrets.write"
	AppSchedulesWrite Action = "app.schedules.write"
	AppQueueWrite     Action = "app.queue.write"
	AppLogsRead       Action = "app.logs.read"
	AppDataExport     Action = "app.data.export"
	InstanceAdmin     Action = "instance.admin"
)

// Actions lists every Action.
var Actions = []Action{
	OrgRead, OrgUpdate, OrgDelete, OrgAuditRead, OrgUsageRead, MembersManage, MembersOwners, InvitesManage,
	TokensManage, DefaultKeyRotate, ProjectCreate, ProjectRead, ProjectUpdate, ProjectDelete, GrantsManage,
	DomainsManage, AppRead, AppCreate, AppUpdate, AppDelete, AppDeploy, AppEnvWrite, AppSecretsWrite,
	AppSchedulesWrite, AppQueueWrite, AppLogsRead, AppDataExport, InstanceAdmin,
}

// Org and project role names.
const (
	RoleOwner     = "owner"
	RoleAdmin     = "admin"
	RoleMember    = "member"
	RoleDeveloper = "developer"
	RoleViewer    = "viewer"
)

// Subject is the caller, resolved for one org.
type Subject struct {
	UserID        string
	InstanceAdmin bool
	OrgRole       string            // "" if not a member of the org
	ProjectRoles  map[string]string // project slug → project role
}

// level ranks a rule: who holds an action.
type level int

const (
	lvlInstance      level = iota // instance admin only
	lvlOwner                      // org owner
	lvlOrgAdmin                   // org owner or admin
	lvlOrgMember                  // any org member
	lvlProjAdmin                  // project admin grant (org owner/admin implied)
	lvlProjDeveloper              // project developer grant or higher
	lvlProjViewer                 // project viewer grant or higher
)

var rules = map[Action]level{
	OrgRead:           lvlOrgMember,
	OrgUpdate:         lvlOrgAdmin,
	OrgDelete:         lvlOwner,
	OrgAuditRead:      lvlOrgAdmin,
	OrgUsageRead:      lvlOrgAdmin,
	MembersManage:     lvlOrgAdmin,
	MembersOwners:     lvlOwner,
	InvitesManage:     lvlOrgAdmin,
	TokensManage:      lvlOrgAdmin,
	DefaultKeyRotate:  lvlOrgAdmin,
	ProjectCreate:     lvlOrgAdmin,
	ProjectRead:       lvlProjViewer,
	ProjectUpdate:     lvlProjAdmin,
	ProjectDelete:     lvlOrgAdmin,
	GrantsManage:      lvlProjAdmin,
	DomainsManage:     lvlProjAdmin,
	AppRead:           lvlProjViewer,
	AppCreate:         lvlProjDeveloper,
	AppUpdate:         lvlProjDeveloper,
	AppDelete:         lvlProjDeveloper,
	AppDeploy:         lvlProjDeveloper,
	AppEnvWrite:       lvlProjDeveloper,
	AppSecretsWrite:   lvlProjAdmin,
	AppSchedulesWrite: lvlProjDeveloper,
	AppQueueWrite:     lvlProjDeveloper,
	AppLogsRead:       lvlProjViewer,
	AppDataExport:     lvlProjAdmin,
	InstanceAdmin:     lvlInstance,
}

var (
	projectRank = map[string]int{RoleViewer: 1, RoleDeveloper: 2, RoleAdmin: 3}
	levelRank   = map[level]int{lvlProjViewer: 1, lvlProjDeveloper: 2, lvlProjAdmin: 3}
)

// Can reports whether s may perform a. projectSlug is ignored for org-level actions.
// An instance admin acts as owner of every org; the caller audits that use.
func Can(s Subject, a Action, projectSlug string) bool {
	lvl, ok := rules[a]
	if !ok {
		return false
	}
	if s.InstanceAdmin {
		return true
	}
	switch s.OrgRole {
	case RoleOwner:
		return lvl != lvlInstance
	case RoleAdmin:
		return lvl != lvlInstance && lvl != lvlOwner
	case RoleMember:
	default:
		return false
	}
	switch lvl {
	case lvlOrgMember:
		return true
	case lvlProjAdmin, lvlProjDeveloper, lvlProjViewer:
		if projectSlug == "" {
			return false
		}
		return projectRank[s.ProjectRoles[projectSlug]] >= levelRank[lvl]
	default:
		// lvlInstance, lvlOwner, lvlOrgAdmin: plain members never hold org-level actions.
		return false
	}
}
