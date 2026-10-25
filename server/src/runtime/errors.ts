// Maps control-API and transport failures to the api-web error envelope (§1.5).
// The one mapper: the router applies it to any uncaught runtime error, and
// services that need the mapped code mid-flow call `mapRuntimeError` / `rt`.

import { AppError } from "../http/errors.ts";
import type { Handler, RequestContext } from "../http/router.ts";
import { RuntimeError, RuntimeUnavailable } from "./client.ts";

/** The AppError for a runtime failure, or null when e is not one. */
export function runtimeAppError(e: unknown): AppError | null {
  if (e instanceof RuntimeUnavailable) return unavailable(e);
  if (!(e instanceof RuntimeError)) return null;
  const retry = { retry_after: e.retryAfter ?? 1 };
  const msg = bare(e);
  if (e.status === 503 && (e.code === "queue_timeout" || e.code === "overloaded")) {
    return new AppError(503, "busy", "runtime busy", retry);
  }
  if (e.status === 429) return new AppError(429, e.code, "runtime rate limited", retry);
  if (e.status === 404) return new AppError(404, "not_found", "not found");
  if (e.status === 412) return new AppError(409, "stale", "changed elsewhere, reload");
  if (e.status === 409) return new AppError(409, e.code === "project_slug_taken" ? "slug_taken" : e.code, msg || e.code);
  if (e.status === 403 && PLAN_LIMIT.has(e.code)) return new AppError(403, "plan_limit", "the plan does not allow this");
  if (e.status === 400 || e.status === 422) return new AppError(422, e.code, msg, asDetails(e.details));
  if (e.status >= 400 && e.status < 500) return new AppError(e.status, e.code, msg, asDetails(e.details));
  // control_disabled and every other runtime 5xx: the runtime cannot serve us.
  return unavailable(e);
}

/** The client only sees "runtime unavailable": keep the cause in the service log for the operator. */
function unavailable(e: Error): AppError {
  console.error("runtime unavailable:", e.message);
  return new AppError(502, "runtime_unavailable", "runtime unavailable");
}

const PLAN_LIMIT = new Set(["trigger_not_allowed", "quota_exceeded"]);

/** The runtime's own message without the "runtime: 409 code: " prefix. */
const bare = (e: RuntimeError) => e.message.replace(/^runtime: \d+ [a-z_0-9]+: /, "");

const asDetails =(d: unknown): Record<string, unknown> | undefined =>
  d !== null && typeof d === "object" && !Array.isArray(d) && Object.keys(d).length > 0
    ? (d as Record<string, unknown>)
    : undefined;

/** Runtime failures become AppErrors; anything else is returned unchanged. */
export function mapRuntimeError(e: unknown): unknown {
  return runtimeAppError(e) ?? e;
}

/** Runs fn, mapping runtime errors. */
export async function rt<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw mapRuntimeError(e);
  }
}

/** Wraps h so runtime failures surface as AppError with the mapped code. */
export function withRuntimeErrors(h: Handler): Handler {
  return async (ctx: RequestContext) => rt(async () => h(ctx));
}
