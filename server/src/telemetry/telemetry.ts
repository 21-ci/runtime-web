// The console's one part in telemetry: it tells the runtime how many users it has. The runtime is the only sender and
// honours the operator's opt-out; nothing here contacts a telemetry URL, and the count says nothing about any user.

import type { Deps } from "../app.ts";
import type { Job } from "../jobs/runner.ts";
import { rethrowBudget } from "../jobs/budget.ts";
import { Runtime } from "../runtime/client.ts";

const DAY_MS = 24 * 3_600_000;

/** Whether the node reports. `sending` is null on a node or binding that does not answer this route yet. */
export async function telemetryView(deps: Pick<Deps, "rtctl">): Promise<{ sending: boolean | null }> {
  if (!deps.rtctl) return { sending: null };
  try {
    return { sending: (await new Runtime(deps.rtctl).op().telemetryPreview()).sending === true };
  } catch {
    return { sending: null };
  }
}

export const TELEMETRY_USERS_JOB: Job = {
  name: "telemetry_users",
  everyMs: DAY_MS,
  run: async ({ deps }) => {
    if (!deps.rtctl) return undefined;
    try {
      const row = await deps.storage.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL");
      await new Runtime(deps.rtctl).op().putConsoleTelemetry(row?.n ?? 0);
    } catch (e) {
      rethrowBudget(e);
      // An older node has no such route, and a missed count only makes the runtime report null. Not worth a retry.
      console.warn("telemetry: user count not delivered");
    }
    return undefined;
  },
};
