// Org members and project grants (port of internal/orgs/members.go), plus the
// per-request org access check other route modules use (api-web §1.3 visibility rule).

import type { Deps } from "../app.ts";
import type { SessionUser } from "../auth/types.ts";
import { dbOf } from "../auth/types.ts";
import { ORG_ROLES, PROJECT_ROLES, can, type Action, type Subject } from "../authz/policy.ts";
import { conflict, forbidden, invalid, notFound } from "../http/errors.ts";
import type { Db, Tx } from "../storage/types.ts";
import { runtimeOf, type Actor } from "./common.ts";
import { auditStmt } from "../audit/audit.ts";
import { rt } from "../runtime/errors.ts";
import { defaultKey, getOrgBySlug, type Org, type OrgDeps } from "./orgs.ts";

export interface MemberJson {
  user: { id: string; email: string; name: string };
  role: string;
  grants: Record<string, string>;
}

/** Resolves userId's org role and project grants in orgId. A non-member gets no orgRole. */
export async function subjectFor(db: Db, user: Pick<SessionUser, "id" | "instanceAdmin">, orgId: string): Promise<Subject> {
  const sub: Subject = { userId: user.id, instanceAdmin: user.instanceAdmin, projectRoles: {} };
  const m = await db.first<{ role: string }>("SELECT role FROM members WHERE org_id = ? AND user_id = ?", [orgId, user.id]);
  if (!m) return sub;
  sub.orgRole = m.role;
  for (const g of await db.all<{ project: string; role: string }>("SELECT project, role FROM project_grants WHERE org_id = ? AND user_id = ?", [orgId, user.id])) {
    (sub.projectRoles as Record<string, string>)[g.project] = g.role;
  }
  return sub;
}

/** The caller's view of one org: the org, their subject, and the audit actor. */
export interface OrgAccess {
  org: Org;
  subject: Subject;
  actor: Actor;
  /** Throws 403 forbidden unless the subject may do action (on project for project actions). */
  check(action: Action, project?: string): void;
}

/**
 * Loads `{org}` for the caller. Unknown org or non-member (not instance admin) → 404.
 * With `action`, also requires it (403 if the org is visible but the role is too low).
 */
export async function orgAccess(deps: Pick<Deps, "storage">, user: SessionUser, slug: string, action?: Action, project?: string): Promise<OrgAccess> {
  const db = await dbOf(deps);
  const org = await getOrgBySlug(db, slug);
  if (!org) throw notFound();
  const subject = await subjectFor(db, user, org.id);
  if (!subject.orgRole && !subject.instanceAdmin) throw notFound();
  const actor: Actor = { userId: user.id, asInstanceAdmin: !subject.orgRole };
  const access: OrgAccess = {
    org,
    subject,
    actor,
    check(a, p = "") {
      if (!can(subject, a, p)) throw forbidden();
    },
  };
  if (action) access.check(action, project);
  return access;
}

/**
 * Requires action on project for an org-visible subject: allowed → returns; project
 * visible (project.read) but role too low → 403; project invisible → 404 (api-web §1.3).
 */
export function authorize(s: Subject, action: Action, project = ""): void {
  if (can(s, action, project)) return;
  if (project === "" || can(s, "project.read", project)) throw forbidden();
  throw notFound();
}

async function memberJson(q: Tx, orgId: string, userId: string, role: string): Promise<MemberJson> {
  const [u] = await q.all<{ id: string; email: string; name: string }>("SELECT id, email, name FROM users WHERE id = ?", [userId]);
  const grants: Record<string, string> = {};
  for (const g of await q.all<{ project: string; role: string }>("SELECT project, role FROM project_grants WHERE org_id = ? AND user_id = ? ORDER BY project", [orgId, userId])) {
    grants[g.project] = g.role;
  }
  return { user: { id: userId, email: u?.email ?? "", name: u?.name ?? "" }, role, grants };
}

export async function listMembers(deps: Pick<Deps, "storage">, orgId: string): Promise<MemberJson[]> {
  const db = await dbOf(deps);
  const rows = await db.all<{ user_id: string; role: string }>(
    "SELECT m.user_id, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.email",
    [orgId],
  );
  return Promise.all(rows.map((r) => memberJson(db, orgId, r.user_id, r.role)));
}

export async function getMember(deps: Pick<Deps, "storage">, orgId: string, userId: string): Promise<MemberJson> {
  const db = await dbOf(deps);
  const m = await db.first<{ role: string }>("SELECT role FROM members WHERE org_id = ? AND user_id = ?", [orgId, userId]);
  if (!m) throw notFound();
  return memberJson(db, orgId, userId, m.role);
}

function canManage(sub: Subject, owners: boolean): void {
  if (!can(sub, "members.manage") || (owners && !can(sub, "members.owners"))) throw forbidden();
}

const isOrgRole = (r: unknown): r is string => typeof r === "string" && (ORG_ROLES as readonly string[]).includes(r);
const isProjectRole = (r: unknown): r is string => typeof r === "string" && (PROJECT_ROLES as readonly string[]).includes(r);

/** Refuses taking the owner role from the only owner (409 last_owner). Runs inside the write tx. */
async function lastOwnerGuard(q: Tx, orgId: string): Promise<void> {
  const [r] = await q.all<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE org_id = ? AND role = 'owner'", [orgId]);
  if (Number(r?.n ?? 0) <= 1) throw conflict("last_owner", "the org needs at least one owner");
}

