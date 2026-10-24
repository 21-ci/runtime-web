// Org runtime keys (port of internal/keys). Custom tokens are minted with the
// operator route so rotating the hidden default key never cascades to them.
// The default key secret lives sealed in orgs.default_key_sealed and is never
// listed or returned. Secrets of custom tokens are returned once and never stored.

import type { Deps } from "../app.ts";
import { dbOf, sealerOf } from "../auth/types.ts";
import { AppError, conflict, invalid, notFound } from "../http/errors.ts";
import { isNotFound, isRuntimeError } from "../runtime/client.ts";
import type { Scope } from "../runtime/types.ts";
import { newId } from "../crypto/random.ts";
import { auditIn } from "../audit/audit.ts";
import { defaultKey, type Org as OrgRow } from "../orgs/orgs.ts";
import { runtimeOf } from "../orgs/common.ts";

export const DEFAULT_KEY_NAME = "rtweb-default";
/** Every tenant scope except keys:write (internal/authz DefaultKeyScopes). */
export const KEY_SCOPES = [
  "services:read",
  "logs:read",
  "services:write",
  "deploy",
  "env:write",
  "queue:write",
  "invoke",
  "secrets:write",
  "data:admin",
  "sockets:write",
] as const satisfies readonly Scope[];

/** Retry delay for a failed default-key revoke (RetryInterval in Go). */
export const REVOKE_BASE_MS = 60_000;
export const REVOKE_MAX_MS = 3600_000;

/** Delay before retry number `attempts` of a failed revoke (exponential, capped at 1 h). */
export function revokeBackoff(attempts: number): number {
  return Math.min(REVOKE_BASE_MS * 2 ** attempts, REVOKE_MAX_MS);
}
const RETRY_BATCH = 100;

export interface Actor {
  id: string;
  name: string;
}

export interface TokenJson {
  id: string;
  name: string;
  scopes: string[];
  projects: string[];
  environments: string[];
  created_by: { id: string; name: string };
  created_at: number;
  expires_at: number | null;
  last_used_at: null;
}

export interface TokenReq {
  name: string;
  scopes: Scope[];
  projects: string[];
  environments: string[];
  expiresAt: number | null;
}

/** The runtime client over the operator/relay transport. */
export const rtOf = runtimeOf;

/** Plaintext of the org's sealed default key. Never sent to clients. */
export async function defaultKeySecret(deps: Pick<Deps, "config" | "storage">, org: OrgRow): Promise<string> {
  return defaultKey(deps, org.id).catch((e: unknown) => {
    throw e instanceof AppError && e.status === 404 ? conflict("no_default_key", "organization has no default key") : e;
  });
}

const strList = (v: unknown): string[] | null => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.trim() === "")) return null;
  return [...new Set(v.map((x: string) => x.trim()))];
};

/** Validates a token request body. Throws 422 invalid with field errors. */
export function parseTokenReq(body: unknown, now: number): TokenReq {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const errs: Record<string, string> = {};
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) errs.name = "required";
  const allowed = KEY_SCOPES as readonly string[];
  let scopes: Scope[] = [];
  if (!Array.isArray(b.scopes) || b.scopes.length === 0) errs.scopes = "required";
  else if (b.scopes.some((s) => typeof s !== "string" || !allowed.includes(s))) errs.scopes = "unknown scope";
  else scopes = [...new Set(b.scopes as string[])] as Scope[];
  const projects = strList(b.projects);
  if (projects === null) errs.projects = "must be a list of slugs";
  const environments = strList(b.environments);
  if (environments === null) errs.environments = "must be a list of names";
  let expiresAt: number | null = null;
  if (b.expires_at !== undefined && b.expires_at !== null) {
    if (typeof b.expires_at !== "number" || !Number.isFinite(b.expires_at)) errs.expires_at = "must be unix ms";
    else if (b.expires_at <= now) errs.expires_at = "must be in the future";
    else expiresAt = b.expires_at;
  }
  if (Object.keys(errs).length > 0) throw invalid(errs);
  return { name, scopes, projects: projects ?? [], environments: environments ?? [], expiresAt };
}

