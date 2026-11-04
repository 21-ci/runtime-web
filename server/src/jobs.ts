// Housekeeping run by the runtime cron (`scheduled()` in main.ts) through the job runner. Each job is
// independent: a failure is logged and the next job still runs.
//   - expire sessions and unaccepted expired invites
//   - retry pending runtime key revokes (pending_key_revokes, exponential backoff)
//   - domain checker: pending/active TXT checks, queued unmaps, runtime reconcile
//   - app index backfill: lists the Apps of a few not yet indexed orgs into app_index (tls-ask)
//   - retry deletes of services orphaned by a failed app create (pending_service_deletes, backoff)
//   - legacy reseal: one pass that binds every no-AAD sealed value to its context (crypto/reseal.ts)

import type { Deps } from "./app.ts";
import { checkOnce } from "./domains/checker.ts";
import type { DomainDeps } from "./domains/domains.ts";
import { retryPendingRevokes } from "./keys/keys.ts";
import { appIndexBackfill } from "./apps/index-table.ts";
import { resealLegacy } from "./crypto/reseal.ts";
import { retryPendingServiceDeletes } from "./apps/service.ts";
import { ensureMigrated } from "./db/migrate.ts";
import { runJobs, type Job, type RunnerDeps } from "./jobs/runner.ts";

export type JobDeps = RunnerDeps;

export { revokeBackoff } from "./keys/keys.ts";

/** Expires server-side sessions and invites that were never accepted. */
export async function expireRows(deps: Pick<JobDeps, "storage" | "now">): Promise<void> {
  const db = deps.storage.db;
  const now = deps.now();
  await db.run("DELETE FROM sessions WHERE expires_at <= ?", [now]);
  await db.run("DELETE FROM invites WHERE accepted_at IS NULL AND expires_at <= ?", [now]);
}

const EVERY_MS = 5 * 60_000;

/** In fixed order. Anything that sends to a third party goes last. */
export const HOUSEKEEPING_JOBS: readonly Job[] = [
  { name: "expire_rows", everyMs: EVERY_MS, run: async ({ deps }) => void (await expireRows(deps)) },
  { name: "key_revokes", everyMs: EVERY_MS, run: async ({ deps }) => void (deps.rtctl ? await retryPendingRevokes(deps) : 0) },
  { name: "domain_checker", everyMs: EVERY_MS, run: async ({ deps }) => void (await checkOnce(deps as DomainDeps)) },
  { name: "app_index_backfill", everyMs: EVERY_MS, run: async ({ deps }) => void (await appIndexBackfill(deps)) },
  { name: "service_deletes", everyMs: EVERY_MS, run: async ({ deps }) => void (deps.rtctl ? await retryPendingServiceDeletes(deps as Deps) : 0) },
  { name: "legacy_reseal", everyMs: EVERY_MS, run: async ({ deps }) => void (await resealLegacy(deps)) },
];

/** No payload counts as a tick; so does the schedule an older install left behind until it is removed. */
function isTick(payload: unknown): boolean {
  if (payload === null || payload === undefined) return true;
  const job = (payload as { job?: unknown }).job;
  return job === "tick" || job === "housekeeping";
}

export async function scheduled(deps: JobDeps, payload?: unknown): Promise<void> {
  if (!isTick(payload)) {
    console.warn("jobs: ignored a schedule with an unknown job");
    return;
  }
  // A cron can fire before the first request after an upgrade.
  await ensureMigrated(deps.storage.db);
  await runJobs(deps, HOUSEKEEPING_JOBS);
}
