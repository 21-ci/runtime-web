// Operator views of the runtime node. Calls use the
// operator binding. Every mutation writes a pending audit row before the runtime
// call and an applied or failed row after it; a failed intent row aborts the change.

import type { Deps } from "../app.ts";
import { dbOf } from "../auth/types.ts";
import { invalid } from "../http/errors.ts";
import { isRuntimeError } from "../runtime/client.ts";
import type { NodeConfigApplied, NodeConfigUpdate } from "../runtime/types.ts";
import { auditIn } from "../audit/audit.ts";
import { NODE_SCOPE } from "../metrics/collect.ts";
import { HOUR_STEP_S, readRollups } from "../metrics/rollups.ts";
import { appIndexAll } from "../apps/index-table.ts";
import { rethrowBudget } from "../jobs/budget.ts";
import { getOrg } from "../orgs/orgs.ts";
import { defaultKeySecret, rtOf, type Actor } from "./keys.ts";

const CONFIG_FIELDS = ["degradation_mode", "default_profile", "rate_limit"] as const;

/** Parses a node config patch. Unknown fields or an empty patch are 422 invalid. */
export function parseNodeConfig(body: unknown): NodeConfigUpdate {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid({ body: "expected an object" });
  const b = body as Record<string, unknown>;
  const errs: Record<string, string> = {};
  for (const k of Object.keys(b)) if (!(CONFIG_FIELDS as readonly string[]).includes(k)) errs[k] = "unknown field";
  if (b.degradation_mode !== undefined && typeof b.degradation_mode !== "string") errs.degradation_mode = "must be a string";
  if (b.default_profile !== undefined && typeof b.default_profile !== "string") errs.default_profile = "must be a string";
  if (b.rate_limit !== undefined && (!b.rate_limit || typeof b.rate_limit !== "object" || Array.isArray(b.rate_limit))) {
    errs.rate_limit = "must be an object";
  }
  if (Object.keys(errs).length) throw invalid(errs);
  const out: NodeConfigUpdate = {};
  if (b.degradation_mode !== undefined) out.degradation_mode = b.degradation_mode as string;
  if (b.default_profile !== undefined) out.default_profile = b.default_profile as string;
  if (b.rate_limit !== undefined) out.rate_limit = b.rate_limit;
  if (Object.keys(out).length === 0) throw invalid({ body: "no fields" });
  return out;
}

const failCode = (e: unknown) => (isRuntimeError(e) && e.code ? e.code : "internal");

/** Writes the intent row (throws on failure), runs the change, then writes the outcome row. */
async function audited<T>(
  deps: Deps,
  actor: Actor,
  action: string,
  detail: Record<string, unknown>,
  change: () => Promise<T>,
): Promise<T> {
  const db = await dbOf(deps);
  const now = deps.now();
  await db.tx((tx) => auditIn(tx, now, { orgId: null, actor: { userId: actor.id }, action, target: "node", detail: { ...detail, status: "pending" } }));
  let out: T;
  try {
    out = await change();
  } catch (e) {
    await auditIn(db, deps.now(), {
      orgId: null,
      actor: { userId: actor.id },
      action,
      target: "node",
      detail: { ...detail, status: "failed", error_code: failCode(e) },
    }).catch(() => undefined);
    throw e;
  }
  await auditIn(db, deps.now(), { orgId: null, actor: { userId: actor.id }, action, target: "node", detail: { ...detail, status: "applied" } });
  return out;
}

const SERIES_RANGES = ["1h", "6h", "24h"];
const WEEK_MS = 7 * 86_400_000;

/** 1h to 24h from the node; 7d from the ring, which says how far back it reaches. */
export async function nodeSeries(deps: Deps, range: string): Promise<{ range: string; step_s: number; points: unknown[]; data_from: number | null }> {
  if (range === "7d") {
    const now = deps.now();
    const rows = await readRollups(deps.storage.db, NODE_SCOPE, HOUR_STEP_S, now - WEEK_MS, now);
    return { range, step_s: HOUR_STEP_S, points: rows.map((r) => ({ ts: r.ts, ...r.data })), data_from: rows[0]?.ts ?? null };
  }
  if (!SERIES_RANGES.includes(range)) throw invalid({ range: "not_one_of" });
  const out = await rtOf(deps).op().nodeSeries(range);
  return { ...out, data_from: out.points[0]?.ts ?? null };
}

/** Live orgs by runtime tenant. A tenant that is in no org belongs to the node itself (the console, operator SDKs). */
async function orgsByTenant(deps: Deps): Promise<Map<string, string>> {
  const db = await dbOf(deps);
  const rows = await db.all<{ slug: string; tenant_id: string }>("SELECT slug, tenant_id FROM orgs WHERE deleted_at IS NULL");
  return new Map(rows.map((r) => [r.tenant_id, r.slug]));
}

