// Housekeeping run by the runtime cron (`scheduled()` in main.ts). Each step is
// independent: a failure is logged and the next step still runs.
//   - expire sessions and unaccepted expired invites
//   - retry pending runtime key revokes (pending_key_revokes, exponential backoff)
//   - domain checker: pending/active TXT checks, queued unmaps, runtime reconcile
//   - app index backfill: lists the Apps of a few not yet indexed orgs into app_index (tls-ask)

import type { Deps } from "./app.ts";
import { checkOnce } from "./domains/checker.ts";
import type { DomainDeps } from "./domains/domains.ts";
import { retryPendingRevokes } from "./keys/keys.ts";
import { appIndexBackfill } from "./apps/index-table.ts";

export type JobDeps = Pick<Deps, "storage" | "now" | "config" | "rtctl" | "txt" | "fetch">;

export { revokeBackoff } from "./keys/keys.ts";

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
    ["retry key revokes", async () => (deps.rtctl ? retryPendingRevokes(deps) : 0)],
    ["domain checker", () => checkOnce(deps as DomainDeps)],
    ["app index backfill", () => appIndexBackfill(deps)],
  ];
  for (const [name, f] of steps) {
    try {
      await f();
    } catch (e) {
      console.error(`jobs: ${name} failed`, e instanceof Error ? e.message : String(e));
    }
  }
}
