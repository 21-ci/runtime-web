// Organizations (port of internal/orgs/orgs.go). Each org is one runtime tenant plus a
// sealed hidden default tenant key that the console uses for calls on the org's behalf.

import type { Deps } from "../app.ts";
import { dbOf, sealerOf } from "../auth/types.ts";
import { defaultKeyScopes } from "../authz/policy.ts";
import { newId } from "../crypto/random.ts";
import { conflict, invalid, notFound } from "../http/errors.ts";
import { isNotFound, isRuntimeError } from "../runtime/client.ts";
import type { Scope } from "../runtime/types.ts";
import type { Db, Row } from "../storage/types.ts";
import { runtimeOf, type Actor } from "./common.ts";
import { auditStmt } from "../audit/audit.ts";
import { mapRuntimeError, rt } from "../runtime/errors.ts";

export type OrgDeps = Pick<Deps, "storage" | "now" | "config" | "rtctl">;

export const DEFAULT_KEY_NAME = "rtweb-default";
/** Runtime plan given to new org tenants. */
export const ORG_PLAN = "free";
const SLUG_RE = /^[a-z][a-z0-9-]{1,62}$/;

export interface Org {
  id: string;
  slug: string;
  name: string;
  tenantId: string;
  defaultKeyId: string;
  createdAt: number;
}

interface OrgRow extends Row {
  id: string;
  slug: string;
  name: string;
  tenant_id: string;
  default_key_id: string | null;
  default_key_sealed: Uint8Array | null;
  created_at: number;
}

const fromRow = (r: OrgRow): Org => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  tenantId: r.tenant_id,
  defaultKeyId: r.default_key_id ?? "",
  createdAt: Number(r.created_at),
});

/** api-web §2 Org. */
export const orgJson = (o: Org, role: string | null) => ({ id: o.id, slug: o.slug, name: o.name, created_at: o.createdAt, role });

const COLS = "id, slug, name, tenant_id, default_key_id, created_at";

export async function getOrg(db: Db, id: string): Promise<Org | null> {
  const r = await db.first<OrgRow>(`SELECT ${COLS} FROM orgs WHERE id = ? AND deleted_at IS NULL`, [id]);
  return r ? fromRow(r) : null;
}

export async function getOrgBySlug(db: Db, slug: string): Promise<Org | null> {
  const r = await db.first<OrgRow>(`SELECT ${COLS} FROM orgs WHERE slug = ? AND deleted_at IS NULL`, [slug]);
  return r ? fromRow(r) : null;
}

/** Orgs userId belongs to with their role, or every org (role from membership, else null) when all. */
export async function listOrgs(db: Db, userId: string, all: boolean): Promise<{ org: Org; role: string | null }[]> {
  const rows = await db.all<OrgRow & { role: string | null }>(
    `SELECT o.id, o.slug, o.name, o.tenant_id, o.default_key_id, o.created_at, m.role
     FROM orgs o LEFT JOIN members m ON m.org_id = o.id AND m.user_id = ?
     WHERE o.deleted_at IS NULL ${all ? "" : "AND m.role IS NOT NULL"} ORDER BY o.name, o.slug`,
    [userId],
  );
  return rows.map((r) => ({ org: fromRow(r), role: r.role ?? null }));
}

export interface CreateOrgIn {
  slug: unknown;
  name: unknown;
  ownerUserId: unknown;
}

/**
 * Provisions a runtime tenant (`POST /v1/tenants`) and its hidden default key, then
 * records the org with ownerUserId as owner. A failure after the tenant exists purges it.
 */
export async function createOrg(deps: OrgDeps, actor: Actor, input: CreateOrgIn): Promise<Org> {
  const slug = typeof input.slug === "string" ? input.slug.trim().toLowerCase() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const owner = typeof input.ownerUserId === "string" ? input.ownerUserId : "";
  const fields: Record<string, string> = {};
  if (!slug) fields.slug = "required";
  else if (!SLUG_RE.test(slug)) fields.slug = "invalid_format";
  if (!name) fields.name = "required";
  else if ([...name].length > 200) fields.name = "too_long";
  if (!owner) fields.owner_user_id = "required";
  if (Object.keys(fields).length) throw invalid(fields);

  const db = await dbOf(deps);
  if (await getOrgBySlug(db, slug)) throw conflict("slug_taken", "org slug is taken");
  const u = await db.first<{ disabled: number }>("SELECT disabled FROM users WHERE id = ? AND deleted_at IS NULL", [owner]);
  if (!u) throw invalid({ owner_user_id: "not_found" });
  if (Number(u.disabled)) throw invalid({ owner_user_id: "disabled" });

  const op = runtimeOf(deps).op();
  const tenant = await rt(() => op.createTenant({ name: slug, plan: ORG_PLAN }));
  try {
    const key = await op.createTenantKey(tenant.id, { name: DEFAULT_KEY_NAME, scopes: defaultKeyScopes() as Scope[] });
    const sealed = await (await sealerOf(deps)).seal(new TextEncoder().encode(key.secret));
    const now = deps.now();
    const org: Org = { id: newId("org_", now), slug, name, tenantId: tenant.id, defaultKeyId: key.id, createdAt: now };
    try {
      await db.batch([
        {
          sql: "INSERT INTO orgs (id, slug, name, tenant_id, default_key_id, default_key_sealed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          args: [org.id, slug, name, tenant.id, key.id, sealed, now],
        },
        { sql: "INSERT INTO members (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", args: [org.id, owner, now] },
        auditStmt(now, { actor, orgId: org.id, action: "org.create", target: org.id, detail: { slug } }),
      ]);
    } catch (e) {
      if (String(e).includes("UNIQUE") && String(e).includes("slug")) throw conflict("slug_taken", "org slug is taken");
      throw e;
    }
    return org;
  } catch (e) {
    try {
      await op.deleteTenant(tenant.id, true);
    } catch (ce) {
      console.error("orgs: compensate tenant failed, orphan tenant left behind", tenant.id, String(ce));
    }
    throw mapRuntimeError(e);
  }
}

