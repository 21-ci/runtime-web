// Helpers shared by orgs, users and invites: runtime client access, runtime error
// mapping (api-web §1.5) and audit rows (until src/audit lands, T8 reads the same table).

import type { Deps } from "../app.ts";
import { AppError, notFound } from "../http/errors.ts";
import { newId } from "../crypto/random.ts";
import { Runtime, isBusy, isDisabled, isNotFound, isRuntimeError, isThrottled, isUnavailable } from "../runtime/client.ts";
import type { Stmt } from "../storage/types.ts";

export function runtimeOf(deps: Pick<Deps, "rtctl">): Runtime {
  if (!deps.rtctl) throw new AppError(502, "runtime_unavailable", "runtime control API not configured");
  return new Runtime(deps.rtctl);
}

/** Maps a runtime client error to the api-web envelope; other errors pass through unchanged. */
export function mapRuntimeError(e: unknown): unknown {
  if (e instanceof AppError) return e;
  if (isUnavailable(e) || isDisabled(e)) return new AppError(502, "runtime_unavailable", "runtime unavailable");
  if (!isRuntimeError(e)) return e;
  if (isNotFound(e)) return notFound();
  const retry = e.retryAfter !== undefined ? { retry_after: e.retryAfter } : undefined;
  if (isBusy(e)) return new AppError(503, "busy", "runtime busy", retry);
  if (isThrottled(e)) return new AppError(429, e.code, "runtime rate limited", retry);
  if (e.status === 412) return new AppError(409, "stale", "changed elsewhere");
  if (e.status === 422) return new AppError(422, e.code, e.message, (e.details as Record<string, unknown>) ?? {});
  return e;
}

/** Runs fn, mapping runtime errors. */
export async function rt<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw mapRuntimeError(e);
  }
}

export interface Actor {
  userId: string;
  /** The caller acts through the instance-admin override (not a member with the needed role). */
  asInstanceAdmin?: boolean;
}

/** One audit row; data carries as_instance_admin when set. */
export function auditStmt(now: number, actor: Actor, orgId: string | null, action: string, target: string, data: Record<string, unknown> = {}): Stmt {
  const d = actor.asInstanceAdmin ? { ...data, as_instance_admin: true } : data;
  return {
    sql: "INSERT INTO audit (id, ts, org_id, actor_id, action, target, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [newId("aud_", now), now, orgId, actor.userId, action, target, JSON.stringify(d)],
  };
}
