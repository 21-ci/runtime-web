// Maps control-API and transport failures to the api-web error envelope (§1.5).
// Route handlers wrap their body with `withRuntimeErrors`; unknown shapes stay
// as they are and become 500 `internal` in the router.

import { AppError } from "../http/errors.ts";
import type { Handler, RequestContext } from "../http/router.ts";
import { RuntimeError, RuntimeUnavailable } from "./client.ts";

export function runtimeAppError(e: unknown): AppError | null {
  if (e instanceof RuntimeUnavailable) return new AppError(502, "runtime_unavailable", "runtime unavailable");
  if (!(e instanceof RuntimeError)) return null;
  const retry = e.retryAfter !== undefined ? { retry_after: e.retryAfter } : undefined;
  if (e.status === 503 && e.code === "control_disabled") return new AppError(502, "runtime_unavailable", "runtime unavailable");
  if (e.status === 503 && (e.code === "queue_timeout" || e.code === "overloaded")) {
    return new AppError(503, "busy", "runtime busy", retry);
  }
  if (e.status === 429) return new AppError(429, e.code, "runtime rate limited", retry);
  if (e.status === 404) return new AppError(404, "not_found", "not found");
  if (e.status === 409) return new AppError(409, e.code, e.message);
  if (e.status === 412) return new AppError(409, "stale", "changed elsewhere, reload");
  if (e.status === 422) return new AppError(422, e.code, e.message, asDetails(e.details));
  return null;
}

const asDetails = (d: unknown): Record<string, unknown> | undefined =>
  d !== null && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : undefined;

/** Wraps h so runtime failures surface as AppError with the mapped code. */
export function withRuntimeErrors(h: Handler): Handler {
  return async (ctx: RequestContext) => {
    try {
      return await h(ctx);
    } catch (e) {
      const mapped = runtimeAppError(e);
      if (mapped) throw mapped;
      throw e;
    }
  };
}
