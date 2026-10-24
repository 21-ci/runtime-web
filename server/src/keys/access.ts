// Org membership and permission checks for the keys/projects/admin-node
// routes. Local stand-in for the T5 authz policy (src/authz/policy.ts is not on
// this branch yet): it reads the members/project_grants tables from
// docs/design/backend-on-runtime.md §6 and mirrors internal/authz rules for the
// actions T6 needs. Replace with authz/policy.ts when T5 merges.

import type { Deps } from "../app.ts";
import { dbOf } from "../auth/types.ts";
import { forbidden, notFound } from "../http/errors.ts";
import type { Db } from "../storage/types.ts";

export type OrgRole = "owner" | "admin" | "member" | "viewer";

export interface OrgRow {
  id: string;
  slug: string;
  name: string;
  tenantId: string;
  defaultKeyId: string | null;
  defaultKeySealed: Uint8Array | null;
}

/** Org-level actions T6 checks. Owners and admins hold every admin action. */
export type OrgPerm =
  | "org.read"
  | "org.usage.read"
  | "tokens.manage"
  | "defaultkey.rotate"
  | "project.create"
  | "project.delete";

const ADMIN_PERMS: ReadonlySet<OrgPerm> = new Set<OrgPerm>([
  "org.usage.read",
  "tokens.manage",
  "defaultkey.rotate",
  "project.create",
  "project.delete",
]);

/** Caller's standing in one org. `role` is "" for a non-member. */
export interface Subject {
  userId: string;
  instanceAdmin: boolean;
  role: OrgRole | "";
}

export async function orgBySlug(db: Db, slug: string): Promise<OrgRow | null> {
  const r = await db.first<{
    id: string;
    slug: string;
    name: string;
    tenant_id: string;
    default_key_id: string | null;
    default_key_sealed: Uint8Array | null;
  }>(
    "SELECT id, slug, name, tenant_id, default_key_id, default_key_sealed FROM orgs WHERE slug = ? AND deleted_at IS NULL",
    [slug],
  );
  if (!r) return null;
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    tenantId: r.tenant_id,
    defaultKeyId: r.default_key_id,
    defaultKeySealed: r.default_key_sealed,
  };
}

/** The org with the caller's role in it (role "" when not a member). Null if the org does not exist. */
export async function orgRole(
  deps: Pick<Deps, "storage">,
  orgSlug: string,
  userId: string,
): Promise<{ org: OrgRow; role: OrgRole | "" } | null> {
  const db = await dbOf(deps);
  const org = await orgBySlug(db, orgSlug);
  if (!org) return null;
  const m = await db.first<{ role: OrgRole }>("SELECT role FROM members WHERE org_id = ? AND user_id = ?", [
    org.id,
    userId,
  ]);
  return { org, role: m?.role ?? "" };
}

/**
 * Resolves the org for a route and checks the org-level permission. Non-members
 * get 404 (the org is not visible to them); members without the right role get 403.
 * Instance admins pass every check.
 */
export async function orgAccess(
  deps: Pick<Deps, "storage">,
  orgSlug: string,
  sub: { id: string; instanceAdmin: boolean },
  perm: OrgPerm,
): Promise<OrgRow> {
  const found = await orgRole(deps, orgSlug, sub.id);
  if (!found) throw notFound();
  const s: Subject = { userId: sub.id, instanceAdmin: sub.instanceAdmin, role: found.role };
  if (!canOrg(s, perm)) {
    if (s.role === "") throw notFound();
    throw forbidden("forbidden", "not allowed");
  }
  return found.org;
}

/** Org and the caller's Subject for a route. Non-members (who are not instance admins) get 404. */
export async function loadOrg(
  deps: Pick<Deps, "storage">,
  orgSlug: string,
  user: { id: string; instanceAdmin: boolean },
): Promise<{ org: OrgRow; sub: Subject }> {
  const found = await orgRole(deps, orgSlug, user.id);
  if (!found || (found.role === "" && !user.instanceAdmin)) throw notFound();
  return {
    org: found.org,
    sub: { userId: user.id, instanceAdmin: user.instanceAdmin, role: found.role },
  };
}

export function canOrg(sub: Subject, perm: OrgPerm): boolean {
  if (sub.instanceAdmin) return true;
  if (sub.role === "") return false;
  if (perm === "org.read") return true;
  if (ADMIN_PERMS.has(perm)) return sub.role === "owner" || sub.role === "admin";
  return false;
}

/** True for owners, admins and instance admins: they act as project admins everywhere. */
export function isOrgAdmin(sub: Subject): boolean {
  return sub.instanceAdmin || sub.role === "owner" || sub.role === "admin";
}

/** Project role (admin | developer | viewer) from grants, or "" when no access. */
export async function projectRole(
  db: Db,
  sub: Subject,
  orgId: string,
  project: string,
): Promise<"admin" | "developer" | "viewer" | ""> {
  if (isOrgAdmin(sub)) return "admin";
  if (sub.role === "") return "";
  const g = await db.first<{ role: "admin" | "developer" | "viewer" }>(
    "SELECT role FROM project_grants WHERE org_id = ? AND user_id = ? AND project = ?",
    [orgId, sub.userId, project],
  );
  return g?.role ?? "";
}

export async function grantRoles(db: Db, orgId: string, userId: string): Promise<Map<string, string>> {
  const rows = await db.all<{ project: string; role: string }>(
    "SELECT project, role FROM project_grants WHERE org_id = ? AND user_id = ?",
    [orgId, userId],
  );
  return new Map(rows.map((r) => [r.project, r.role]));
}
