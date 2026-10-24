// Org/project access for app routes. LOCAL HELPER: T5 owns src/authz (port of
// internal/authz); until it merges, this file carries the same rules for the app
// actions and reads members/project_grants directly (design §6). Swap `can` for
// the T5 policy when it lands; the semantics are identical (Go authz.Can).

import type { Db } from "../storage/types.ts";
import type { SessionUser } from "../auth/types.ts";
import { forbidden, notFound } from "../http/errors.ts";

export type AppAction =
  | "org.read"
  | "app.read"
  | "app.create"
  | "app.update"
  | "app.delete"
  | "app.deploy"
  | "app.env.write"
  | "app.secrets.write"
  | "app.schedules.write"
  | "app.queue.write"
  | "app.logs.read"
  | "app.data.export";

/** Required project rank; 0 = any org member. */
const RULES: Record<AppAction, number> = {
  "org.read": 0,
  "app.read": 1,
  "app.logs.read": 1,
  "app.create": 2,
  "app.update": 2,
  "app.delete": 2,
  "app.deploy": 2,
  "app.env.write": 2,
  "app.schedules.write": 2,
  "app.queue.write": 2,
  "app.secrets.write": 3,
  "app.data.export": 3,
};
const PROJECT_RANK: Record<string, number> = { viewer: 1, developer: 2, admin: 3 };

export interface Subject {
  userId: string;
  instanceAdmin: boolean;
  orgRole: string | null;
  projectRoles: Record<string, string>;
}

export interface OrgRow {
  id: string;
  slug: string;
  tenantId: string;
  sealedKey: Uint8Array | null;
}

export function can(s: Subject, a: AppAction, project = ""): boolean {
  const need = RULES[a];
  if (need === undefined) return false;
  if (s.instanceAdmin || s.orgRole === "owner" || s.orgRole === "admin") return true;
  if (s.orgRole !== "member") return false;
  if (need === 0) return true;
  if (!project) return false;
  return (PROJECT_RANK[s.projectRoles[project] ?? ""] ?? 0) >= need;
}

/** Invisible project → 404, visible but role too low → 403. */
export function authorize(s: Subject, a: AppAction, project: string): void {
  if (can(s, a, project)) return;
  if (can(s, "app.read", project)) throw forbidden();
  throw notFound();
}

/** Loads the org and the caller's subject; 404 when the caller is not a member (nor instance admin). */
export async function loadOrg(db: Db, slug: string, user: SessionUser): Promise<{ org: OrgRow; sub: Subject }> {
  const o = await db.first<{ id: string; slug: string; tenant_id: string; default_key_sealed: Uint8Array | null }>(
    "SELECT id, slug, tenant_id, default_key_sealed FROM orgs WHERE slug = ? AND deleted_at IS NULL",
    [slug],
  );
  if (!o) throw notFound();
  const m = await db.first<{ role: string }>("SELECT role FROM members WHERE org_id = ? AND user_id = ?", [o.id, user.id]);
  if (!m && !user.instanceAdmin) throw notFound();
  const grants = await db.all<{ project: string; role: string }>(
    "SELECT project, role FROM project_grants WHERE org_id = ? AND user_id = ?",
    [o.id, user.id],
  );
  const projectRoles: Record<string, string> = {};
  for (const g of grants) projectRoles[g.project] = g.role;
  const sealed = o.default_key_sealed === null ? null : new Uint8Array(o.default_key_sealed);
  return {
    org: { id: o.id, slug: o.slug, tenantId: o.tenant_id, sealedKey: sealed },
    sub: { userId: user.id, instanceAdmin: user.instanceAdmin, orgRole: m?.role ?? null, projectRoles },
  };
}
