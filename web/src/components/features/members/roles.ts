import type { OrgRole } from "@/lib/types";

export const ROLE_LABEL: Record<OrgRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };

// assignableRoles lists the roles a caller may hand out. Only owners grant owner (members.owners);
// admins see admin and member only.
export function assignableRoles(caller: OrgRole): OrgRole[] {
  return caller === "owner" ? ["owner", "admin", "member"] : ["admin", "member"];
}
