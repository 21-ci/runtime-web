// Operator views of the runtime node (port of internal/admin). Calls use the
// operator binding. Every mutation writes a pending audit row before the runtime
// call and an applied or failed row after it; a failed intent row aborts the change.

import type { Deps } from "../app.ts";
import { dbOf } from "../auth/types.ts";
import { invalid } from "../http/errors.ts";
import { isRuntimeError } from "../runtime/client.ts";
import type { NodeConfigApplied, NodeConfigUpdate } from "../runtime/types.ts";
import { auditIn } from "../audit/audit.ts";
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
