import type { OrgRole } from "@/lib/types";

// ROLE_KEY maps an org role to its label key. The keys carry the namespace, so any t() can use them.
export const ROLE_KEY = {
  owner: "members:roles.owner",
  admin: "members:roles.admin",
  member: "members:roles.member",
} as const satisfies Record<OrgRole, string>;

/** English labels for code that is not translated yet. New code uses `t(ROLE_KEY[role])`. */
export const ROLE_LABEL: Record<OrgRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };

const PROJECT_ROLES = ["admin", "developer", "viewer"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export function isProjectRole(value: string): value is ProjectRole {
  return (PROJECT_ROLES as readonly string[]).includes(value);
}

// assignableRoles lists the roles a caller may hand out. Only owners grant owner (members.owners);
// admins see admin and member only.
export function assignableRoles(caller: OrgRole): OrgRole[] {
  return caller === "owner" ? ["owner", "admin", "member"] : ["admin", "member"];
}