/** Revokes a runtime key; a key already gone counts as revoked. */
async function revokeRuntimeKey(deps: Pick<Deps, "rtctl">, tenantId: string, keyId: string): Promise<void> {
  try {
    await rtOf(deps).op().revokeTenantKey(tenantId, keyId);
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
}

/** Request field a runtime key-create refusal is about (scopes unless it names another). */
function fieldOf(msg: string): string {
  for (const f of ["environments", "expires_at", "name"]) if (msg.includes(f)) return f;
  if (msg.includes("project")) return "projects";
  return "scopes";
}

/** Mints a custom token and records it. The secret is returned once. */
export async function createToken(
  deps: Deps,
  actor: Actor,
  org: OrgRow,
  req: TokenReq,
): Promise<{ token: TokenJson; secret: string }> {
  const rt = rtOf(deps);
  const defSecret = await defaultKeySecret(deps, org);
  const projectIds: string[] = [];
  for (const slug of req.projects) {
    try {
      projectIds.push((await rt.as(defSecret).getProject(slug)).id);
    } catch (e) {
      if (isNotFound(e)) throw notFound("not_found", `project ${slug} not found`);
      throw e;
    }
  }
  const now = deps.now();
  const key = await rt
    .op()
    .createTenantKey(org.tenantId, {
    name: req.name,
    scopes: req.scopes,
    ...(projectIds.length ? { project_ids: projectIds } : {}),
    ...(req.environments.length ? { environments: req.environments } : {}),
    ...(req.expiresAt !== null ? { expires_at: new Date(req.expiresAt).toISOString() } : {}),
    })
    .catch((e: unknown) => {
      // The runtime refusing a field the web accepted is still a 422 invalid naming the field.
      if (isRuntimeError(e) && (e.status === 400 || e.status === 422)) {
        throw invalid({ [fieldOf(e.message)]: e.message.replace(/^runtime: \d+ [a-z_0-9]+: /, "") || e.code });
      }
      throw e;
    });
  const id = newId("tok_", now);
  const db = await dbOf(deps);
  try {
    await db.tx(async (tx) => {
      await tx.run(
        "INSERT INTO tokens (id, org_id, runtime_key_id, name, scopes, projects, envs, created_by, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
        [
          id,
          org.id,
          key.id,
          req.name,
          JSON.stringify(req.scopes),
          JSON.stringify(req.projects),
          JSON.stringify(req.environments),
          actor.id,
          now,
          req.expiresAt,
        ],
      );
      await auditIn(tx, now, {
        orgId: org.id,
        actor: { userId: actor.id },
        action: "token.create",
        target: id,
        detail: { name: req.name, scopes: req.scopes, projects: req.projects, environments: req.environments },
      });
    });
  } catch (e) {
    await revokeRuntimeKey(deps, org.tenantId, key.id).catch(() => undefined);
    throw e;
  }
  return {
    token: {
      id,
      name: req.name,
      scopes: req.scopes,
      projects: req.projects,
      environments: req.environments,
      created_by: { id: actor.id, name: actor.name },
      created_at: now,
      expires_at: req.expiresAt,
      last_used_at: null,
    },
    secret: key.secret,
  };
}

/** Live (not revoked) custom tokens of an org. Never includes the default key. */
export async function listTokens(deps: Pick<Deps, "storage">, orgId: string): Promise<TokenJson[]> {
  const db = await dbOf(deps);
  const rows = await db.all<{
    id: string;
    name: string;
    scopes: string;
    projects: string;
    envs: string;
    created_by: string;
    creator_name: string | null;
    created_at: number;
    expires_at: number | null;
  }>(
    `SELECT t.id, t.name, t.scopes, t.projects, t.envs, t.created_by, u.name AS creator_name, t.created_at, t.expires_at
       FROM tokens t LEFT JOIN users u ON u.id = t.created_by
      WHERE t.org_id = ? AND t.revoked_at IS NULL
      ORDER BY t.created_at, t.id`,
    [orgId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    scopes: JSON.parse(r.scopes) as string[],
    projects: JSON.parse(r.projects) as string[],
    environments: JSON.parse(r.envs) as string[],
    created_by: { id: r.created_by, name: r.creator_name ?? "" },
    created_at: r.created_at,
    expires_at: r.expires_at,
    last_used_at: null,
  }));
}

