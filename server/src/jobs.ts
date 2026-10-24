// Housekeeping run by the runtime cron (`scheduled()` in main.ts). Each step is
// independent: a failure is logged and the next step still runs.
//   - expire sessions and unaccepted expired invites
//   - retry pending runtime key revokes (pending_key_revokes, exponential backoff)
//   - domain checker: pending/active TXT checks, queued unmaps, runtime reconcile

import type { Deps } from "./app.ts";
import { checkOnce } from "./domains/checker.ts";
import type { DomainDeps } from "./domains/domains.ts";
import { isNotFound, Runtime } from "./runtime/client.ts";

export type JobDeps = Pick<Deps, "storage" | "now" | "config" | "rtctl" | "txt" | "fetch">;

export const REVOKE_BASE_MS = 60_000;
export const REVOKE_MAX_MS = 3600_000;

export function revokeBackoff(attempts: number): number {
  return Math.min(REVOKE_BASE_MS * 2 ** attempts, REVOKE_MAX_MS);
}

type PendingRevoke = {
  runtime_key_id: string;
  tenant_id: string;
  attempts: number;
};

/** Retries operator revokes of org keys that failed earlier. Returns how many were done. */
export async function retryKeyRevokes(deps: JobDeps): Promise<number> {
  if (!deps.rtctl) return 0;
  const db = deps.storage.db;
  const now = deps.now();
  const due = await db.all<PendingRevoke>(
    "SELECT runtime_key_id, tenant_id, attempts FROM pending_key_revokes WHERE next_at <= ?",
    [now],
  );
  let done = 0;
  const rt = new Runtime(deps.rtctl);
  for (const r of due) {
    try {
      await rt.op().revokeTenantKey(r.tenant_id, r.runtime_key_id);
    } catch (e) {
      if (!isNotFound(e)) {
        const attempts = r.attempts + 1;
        await db.run("UPDATE pending_key_revokes SET attempts = ?, next_at = ? WHERE runtime_key_id = ?", [
          attempts,
          now + revokeBackoff(attempts),
          r.runtime_key_id,
        ]);
        continue;
      }
    }
    await db.run("DELETE FROM pending_key_revokes WHERE runtime_key_id = ?", [r.runtime_key_id]);
    done++;
  }
  return done;
}

/** Expires server-side sessions and invites that were never accepted. */
export async function expireRows(deps: Pick<JobDeps, "storage" | "now">): Promise<void> {
  const db = deps.storage.db;
  const now = deps.now();
  await db.run("DELETE FROM sessions WHERE expires_at <= ?", [now]);
  await db.run("DELETE FROM invites WHERE accepted_at IS NULL AND expires_at <= ?", [now]);
}

export async function scheduled(deps: JobDeps): Promise<void> {
  const steps: [string, () => Promise<unknown>][] = [
    ["expire rows", () => expireRows(deps)],
    ["retry key revokes", () => retryKeyRevokes(deps)],
    ["domain checker", () => checkOnce(deps as DomainDeps)],
  ];
  for (const [name, f] of steps) {
    try {
      await f();
    } catch (e) {
      console.error(`jobs: ${name} failed`, e instanceof Error ? e.message : String(e));
    }
  }
}
