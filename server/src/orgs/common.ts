// Runtime client access shared by orgs, users and invites. Error mapping lives in
// src/runtime/errors.ts, audit rows in src/audit/audit.ts.

import type { Deps } from "../app.ts";
import { AppError } from "../http/errors.ts";
import { Runtime } from "../runtime/client.ts";

import type { AuditActor } from "../audit/audit.ts";

/** A signed-in user as audit actor. */
export type Actor = AuditActor & { userId: string };

export function runtimeOf(deps: Pick<Deps, "rtctl">): Runtime {
  if (!deps.rtctl) throw new AppError(502, "runtime_unavailable", "runtime control API not configured");
  return new Runtime(deps.rtctl);
}
