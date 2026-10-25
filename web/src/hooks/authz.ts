import { useQuery } from "@tanstack/react-query";

import { meQuery } from "@/components/features/admin/gate";
import { useOrgs, useProjects } from "@/hooks/orgs";
import type { OrgRole } from "@/lib/types";

// Write actions the console gates. Mirrors server/src/authz/policy.ts (the server stays the authority;
// this only hides controls a role cannot use).
export type Action =
  | "org.update"
  | "members.manage"
  | "tokens.manage"
  | "defaultkey.rotate"
  | "domains.manage"
  | "app.update"
  | "app.delete"
  | "app.deploy"
  | "app.env.write"
  | "app.secrets.write"
  | "app.schedules.write"
  | "app.queue.write"
  | "app.data.export";

export type ProjectRole = "admin" | "developer" | "viewer";

const ORG_ADMIN: Action[] = ["org.update", "members.manage", "tokens.manage", "defaultkey.rotate"];
const PROJECT_LEVEL: Partial<Record<Action, ProjectRole>> = {
  "domains.manage": "admin",
  "app.secrets.write": "admin",
  "app.data.export": "admin",
  "app.update": "developer",
  "app.delete": "developer",
  "app.deploy": "developer",
  "app.env.write": "developer",
  "app.schedules.write": "developer",
  "app.queue.write": "developer",
};
const RANK: Record<ProjectRole, number> = { viewer: 1, developer: 2, admin: 3 };

export type Subject = { instanceAdmin: boolean; orgRole: OrgRole | null; projectRole: string | null };

// can reports whether s may perform a (same rules as authz.Can).
export function can(s: Subject, a: Action): boolean {
  if (s.instanceAdmin || s.orgRole === "owner" || s.orgRole === "admin") return true;
  if (s.orgRole !== "member" || ORG_ADMIN.includes(a)) return false;
  const need = PROJECT_LEVEL[a];
  const have = s.projectRole as ProjectRole | null;
  return !!need && !!have && RANK[have] >= RANK[need];
}

// useCan returns a checker for the caller in org (and project for app actions). It answers
// undefined while the roles load, so callers can render nothing instead of flashing controls.
export function useCan(org: string, project?: string): (a: Action) => boolean | undefined {
  const me = useQuery(meQuery);
  const orgs = useOrgs();
  const projects = useProjects(org);
  return (a) => {
    if (me.data?.user.instance_admin) return true;
    if (!orgs.data) return undefined;
    const orgRole = orgs.data.find((o) => o.slug === org)?.role ?? null;
    if (orgRole === "owner" || orgRole === "admin") return true;
    if (PROJECT_LEVEL[a] && project && !projects.data) return undefined;
    const projectRole = project ? (projects.data?.find((p) => p.slug === project)?.role ?? null) : null;
    return can({ instanceAdmin: false, orgRole, projectRole }, a);
  };
}
