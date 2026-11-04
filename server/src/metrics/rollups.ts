// Retention-bounded time series. A fixed-slot ring written by UPSERT keeps the table size constant, so
// no pruning job exists: a DELETE by ts would scan the whole table, as the primary key leads with scope.
// Readers filter by ts, which also hides a slot left behind by hours that had no traffic.

import type { Db } from "../storage/types.ts";

export const HOUR_STEP_S = 3600;
/** Slots per step: 8 days of hours, for a week view that always has a full week. */
export const RETENTION_SLOTS: Readonly<Record<number, number>> = { [HOUR_STEP_S]: 8 * 24 };

const MAX_DATA_BYTES = 4096;

export type RollupData = Record<string, unknown>;

export interface RollupPoint {
  ts: number;
  data: RollupData;
}

function slotsFor(stepS: number): number {
  const slots = RETENTION_SLOTS[stepS];
  if (!slots) throw new Error("rollups: unsupported step");
  return slots;
}

const stepIndex = (ts: number, stepS: number) => Math.floor(ts / (stepS * 1000));

/** The ring slot of a unix ms time. */
export function slotOf(ts: number, stepS: number): number {
  return stepIndex(ts, stepS) % slotsFor(stepS);
}

/** Stores the point of the step holding `ts`, replacing it. An empty hour writes no row. */
export async function writeRollup(db: Db, scope: string, stepS: number, ts: number, data: RollupData): Promise<void> {
  const slot = Number.isSafeInteger(ts) && ts >= 0 ? slotOf(ts, stepS) : -1;
  if (slot < 0 || scope === "") throw new Error("rollups: invalid point");
  if (Object.keys(data).length === 0) return;
  const body = JSON.stringify(data);
  if (body.length > MAX_DATA_BYTES) throw new Error("rollups: data too large");
  await db.run(
    // The ts guard: a delayed write from the previous cycle must not replace a newer point.
    `INSERT INTO metric_rollups (scope, step_s, slot, ts, data) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (scope, step_s, slot) DO UPDATE SET ts = excluded.ts, data = excluded.data
     WHERE excluded.ts >= metric_rollups.ts`,
    [scope, stepS, slot, stepIndex(ts, stepS) * stepS * 1000, body],
  );
}

/** Points with from <= ts < to, oldest first, never older than the retention before `to`. */
export async function readRollups(db: Db, scope: string, stepS: number, from: number, to: number): Promise<RollupPoint[]> {
  const oldest = Math.max(from, to - slotsFor(stepS) * stepS * 1000);
  const rows = await db.all<{ ts: number; data: string }>(
    "SELECT ts, data FROM metric_rollups WHERE scope = ? AND step_s = ? AND ts >= ? AND ts < ? ORDER BY ts",
    [scope, stepS, oldest, to],
  );
  const out: RollupPoint[] = [];
  for (const r of rows) {
    try {
      out.push({ ts: Number(r.ts), data: JSON.parse(r.data) as RollupData });
    } catch {
      continue;
    }
  }
  return out;
}

export async function deleteRollups(db: Db, scope: string): Promise<void> {
  await db.run("DELETE FROM metric_rollups WHERE scope = ?", [scope]);
}
