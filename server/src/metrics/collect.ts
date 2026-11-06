// Feeds the metric_rollups ring from the node's hourly figures, for the 7-day charts the runtime cannot serve
// (its own series ends at 24 h and at a restart). The last finished hour is written again on each run: writes
// replace, so a run cut off by the budget just resumes at its cursor.
//
// /v1/node/stats spans all tenants, and the operator binding strips x-rt-tenant, so the runtime cannot narrow
// it. A row is written only when its service is an App of an org that owns that tenant.

import type { Deps } from "../app.ts";
import { appIndexTenants } from "../apps/index-table.ts";
import type { Job } from "../jobs/runner.ts";
import { rtOf } from "../keys/keys.ts";
import { isNotFound } from "../runtime/client.ts";
import type { NodeSeriesPoint } from "../runtime/types.ts";
import { HOUR_STEP_S, writeRollup } from "./rollups.ts";

export const NODE_SCOPE = "node";
const HOUR_MS = HOUR_STEP_S * 1000;
const PAGE = 200;
const PAGES_PER_RUN = 5;

const average = (points: NodeSeriesPoint[], key: keyof NodeSeriesPoint): number | null => {
  const vals = points.map((p) => p[key]).filter((v): v is number => typeof v === "number");
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
};

function nodePoint(points: NodeSeriesPoint[]): Record<string, unknown> {
  if (points.length === 0) return {};
  const lastDisk = points.map((p) => p.disk_free).filter((v) => typeof v === "number").at(-1) ?? null;
  return {
    cpu_pct: average(points, "cpu_pct"),
    load1: average(points, "load1"),
    mem_committed: average(points, "mem_committed"),
    disk_free: lastDisk,
    rx: average(points, "rx"),
    tx: average(points, "tx"),
  };
}

interface Progress {
  hour: number;
  cursor: string;
}

function parse(raw: string | null): Progress | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Progress;
    return Number.isSafeInteger(p.hour) && typeof p.cursor === "string" ? p : null;
  } catch {
    return null;
  }
}

export const METRICS_JOB: Job = {
  name: "metric_rollups",
  everyMs: 15 * 60_000,
  run: async ({ deps, cursor, checkpoint }) => {
    if (!deps.rtctl) return undefined;
    const db = deps.storage.db;
    const cli = rtOf(deps as Deps).op();
    const resumed = parse(cursor);
    const from = resumed?.hour ?? (Math.floor(deps.now() / HOUR_MS) - 1) * HOUR_MS;
    const to = from + HOUR_MS;
    if (!resumed) {
      let points: NodeSeriesPoint[];
      try {
        ({ points } = await cli.nodeSeries("1h"));
      } catch (e) {
        // A node older than these routes: nothing to collect, and not a failure of the job.
        if (isNotFound(e)) return undefined;
        throw e;
      }
      await writeRollup(db, NODE_SCOPE, HOUR_STEP_S, from, nodePoint(points.filter((p) => p.ts >= from && p.ts < to)));
    }
    let next: string | undefined = resumed?.cursor;
    let progress = cursor ?? "";
    for (let i = 0; i < PAGES_PER_RUN; i++) {
      const page = await cli.nodeStats({ from, to, fields: "counts", limit: PAGE, cursor: next });
      const owners = await appIndexTenants(db, page.items.map((s) => s.service));
      for (const s of page.items) {
        if (owners.get(s.service) !== s.tenant || (s.count === 0 && s.dlq === 0)) continue;
        await writeRollup(db, s.service, HOUR_STEP_S, from, { count: s.count, errors: s.errors, dlq: s.dlq, depth: s.depth });
      }
      if (!page.next_cursor) return undefined;
      next = page.next_cursor;
      progress = JSON.stringify({ hour: from, cursor: next } satisfies Progress);
      await checkpoint(progress);
    }
    return { cursor: progress };
  },
};
