// What a user may do in an org: org roles, project grants keyed by project slug, and
// the instance admin override. Pure logic, port of internal/authz.

export const Actions = [
  "org.read",
  "org.update",
  "org.delete",
  "org.audit.read",
  "org.usage.read",
  "members.manage",
  "members.owners",
  "invites.manage",
  "tokens.manage",
  "defaultkey.rotate",
  "project.create",
  "project.read",
  "project.update",
  "project.delete",
  "grants.manage",
  "domains.manage",
  "app.read",
  "app.create",
  "app.update",
  "app.delete",
  "app.deploy",
  "app.env.write",
  "app.secrets.write",
  "app.schedules.write",
  "app.queue.write",
  "app.logs.read",
  "app.data.export",
  "instance.admin",
] as const;

export type Action = (typeof Actions)[number];

export const ORG_ROLES = ["owner", "admin", "member"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];
export const PROJECT_ROLES = ["admin", "developer", "viewer"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/** The caller, resolved for one org. */
export interface Subject {
  userId: string;
  instanceAdmin?: boolean;
  /** "" / undefined if not a member of the org. */
  orgRole?: string;
  /** project slug → project role. */
  projectRoles?: Record<string, string>;
}

type Level = "instance" | "owner" | "orgAdmin" | "orgMember" | "projAdmin" | "projDeveloper" | "projViewer";

const rules: Record<Action, Level> = {
  "org.read": "orgMember",
  "org.update": "orgAdmin",
  "org.delete": "owner",
  "org.audit.read": "orgAdmin",
  "org.usage.read": "orgAdmin",
  "members.manage": "orgAdmin",
  "members.owners": "owner",
  "invites.manage": "orgAdmin",
  "tokens.manage": "orgAdmin",
  "defaultkey.rotate": "orgAdmin",
  "project.create": "orgAdmin",
  "project.read": "projViewer",
  "project.update": "projAdmin",
  "project.delete": "orgAdmin",
  "grants.manage": "projAdmin",
  "domains.manage": "projAdmin",
  "app.read": "projViewer",
  "app.create": "projDeveloper",
  "app.update": "projDeveloper",
  "app.delete": "projDeveloper",
  "app.deploy": "projDeveloper",
  "app.env.write": "projDeveloper",
  "app.secrets.write": "projAdmin",
  "app.schedules.write": "projDeveloper",
  "app.queue.write": "projDeveloper",
  "app.logs.read": "projViewer",
  "app.data.export": "projAdmin",
  "instance.admin": "instance",
};

const projectRank: Record<string, number> = { viewer: 1, developer: 2, admin: 3 };
const levelRank: Partial<Record<Level, number>> = { projViewer: 1, projDeveloper: 2, projAdmin: 3 };

/**
 * Reports whether s may perform a. projectSlug is ignored for org-level actions.
 * An instance admin acts as owner of every org; the caller audits that use.
 */
export function can(s: Subject, a: string, projectSlug = ""): boolean {
  if (!Object.hasOwn(rules, a)) return false;
  const lvl = rules[a as Action];
  if (s.instanceAdmin) return true;
  switch (s.orgRole) {
    case "owner":
      return lvl !== "instance";
    case "admin":
      return lvl !== "instance" && lvl !== "owner";
    case "member":
      break;
    default:
      return false;
  }
  if (lvl === "orgMember") return true;
  const need = levelRank[lvl];
  if (need === undefined || projectSlug === "") return false;
  const role = s.projectRoles && Object.hasOwn(s.projectRoles, projectSlug) ? s.projectRoles[projectSlug] : undefined;
  return (role ? (projectRank[role] ?? 0) : 0) >= need;
}

const viewerScopes = ["services:read", "logs:read"];
const developerScopes = [...viewerScopes, "services:write", "deploy", "env:write", "queue:write", "invoke"];
const adminScopes = [...developerScopes, "secrets:write", "data:admin", "sockets:write", "keys:write"];

/** Scopes of an org's default runtime key: every tenant scope except keys:write. Fresh array. */
export function defaultKeyScopes(): string[] {
  return adminScopes.filter((s) => s !== "keys:write");
}

/** Runtime key scopes for a role (owner gets the admin set), or null for an unknown role. Fresh array. */
export function scopesFor(role: string): string[] | null {
  switch (role) {
    case "viewer":
      return [...viewerScopes];
    case "developer":
      return [...developerScopes];
    case "admin":
    case "owner":
      return [...adminScopes];
    default:
      return null;
  }
}
