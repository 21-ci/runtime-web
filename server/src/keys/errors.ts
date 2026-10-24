// Maps runtime control-API failures to the app error envelope so a runtime 4xx or
// 5xx reaches the client with its own status and code instead of a bare 500.

import { AppError } from "../http/errors.ts";
import type { Handler } from "../http/router.ts";
import { isRuntimeError, RuntimeUnavailable } from "../runtime/client.ts";

export function asAppError(e: unknown): unknown {
  if (isRuntimeError(e) && e.status >= 400 && e.status < 600) {
    const details = e.details && typeof e.details === "object" ? (e.details as Record<string, unknown>) : {};
    return new AppError(e.status, e.code, e.message, details);
  }
  if (e instanceof RuntimeUnavailable) return new AppError(502, "runtime_unavailable", e.message);
  return e;
}

/** Wraps a handler so runtime failures leave it as AppErrors. */
export function withRuntimeErrors(h: Handler): Handler {
  return async (ctx) => {
    try {
      return await h(ctx);
    } catch (e) {
      throw asAppError(e);
    }
  };
}
