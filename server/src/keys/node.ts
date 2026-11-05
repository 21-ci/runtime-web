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
import { rtOf, type Actor } from "./keys.ts";

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

export const nodeStats = (deps: Deps, cursor: string | undefined) => rtOf(deps).op().nodeStats({ fields: "counts", limit: 100, cursor });

export function nodeEvents(deps: Deps, q: { after: string | null; kinds: string | null; limit: string | null }) {
  const errs: Record<string, string> = {};
  if (q.after !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(q.after)) errs.after = "invalid";
  if (q.kinds !== null && !/^[a-z0-9_.]+(,[a-z0-9_.]+){0,31}$/.test(q.kinds)) errs.kinds = "invalid";
  const limit = q.limit === null ? 50 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) errs.limit = "out_of_range";
  if (Object.keys(errs).length) throw invalid(errs);
  return rtOf(deps).op().nodeEvents({ after: q.after ?? undefined, kinds: q.kinds ?? undefined, limit });
}

export const backupStatus = (deps: Deps) => rtOf(deps).op().backupStatus();

export function listBackups(deps: Deps, cursor: string | null) {
  if (cursor !== null && cursor.length > 256) throw invalid({ cursor: "invalid" });
  return rtOf(deps).op().listBackups({ limit: 50, cursor: cursor ?? undefined });
}

export const createBackup = (deps: Deps, actor: Actor) => audited(deps, actor, "node.backup.create", {}, () => rtOf(deps).op().createBackup());

export const nodeStatus = (deps: Deps) => rtOf(deps).op().nodeStatus();
export const nodeConfig = (deps: Deps) => rtOf(deps).op().nodeConfig();
export const nodeCache = (deps: Deps) => rtOf(deps).op().nodeCache();
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
