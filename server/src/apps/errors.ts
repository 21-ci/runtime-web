// Runtime error → web error mapping for app routes (port of internal/apps mapErr
// and internal/api mapRuntime, api-web §1.5).

import { AppError, conflict, forbidden, notFound } from "../http/errors.ts";
import { RuntimeError, RuntimeUnavailable, isBusy, isDisabled, isThrottled } from "../runtime/client.ts";

/** AppError that also sets Retry-After (seconds). */
export class RetryError extends AppError {
  constructor(status: number, code: string, message: string, readonly retryAfter: number) {
    super(status, code, message, { retry_after: retryAfter });
  }
}

const PLAN_LIMIT = new Set(["trigger_not_allowed", "quota_exceeded"]);

export function mapRuntime(e: unknown): unknown {
  if (e instanceof RuntimeUnavailable) return new AppError(502, "runtime_unavailable", "runtime unavailable");
  if (!(e instanceof RuntimeError)) return e;
  if (isBusy(e)) return new RetryError(503, "busy", "runtime is busy, retry shortly", e.retryAfter ?? 1);
  if (isThrottled(e)) return new RetryError(429, e.code, "runtime limit reached, retry shortly", e.retryAfter ?? 1);
  if (isDisabled(e)) return new AppError(502, "runtime_unavailable", "runtime unavailable");
  switch (e.status) {
    case 404:
      return notFound();
    case 412:
      return conflict("stale", "changed elsewhere, reload and try again");
    case 409:
      return conflict(e.code === "project_slug_taken" ? "slug_taken" : e.code, e.message.replace(/^runtime: \d+ [a-z_0-9]+: /, "") || e.code);
    case 403:
      if (PLAN_LIMIT.has(e.code)) return forbidden("plan_limit", "the plan does not allow this");
      break;
    case 400:
    case 422: {
      const d = e.details;
      const details = d && typeof d === "object" && Object.keys(d).length > 0 ? (d as Record<string, unknown>) : undefined;
      return new AppError(422, e.code, e.message.replace(/^runtime: \d+ [a-z_0-9]+: /, ""), details);
    }
  }
  console.error("apps: runtime error", e.message);
  return new AppError(500, "internal", "internal error");
}

/** Runs fn, mapping runtime errors. */
export async function rt<V>(fn: () => Promise<V>): Promise<V> {
  try {
    return await fn();
  } catch (e) {
    throw mapRuntime(e);
  }
}
