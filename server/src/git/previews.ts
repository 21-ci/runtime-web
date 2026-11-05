// Per-pull-request previews. Each is a separate runtime service with its own data and env label, so branch code
// never meets production data or secrets. Rows are keyed by PR number, never by branch name: a fork can name its
// branch like an internal one. Org and App are in every query, so a URL's PR number cannot reach another App's.

import type { Deps } from "../app.ts";
import { appFor, type OrgCtx } from "../apps/service.ts";
import { dbOf, sealerOf } from "../auth/types.ts";
import { AppError, conflict, invalid, notFound } from "../http/errors.ts";
import type { Job, RunnerDeps } from "../jobs/runner.ts";
import { getOrg } from "../orgs/orgs.ts";
import { isNotFound, type Scoped } from "../runtime/client.ts";
import type { Row } from "../storage/types.ts";
import type { LinkRow } from "./links.ts";

export const MAX_PREVIEWS = 5;
/** The default ceiling of the node's scratch_ttl_max. The node deletes at this age whatever the console does. */
const TTL_S = 7 * 86_400;
const SWEEP_BATCH = 20;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const MAX_ENV = 100;
const MAX_ENV_BYTES = 64 << 10;
const SHA_RE = /^[0-9a-f]{40,64}$/;

export interface PreviewRow extends Row {
  service_id: string;
  app_id: string;
  org_id: string;
  ref: string;
  pr: number;
  sha: string;
  slug: string;
  head_repo_id: number | null;
  fork: number;
  held: number;
  approved_sha: string | null;
  approved_with_env: number;
  created_at: number;
  last_deploy_at: number;
  expires_at: number;
}

type Link = Pick<LinkRow, "app_id" | "org_id">;
type Store = Pick<Deps, "storage" | "now">;

const HELD = "held:";
const placeholder = (l: Link, pr: number) => `${HELD}${l.app_id}:${pr}`;
const hasService = (p: Pick<PreviewRow, "service_id">) => !p.service_id.startsWith(HELD);
const envContext = (appId: string) => `git.preview_env:${appId}`;

export const previewOf = (deps: Store, l: Link, pr: number) =>
  deps.storage.db.first<PreviewRow>("SELECT * FROM previews WHERE app_id = ? AND org_id = ? AND pr = ?", [l.app_id, l.org_id, pr]);

export async function previewCount(deps: Store, l: Link): Promise<number> {
  const r = await deps.storage.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM previews WHERE app_id = ? AND org_id = ? AND held = 0", [l.app_id, l.org_id]);
  return Number(r?.n ?? 0);
}

/** Records a commit waiting for approval. Takes no service: forks must not be able to spend the plan's quota. */
export async function holdPreview(deps: Store, l: Link, pr: number, ref: string, sha: string, now: number): Promise<void> {
  const id = placeholder(l, pr);
  await deps.storage.db.run(
    `INSERT INTO previews (service_id, app_id, org_id, ref, pr, sha, slug, fork, held, created_at, last_deploy_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, 0, ?)
     ON CONFLICT (app_id, pr) DO UPDATE SET sha = excluded.sha, fork = 1, held = 1, approved_with_env = 0`,
    [id, l.app_id, l.org_id, ref, pr, sha, id, now, now + TTL_S * 1000],
  );
}