/** Revokes a custom token in the runtime, then marks it revoked. Unknown or revoked: 404. */
export async function revokeToken(deps: Deps, actor: Actor, org: OrgRow, tokenId: string): Promise<void> {
  const db = await dbOf(deps);
  const row = await db.first<{ runtime_key_id: string; name: string }>(
    "SELECT runtime_key_id, name FROM tokens WHERE id = ? AND org_id = ? AND revoked_at IS NULL",
    [tokenId, org.id],
  );
  if (!row) throw notFound("not_found", "token not found");
  await revokeRuntimeKey(deps, org.tenantId, row.runtime_key_id);
  const now = deps.now();
  await db.tx(async (tx) => {
    const r = await tx.run("UPDATE tokens SET revoked_at = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL", [
      now,
      tokenId,
      org.id,
    ]);
    if (r.changes === 0) throw notFound("not_found", "token not found");
    await auditIn(tx, now, {
      orgId: org.id,
      actor: { userId: actor.id },
      action: "token.revoke",
      target: tokenId,
      detail: { name: row.name },
    });
  });
}

type PendingRow = { runtime_key_id: string; tenant_id: string; attempts?: number };

/** Tries the runtime revoke of a rotated-out key; success or "already gone" deletes the queue row. */
async function revokePending(deps: Pick<Deps, "storage" | "now" | "rtctl">, row: PendingRow): Promise<void> {
  const db = await dbOf(deps);
  try {
    await revokeRuntimeKey(deps, row.tenant_id, row.runtime_key_id);
  } catch {
    const attempts = (row.attempts ?? 0) + 1;
    await db.run("UPDATE pending_key_revokes SET attempts = ?, next_at = ? WHERE runtime_key_id = ?", [
      attempts,
      deps.now() + revokeBackoff(attempts),
      row.runtime_key_id,
    ]);
    return;
  }
  await db.run("DELETE FROM pending_key_revokes WHERE runtime_key_id = ?", [row.runtime_key_id]);
}

/**
 * Replaces the org's default key. The new key is minted with the operator route;
 * one transaction compare-and-swaps the sealed value (409 rotation_in_progress if
 * another rotation or delete won) and queues the old key. The old key is revoked
 * right after; a failed revoke stays queued for retryPendingRevokes. Custom tokens
 * are untouched because they were minted with their own keys.
 */
export async function rotateDefaultKey(deps: Deps, actor: Actor, org: OrgRow): Promise<void> {
  const db = await dbOf(deps);
  const rt = rtOf(deps);
  const key = await rt.op().createTenantKey(org.tenantId, {
    name: DEFAULT_KEY_NAME,
    scopes: [...KEY_SCOPES],
  });
  const sealed = await (await sealerOf(deps)).seal(new TextEncoder().encode(key.secret));
  const now = deps.now();
  try {
    await db.tx(async (tx) => {
      const r = await tx.run("UPDATE orgs SET default_key_id = ?, default_key_sealed = ? WHERE id = ? AND default_key_id IS ?", [
        key.id,
        sealed,
        org.id,
        org.defaultKeyId,
      ]);
      if (r.changes === 0) throw conflict("rotation_in_progress", "default key changed; retry");
      if (org.defaultKeyId) {
        await tx.run(
          "INSERT OR IGNORE INTO pending_key_revokes (runtime_key_id, tenant_id, attempts, next_at) VALUES (?, ?, 0, ?)",
          [org.defaultKeyId, org.tenantId, now],
        );
      }
      await auditIn(tx, now, {
        orgId: org.id,
        actor: { userId: actor.id },
        action: "defaultkey.rotate",
        target: org.id,
        detail: { old_key_id: org.defaultKeyId, new_key_id: key.id },
      });
    });
  } catch (e) {
    await revokeRuntimeKey(deps, org.tenantId, key.id).catch(() => undefined);
    throw e;
  }
  if (org.defaultKeyId) {
    await revokePending(deps, { runtime_key_id: org.defaultKeyId, tenant_id: org.tenantId });
  }
}

/** Retries queued default-key revokes that are due. Called from scheduled(). */
export async function retryPendingRevokes(deps: Pick<Deps, "storage" | "now" | "rtctl">): Promise<number> {
  const db = await dbOf(deps);
  const rows = await db.all<PendingRow>(
    "SELECT runtime_key_id, tenant_id, attempts FROM pending_key_revokes WHERE next_at <= ? ORDER BY next_at LIMIT ?",
    [deps.now(), RETRY_BATCH],
  );
  for (const r of rows) await revokePending(deps, r);
  return rows.length;
}