async function run(q: Tx, s: { sql: string; args?: unknown[] }): Promise<void> {
  await q.run(s.sql, s.args as never);
}

export async function addMember(deps: OrgDeps, a: OrgAccess, userId: unknown, role: unknown): Promise<MemberJson> {
  const fields: Record<string, string> = {};
  if (typeof userId !== "string" || !userId) fields.user_id = "required";
  if (!isOrgRole(role)) fields.role = "invalid";
  if (Object.keys(fields).length) throw invalid(fields);
  const uid = userId as string;
  const r = role as string;
  canManage(a.subject, r === "owner");
  const db = await dbOf(deps);
  return db.tx(async (q) => {
    const [u] = await q.all("SELECT id FROM users WHERE id = ? AND deleted_at IS NULL", [uid]);
    if (!u) throw notFound();
    const [m] = await q.all("SELECT role FROM members WHERE org_id = ? AND user_id = ?", [a.org.id, uid]);
    if (m) throw conflict("already_member", "user is already a member");
    const now = deps.now();
    await q.run("INSERT INTO members (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)", [a.org.id, uid, r, now]);
    await run(q, auditStmt(now, { actor: a.actor, orgId: a.org.id, action: "member.add", target: uid, detail: { role: r } }));
    return memberJson(q, a.org.id, uid, r);
  });
}

export async function setRole(deps: OrgDeps, a: OrgAccess, userId: string, role: unknown): Promise<MemberJson> {
  if (!isOrgRole(role)) throw invalid({ role: "invalid" });
  canManage(a.subject, role === "owner");
  const db = await dbOf(deps);
  return db.tx(async (q) => {
    const [old] = await q.all<{ role: string }>("SELECT role FROM members WHERE org_id = ? AND user_id = ?", [a.org.id, userId]);
    if (!old) throw notFound();
    if (old.role !== role) {
      if (old.role === "owner") {
        canManage(a.subject, true);
        await lastOwnerGuard(q, a.org.id);
      }
      const now = deps.now();
      await q.run("UPDATE members SET role = ? WHERE org_id = ? AND user_id = ?", [role, a.org.id, userId]);
      await run(q, auditStmt(now, { actor: a.actor, orgId: a.org.id, action: "member.role", target: userId, detail: { from: old.role, to: role } }));
    }
    return memberJson(q, a.org.id, userId, role);
  });
}

export async function removeMember(deps: OrgDeps, a: OrgAccess, userId: string): Promise<void> {
  canManage(a.subject, false);
  const db = await dbOf(deps);
  await db.tx(async (q) => {
    const [old] = await q.all<{ role: string }>("SELECT role FROM members WHERE org_id = ? AND user_id = ?", [a.org.id, userId]);
    if (!old) throw notFound();
    if (old.role === "owner") {
      canManage(a.subject, true);
      await lastOwnerGuard(q, a.org.id);
    }
    await q.run("DELETE FROM project_grants WHERE org_id = ? AND user_id = ?", [a.org.id, userId]);
    await q.run("DELETE FROM members WHERE org_id = ? AND user_id = ?", [a.org.id, userId]);
    await run(q, auditStmt(deps.now(), { actor: a.actor, orgId: a.org.id, action: "member.remove", target: userId, detail: { role: old.role } }));
  });
}

/** Grant checks project visibility first: a project outside the caller's grants is 404. */
function grantCheck(a: OrgAccess, project: string): void {
  if (!can(a.subject, "project.read", project)) throw notFound();
  a.check("grants.manage", project);
}

export async function setGrant(deps: OrgDeps, a: OrgAccess, userId: string, project: string, role: unknown): Promise<MemberJson> {
  if (!isProjectRole(role)) throw invalid({ role: "invalid" });
  grantCheck(a, project);
  const key = await defaultKey(deps, a.org.id);
  await rt(() => runtimeOf(deps).as(key).getProject(project));
  const db = await dbOf(deps);
  return db.tx(async (q) => {
    const [m] = await q.all<{ role: string }>("SELECT role FROM members WHERE org_id = ? AND user_id = ?", [a.org.id, userId]);
    if (!m) throw notFound();
    await q.run(
      "INSERT INTO project_grants (org_id, user_id, project, role) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, user_id, project) DO UPDATE SET role = excluded.role",
      [a.org.id, userId, project, role],
    );
    await run(q, auditStmt(deps.now(), { actor: a.actor, orgId: a.org.id, action: "grant.set", target: userId, detail: { project, role } }));
    return memberJson(q, a.org.id, userId, m.role);
  });
}

export async function removeGrant(deps: OrgDeps, a: OrgAccess, userId: string, project: string): Promise<void> {
  grantCheck(a, project);
  const db = await dbOf(deps);
  await db.tx(async (q) => {
    const r = await q.run("DELETE FROM project_grants WHERE org_id = ? AND user_id = ? AND project = ?", [a.org.id, userId, project]);
    if (r.changes === 0) throw notFound();
    await run(q, auditStmt(deps.now(), { actor: a.actor, orgId: a.org.id, action: "grant.remove", target: userId, detail: { project } }));
  });
}
