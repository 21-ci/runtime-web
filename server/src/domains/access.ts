// Org and project visibility for the domain and audit routes. Minimal port of the
// internal/authz matrix rows these routes need (org.read, org.audit.read, app.read,
// domains.manage). Visibility rule (api-web §1.3): not visible → 404, visible but
// too low → 403. Instance admins act as owner of every org.
// TODO(T5): replace with the shared authz module once it lands.

import { forbidden, notFound } from "../http/errors.ts";
import type { Db } from "../storage/types.ts";

export type OrgRole = "owner" | "admin" | "member";
export type ProjectRole = "admin" | "developer" | "viewer";

const LEVEL: Record<ProjectRole, number> = { viewer: 1, developer: 2, admin: 3 };

export interface Subject {
  userId: string;
  instanceAdmin: boolean;
  orgRole: OrgRole | null;
  grants: Map<string, ProjectRole>;
}

/** Live org by its path slug, or 404. */
export async function orgBySlug(db: Db, slug: string): Promise<{ id: string; slug: string; name: string }> {
  const o = await db.first<{ id: string; slug: string; name: string }>(
    "SELECT id, slug, name FROM orgs WHERE slug = ? AND deleted_at IS NULL",
    [slug],
  );
  if (!o) throw notFound();
  return o;
}

export async function subjectFor(db: Db, user: { id: string; instanceAdmin: boolean }, orgId: string): Promise<Subject> {
  const m = await db.first<{ role: string }>("SELECT role FROM members WHERE org_id = ? AND user_id = ?", [orgId, user.id]);
  const grants = new Map<string, ProjectRole>();
  if (m) {
    const rows = await db.all<{ project: string; role: string }>(
      "SELECT project, role FROM project_grants WHERE org_id = ? AND user_id = ?",
      [orgId, user.id],
    );
    for (const r of rows) grants.set(r.project, r.role as ProjectRole);
  }
  return { userId: user.id, instanceAdmin: user.instanceAdmin, orgRole: (m?.role as OrgRole | undefined) ?? null, grants };
}

const orgAdmin = (s: Subject) => s.instanceAdmin || s.orgRole === "owner" || s.orgRole === "admin";

/** org.read: a member, or an instance admin. Otherwise 404 (the org is invisible). */
export function requireOrgMember(s: Subject): void {
  if (!s.instanceAdmin && s.orgRole === null) throw notFound();
}

/** org.audit.read: owner or admin of the org (or instance admin). */
export function requireOrgAdmin(s: Subject): void {
  requireOrgMember(s);
  if (!orgAdmin(s)) throw forbidden("forbidden", "org admin required");
}

/** Effective project role; org owners and admins are project admins. */
export function projectRole(s: Subject, project: string): ProjectRole | null {
  if (orgAdmin(s)) return "admin";
  return s.grants.get(project) ?? null;
}

/** Checks `need` on project: invisible → 404, visible but too low → 403. */
export function requireProject(s: Subject, project: string, need: ProjectRole): void {
  requireOrgMember(s);
  const have = projectRole(s, project);
  if (have === null) throw notFound();
  if (LEVEL[have] < LEVEL[need]) throw forbidden("forbidden", `${need} role required`);
}