/** The live preview service of this request, created or recreated after the node's own expiry. */
export async function ensurePreviewService(
  deps: Store, cli: Scoped, l: Link, pr: number, ref: string, sha: string, fork: boolean, existing: PreviewRow | null,
): Promise<{ service_id: string }> {
  const db = deps.storage.db;
  if (existing && hasService(existing)) {
    try {
      await cli.getService(existing.service_id);
      return { service_id: existing.service_id };
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }
  const made = await cli.createScratch({ of: l.app_id, name: `pr-${pr}`, ttl_seconds: TTL_S });
  const now = deps.now();
  const exp = now + TTL_S * 1000;
  await db.batch([
    { sql: "DELETE FROM previews WHERE app_id = ? AND org_id = ? AND pr = ?", args: [l.app_id, l.org_id, pr] },
    {
      sql: `INSERT INTO previews (service_id, app_id, org_id, ref, pr, sha, slug, head_repo_id, fork, held, approved_sha, approved_with_env, created_at, last_deploy_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?)`,
      args: [made.id, l.app_id, l.org_id, ref, pr, sha, made.slug, existing?.head_repo_id ?? null, fork ? 1 : 0, existing?.approved_sha ?? null, existing?.approved_with_env ?? 0, now, exp],
    },
  ]);
  return { service_id: made.id };
}

export async function previewEnvOf(deps: Pick<Deps, "storage" | "config">, l: Link): Promise<Record<string, string>> {
  const row = await deps.storage.db.first<{ env_sealed: Uint8Array }>("SELECT env_sealed FROM preview_env WHERE app_id = ? AND org_id = ?", [l.app_id, l.org_id]);
  if (!row) return {};
  const plain = await (await sealerOf(deps)).open(new Uint8Array(row.env_sealed), envContext(l.app_id));
  return JSON.parse(new TextDecoder().decode(plain)) as Record<string, string>;
}

async function tearDown(deps: Pick<Deps, "storage" | "now">, tenantId: string, hookId: string | null, p: PreviewRow): Promise<void> {
  const now = deps.now();
  const stmts = [{ sql: "DELETE FROM previews WHERE service_id = ?", args: [p.service_id] as unknown[] }];
  if (hasService(p)) {
    // The retrying delete job does the call, so an outage leaves nothing behind.
    stmts.push({ sql: "INSERT OR IGNORE INTO pending_service_deletes (service_id, tenant_id, attempts, next_at) VALUES (?, ?, 0, ?)", args: [p.service_id, tenantId, now] });
  }
  if (hookId) {
    stmts.push({ sql: "DELETE FROM git_refs WHERE hook_id = ? AND ref = ?", args: [hookId, p.ref] });
    stmts.push({ sql: "UPDATE git_deliveries SET state = 'skipped', error = 'pr_closed', next_at = NULL WHERE hook_id = ? AND event = 'pr' AND ref = ? AND state NOT IN ('deployed','skipped','failed')", args: [hookId, p.ref] });
  }
  await deps.storage.db.batch(stmts as never);
}

const tenantOf = async (deps: Deps, orgId: string) => (await getOrg(await dbOf(deps), orgId))?.tenantId ?? "";

export async function closePreview(deps: Deps, link: LinkRow, pr: number): Promise<void> {
  const p = await previewOf(deps, link, pr);
  if (p) await tearDown(deps, await tenantOf(deps, link.org_id), link.hook_id, p);
}

/** On App delete. The node would expire the services, but they count against the plan until then. */
export async function removePreviewsOf(deps: Deps, orgId: string, tenantId: string, appId: string): Promise<void> {
  const rows = await deps.storage.db.all<PreviewRow>("SELECT * FROM previews WHERE app_id = ? AND org_id = ?", [appId, orgId]);
  for (const p of rows) await tearDown(deps, tenantId, null, p);
  await deps.storage.db.run("DELETE FROM preview_env WHERE app_id = ? AND org_id = ?", [appId, orgId]);
}

function view(c: OrgCtx, p: PreviewRow) {
  const live = hasService(p);
  return {
    pr: p.pr,
    sha: p.sha,
    slug: live ? p.slug : null,
    url: live ? `${c.deps.config.runtimePublicUrl.replace(/\/+$/, "")}/s/${p.slug}/` : null,
    fork: p.fork === 1,
    held: p.held === 1,
    approved_sha: p.approved_sha,
    approved_with_env: p.approved_with_env === 1,
    created_at: p.created_at,
    last_deploy_at: p.last_deploy_at || null,
    expires_at: p.expires_at,
  };
}

const prOf = (raw: string): number => {
  if (!/^[1-9][0-9]{0,15}$/.test(raw)) throw notFound();
  return Number(raw);
};

export async function listPreviews(c: OrgCtx, slug: string) {
  const app = await appFor(c, slug, "app.read");
  const rows = await c.deps.storage.db.all<PreviewRow>("SELECT * FROM previews WHERE app_id = ? AND org_id = ? ORDER BY pr DESC", [app.id, c.org.id]);
  return rows.map((p) => view(c, p));
}

export async function deletePreview(c: OrgCtx, slug: string, rawPr: string): Promise<{ pr: number }> {
  const app = await appFor(c, slug, "app.deploy");
  const pr = prOf(rawPr);
  const p = await previewOf(c.deps, { app_id: app.id, org_id: c.org.id }, pr);
  if (!p) throw notFound();
  const link = await c.deps.storage.db.first<{ hook_id: string }>("SELECT hook_id FROM git_links WHERE app_id = ? AND org_id = ?", [app.id, c.org.id]);
  await tearDown(c.deps, c.org.tenantId, link?.hook_id ?? null, p);
  return { pr };
}

/** Binds to the SHA the admin read: a commit pushed after it is held again, and this answers 409. */
export async function approvePreview(c: OrgCtx, slug: string, rawPr: string, b: Record<string, unknown>) {
  const app = await appFor(c, slug, "app.git.manage");
  const pr = prOf(rawPr);
  const fields: Record<string, string> = {};
  for (const k of Object.keys(b)) if (k !== "sha" && k !== "with_env") fields[k] = "unknown";
  if (typeof b.sha !== "string" || !SHA_RE.test(b.sha)) fields.sha = "pattern";
  if (b.with_env !== undefined && typeof b.with_env !== "boolean") fields.with_env = "not_boolean";
  if (Object.keys(fields).length) throw invalid(fields);
  const db = c.deps.storage.db;
  const p = await previewOf(c.deps, { app_id: app.id, org_id: c.org.id }, pr);
  if (!p) throw notFound();
  if (p.held !== 1) throw conflict("preview_not_held", "this preview is not waiting for approval");
  if (p.sha !== b.sha) throw conflict("preview_sha_changed", "a newer commit arrived; review it first");
  const link = await db.first<{ hook_id: string }>("SELECT hook_id FROM git_links WHERE app_id = ? AND org_id = ?", [app.id, c.org.id]);
  if (!link) throw new AppError(404, "not_found", "not found");
  const now = c.deps.now();
  await db.batch([
    { sql: "UPDATE previews SET approved_sha = ?, approved_with_env = ? WHERE service_id = ?", args: [p.sha, b.with_env === true ? 1 : 0, p.service_id] },
    {
      sql: `UPDATE git_deliveries SET state = 'queued', error = NULL, next_at = ?, attempts = 0 WHERE hook_id = ? AND event = 'pr' AND ref = ? AND sha = ?`,
      args: [now, link.hook_id, p.ref, p.sha],
    },
  ]);
  return { pr, sha: p.sha, with_env: b.with_env === true };
}

export async function getPreviewEnv(c: OrgCtx, slug: string) {
  const app = await appFor(c, slug, "app.env.read");
  return { env: await previewEnvOf(c.deps, { app_id: app.id, org_id: c.org.id }) };
}

export async function putPreviewEnv(c: OrgCtx, slug: string, b: Record<string, unknown>): Promise<string[]> {
  const app = await appFor(c, slug, "app.env.write");
  const env = b.env;
  if (env === null || typeof env !== "object" || Array.isArray(env)) throw invalid({ env: "not_object" });
  const fields: Record<string, string> = {};
  const entries = Object.entries(env as Record<string, unknown>);
  if (entries.length > MAX_ENV) fields.env = "too_many";
  for (const [k, v] of entries) if (!ENV_NAME_RE.test(k) || typeof v !== "string") fields[`env.${k}`] = "invalid_format";
  const plain = new TextEncoder().encode(JSON.stringify(env));
  if (plain.length > MAX_ENV_BYTES) fields.env = "too_large";
  if (Object.keys(fields).length) throw invalid(fields);
  const sealed = await (await sealerOf(c.deps)).seal(plain, envContext(app.id));
  await c.deps.storage.db.run(
    `INSERT INTO preview_env (app_id, org_id, env_sealed, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (app_id) DO UPDATE SET env_sealed = excluded.env_sealed, updated_at = excluded.updated_at WHERE preview_env.org_id = excluded.org_id`,
    [app.id, c.org.id, sealed, c.deps.now()],
  );
  return entries.map(([k]) => k);
}

export const PREVIEW_SWEEP_JOB: Job = {
  name: "preview_sweep",
  everyMs: 5 * 60_000,
  run: async ({ deps }: { deps: RunnerDeps }) => {
    const db = deps.storage.db;
    const due = await db.all<PreviewRow>("SELECT * FROM previews WHERE expires_at <= ? ORDER BY expires_at LIMIT ?", [deps.now(), SWEEP_BATCH]);
    for (const p of due) {
      const link = await db.first<{ hook_id: string }>("SELECT hook_id FROM git_links WHERE app_id = ? AND org_id = ?", [p.app_id, p.org_id]);
      await tearDown(deps, await tenantOf(deps as Deps, p.org_id), link?.hook_id ?? null, p);
    }
    return undefined;
  },
};
