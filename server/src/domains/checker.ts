// Domain checker, run from scheduled().
// pending: re-verified every 60 s, failed after 24 h. active: re-checked every 6 h,
// deactivated after 3 consecutive TXT misses. Runtime: queued unmaps are retried and
// active hosts the runtime lost are re-PUT. Each step logs and continues on failure.

import { auditStmt, type AuditActor } from "../audit/audit.ts";
import { newId } from "../crypto/random.ts";
import { isRuntimeError } from "../runtime/client.ts";
import type { Stmt } from "../storage/types.ts";
import {
  activate,
  type DomainDeps,
  type DomainRow,
  listHostsOf,
  markChecked,
  type PendingUnmap,
  runtimeOf,
  STATUS_ACTIVE,
  STATUS_FAILED,
  STATUS_PENDING,
  txtMatches,
  unmapHost,
} from "./domains.ts";

export const PENDING_EVERY_MS = 60_000;
export const PENDING_TTL_MS = 24 * 3600_000;
export const ACTIVE_EVERY_MS = 6 * 3600_000;
export const MAX_TXT_MISSES = 3;
const SYSTEM: AuditActor = {};

const elapsedAtLeast = (now: number, last: number | null, ms: number) => last === null || now - last >= ms;

function warn(msg: string, host: string, e: unknown): void {
  console.warn(`domains: ${msg}`, host, e instanceof Error ? e.message : String(e));
}

export async function checkOnce(deps: DomainDeps): Promise<void> {
  const db = deps.storage.db;
  const now = deps.now();
  const pending = await db.all<DomainRow>("SELECT * FROM domains WHERE status = ?", [STATUS_PENDING]);
  for (const d of pending) {
    await run(d.host, () => checkPending(deps, d, now));
  }
  const active = await db.all<DomainRow>("SELECT * FROM domains WHERE status = ?", [STATUS_ACTIVE]);
  for (const d of active) {
    await run(d.host, () => checkActive(deps, d, now));
  }
  const unmaps = await db.all<PendingUnmap>("SELECT id, org_id, service_id, host FROM pending_unmaps");
  for (const m of unmaps) {
    await run(m.host, () => unmapHost(deps, m));
  }
  await reconcile(deps);
}

async function run(host: string, f: () => Promise<unknown>): Promise<void> {
  try {
    await f();
  } catch (e) {
    warn("check failed", host, e);
  }
}

async function checkPending(deps: DomainDeps, d: DomainRow, now: number): Promise<void> {
  if (now - d.created_at >= PENDING_TTL_MS) {
    await deps.storage.db.batch([
      { sql: "UPDATE domains SET status = ? WHERE id = ?", args: [STATUS_FAILED, d.id] },
      auditStmt(deps, { actor: SYSTEM, orgId: d.org_id, action: "domain.expire", target: d.host }),
    ]);
    return;
  }
  if (!elapsedAtLeast(now, d.last_checked_at, PENDING_EVERY_MS)) return;
  if (await txtMatches(deps, d)) {
    await activate(deps, d, SYSTEM);
    return;
  }
  await markChecked(deps.storage.db, d.id, now, 0);
}

async function checkActive(deps: DomainDeps, d: DomainRow, now: number): Promise<void> {
  if (!elapsedAtLeast(now, d.last_checked_at, ACTIVE_EVERY_MS)) return;
  if (await txtMatches(deps, d)) {
    await markChecked(deps.storage.db, d.id, now, 0);
    return;
  }
  const misses = d.txt_misses + 1;
  await markChecked(deps.storage.db, d.id, now, misses);
  if (misses < MAX_TXT_MISSES) return;
  // Drop the route and queue the runtime DELETE in one batch; the retry below finishes it.
  const m: PendingUnmap = { id: newId("unm_", now), org_id: d.org_id, service_id: d.service_id, host: d.host };
  const stmts: Stmt[] = [
    { sql: "UPDATE domains SET status = ? WHERE id = ?", args: [STATUS_FAILED, d.id] },
    {
      sql: "INSERT INTO pending_unmaps (id, org_id, service_id, host, created_at) VALUES (?, ?, ?, ?, ?)",
      args: [m.id, m.org_id, m.service_id, m.host, now],
    },
    auditStmt(deps, { actor: SYSTEM, orgId: d.org_id, action: "domain.deactivate", target: d.host, detail: { txt_misses: misses } }),
  ];
  await deps.storage.db.batch(stmts);
  await unmapHost(deps, m);
}

/** Re-PUTs active hosts the runtime lost (missing, or still pending_verification). */
async function reconcile(deps: DomainDeps): Promise<void> {
  const active = await deps.storage.db.all<DomainRow>("SELECT * FROM domains WHERE status = ?", [STATUS_ACTIVE]);
  const byService = new Map<string, DomainRow[]>();
  for (const d of active) byService.set(d.service_id, [...(byService.get(d.service_id) ?? []), d]);
  for (const [svc, rows] of byService) {
    let hosts: { host: string; status: string }[];
    try {
      hosts = await listHostsOf(deps, svc);
    } catch (e) {
      warn("reconcile list hosts failed", svc, e);
      continue;
    }
    for (const d of rows) {
      const have = hosts.find((h) => h.host === d.host);
      if (have && have.status !== "pending_verification") continue;
      try {
        await runtimeOf(deps).op().putHost(svc, d.host);
      } catch (e) {
        if (!isRuntimeError(e) || e.status !== 409) warn("reconcile put failed", d.host, e);
      }
    }
  }
}