/** The node's busiest services, each saying which org it serves; `system` marks the node's own. */
export async function nodeStats(deps: Deps, cursor: string | undefined) {
  const [page, orgs] = await Promise.all([rtOf(deps).op().nodeStats({ fields: "counts", limit: 100, cursor }), orgsByTenant(deps)]);
  return { ...page, items: page.items.map((s) => ({ ...s, org: orgs.get(s.tenant) ?? null, system: !orgs.has(s.tenant) })) };
}

export async function nodeEvents(deps: Deps, q: { after: string | null; kinds: string | null; limit: string | null }) {
  const errs: Record<string, string> = {};
  if (q.after !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(q.after)) errs.after = "invalid";
  if (q.kinds !== null && !/^[a-z0-9_.]+(,[a-z0-9_.]+){0,31}$/.test(q.kinds)) errs.kinds = "invalid";
  const limit = q.limit === null ? 50 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) errs.limit = "out_of_range";
  if (Object.keys(errs).length) throw invalid(errs);
  const page = await rtOf(deps).op().nodeEvents({ after: q.after ?? undefined, kinds: q.kinds ?? undefined, limit });
  const db = await dbOf(deps);
  const [index, orgs] = await Promise.all([appIndexAll(db), orgsByTenant(deps)]);
  const slugs = new Map(index.map((e) => [e.serviceId, e.slug]));
  // The index holds neither branches nor the node's own services; what had traffic lately is named by the node.
  if (page.items.some((e) => e.service && !slugs.has(e.service))) {
    const stats = await rtOf(deps).op().nodeStats({ fields: "counts", limit: 100 }).catch(() => null);
    for (const s of stats?.items ?? []) if (s.slug && !slugs.has(s.service)) slugs.set(s.service, s.slug);
  }
  return {
    ...page,
    items: page.items.map((e) => ({
      ...e,
      app: e.service ? (slugs.get(e.service) ?? null) : null,
      org: e.tenant ? (orgs.get(e.tenant) ?? null) : null,
    })),
  };
}

/** Versions listed per cache view at most: this is one runtime call per App, on an admin's page view. */
const CACHE_LOOKUP_APPS = 40;

/** The cache's figures, plus which App version each top digest is. A digest of no indexed App (system, removed) stays unnamed. */
export async function nodeCache(deps: Deps): Promise<Record<string, unknown>> {
  const cache = (await rtOf(deps).op().nodeCache()) as Record<string, unknown> | null;
  const out = cache && typeof cache === "object" ? cache : {};
  const top = (out.top ?? {}) as Record<string, unknown>;
  const wanted = new Set(Object.values(top).flatMap((v) => (Array.isArray(v) ? v.filter((d): d is string => typeof d === "string") : [])));
  const owners: Record<string, { org: string; app: string; version: number }> = {};
  if (wanted.size === 0) return { ...out, owners };
  const db = await dbOf(deps);
  for (const e of (await appIndexAll(db)).slice(0, CACHE_LOOKUP_APPS)) {
    if (Object.keys(owners).length >= wanted.size) break;
    try {
      const org = await getOrg(db, e.orgId);
      if (!org) continue;
      const versions = await rtOf(deps).as(await defaultKeySecret(deps, org)).listVersions(e.serviceId);
      for (const v of versions) {
        if (wanted.has(v.source_digest) && !owners[v.source_digest]) owners[v.source_digest] = { org: org.slug, app: e.slug, version: v.version };
      }
    } catch (err) {
      // An App that cannot be read leaves its digest unnamed; the rest of the page still answers.
      rethrowBudget(err);
    }
  }
  return { ...out, owners };
}

export const backupStatus = (deps: Deps) => rtOf(deps).op().backupStatus();

export function listBackups(deps: Deps, cursor: string | null) {
  if (cursor !== null && cursor.length > 256) throw invalid({ cursor: "invalid" });
  return rtOf(deps).op().listBackups({ limit: 50, cursor: cursor ?? undefined });
}

export const createBackup = (deps: Deps, actor: Actor) => audited(deps, actor, "node.backup.create", {}, () => rtOf(deps).op().createBackup());

export const nodeStatus = (deps: Deps) => rtOf(deps).op().nodeStatus();
export const nodeConfig = (deps: Deps) => rtOf(deps).op().nodeConfig();
export const nodeScheduler = (deps: Deps) => rtOf(deps).op().nodeScheduler();

export async function runtimeVersion(deps: Deps): Promise<{ version: string; web_version: string }> {
  const v = await rtOf(deps).op().runtimeVersion();
  return { version: v.version, web_version: deps.version };
}

export async function setNodeConfig(deps: Deps, actor: Actor, patch: NodeConfigUpdate): Promise<NodeConfigApplied> {
  const detail: Record<string, unknown> = { ...patch };
  if (patch.rate_limit !== undefined) detail.rate_limit = true;
  return audited(deps, actor, "node.config.update", detail, async () => {
    const out = await rtOf(deps).op().putNodeConfig(patch);
    return out;
  });
}

/** Drains the node. The route must already have checked body {confirm: "drain"}. */
export async function drainNode(deps: Deps, actor: Actor): Promise<unknown> {
  return audited(deps, actor, "node.drain", {}, () => rtOf(deps).op().drainNode());
}