export async function renameOrg(deps: OrgDeps, actor: Actor, org: Org, nameIn: unknown): Promise<Org> {
  const name = typeof nameIn === "string" ? nameIn.trim() : "";
  if (!name) throw invalid({ name: "required" });
  if ([...name].length > 200) throw invalid({ name: "too_long" });
  const db = await dbOf(deps);
  await db.batch([
    { sql: "UPDATE orgs SET name = ? WHERE id = ?", args: [name, org.id] },
    auditStmt(deps.now(), { actor, orgId: org.id, action: "org.rename", target: org.id, detail: { name } }),
  ]);
  return { ...org, name };
}

/** The org's default tenant key secret (unsealed). Never returned to clients. */
export async function defaultKey(deps: Pick<Deps, "storage" | "config">, orgId: string): Promise<string> {
  const db = await dbOf(deps);
  const r = await db.first<{ default_key_sealed: Uint8Array | null }>("SELECT default_key_sealed FROM orgs WHERE id = ? AND deleted_at IS NULL", [orgId]);
  if (!r?.default_key_sealed) throw notFound();
  const plain = await (await sealerOf(deps)).open(new Uint8Array(r.default_key_sealed));
  return new TextDecoder().decode(plain);
}

/**
 * Deletes an org and its runtime tenant. A tenant that still owns services is refused
 * with 409 org_not_empty. The rows go first; a failed tenant delete afterwards is audited
 * (org.delete.runtime_failed) and surfaced.
 */
export async function deleteOrg(deps: OrgDeps, actor: Actor, org: Org): Promise<void> {
  const runtime = runtimeOf(deps);
  let key = "";
  try {
    key = await defaultKey(deps, org.id);
  } catch {
    key = "";
  }
  if (key) {
    let count = 0;
    try {
      count = (await runtime.as(key).listServices()).items.length;
    } catch (e) {
      // Tenant gone (404) or its key revoked (401): nothing left to refuse on.
      if (!(isRuntimeError(e) && (e.status === 404 || e.status === 401))) throw mapRuntimeError(e);
    }
    if (count > 0) throw conflict("org_not_empty", "org still has apps");
  }
  const db = await dbOf(deps);
  const now = deps.now();
  await db.batch([
    { sql: "DELETE FROM project_grants WHERE org_id = ?", args: [org.id] },
    { sql: "DELETE FROM members WHERE org_id = ?", args: [org.id] },
    { sql: "DELETE FROM invites WHERE org_id = ?", args: [org.id] },
    { sql: "DELETE FROM tokens WHERE org_id = ?", args: [org.id] },
    { sql: "DELETE FROM domains WHERE org_id = ?", args: [org.id] },
    { sql: "DELETE FROM orgs WHERE id = ?", args: [org.id] },
    auditStmt(now, { actor, orgId: null, action: "org.delete", target: org.id, detail: { slug: org.slug } }),
  ]);
  try {
    await runtime.op().deleteTenant(org.tenantId, false);
  } catch (e) {
    if (isNotFound(e)) return;
    const m = mapRuntimeError(e);
    console.error("orgs: runtime tenant delete failed after org row removed", org.tenantId, String(e));
    await db.batch([auditStmt(now, { actor, orgId: null, action: "org.delete.runtime_failed", target: org.tenantId, detail: { org_id: org.id, tenant_id: org.tenantId } })]);
    throw m;
  }
}

export const FIRST_ORG = { slug: "default", name: "Default" } as const;

/**
 * First-run org for the setup admin (design §5). Best effort: a runtime failure is
 * logged and setup still succeeds; the admin can create an org later.
 */
export async function createFirstOrg(deps: OrgDeps, ownerUserId: string): Promise<Org | null> {
  if (!deps.rtctl) return null;
  try {
    return await createOrg(deps, { userId: ownerUserId }, { ...FIRST_ORG, ownerUserId });
  } catch (e) {
    console.error("setup: first org not created", String(e));
    return null;
  }
}
