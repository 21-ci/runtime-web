import { beforeEach, describe, expect, it } from "vitest";
import { ensureMigrated } from "../../src/db/migrate.ts";
import {
  deleteRollups,
  HOUR_STEP_S,
  readRollups,
  RETENTION_SLOTS,
  slotOf,
  writeRollup,
} from "../../src/metrics/rollups.ts";
import type { Db } from "../../src/storage/types.ts";
import { memoryStorage } from "../harness.ts";
import { APPS, createApp, world } from "../apps/helpers.ts";

const HOUR = 3_600_000;
const SLOTS = 192; // 8 days of hours
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % HOUR);

let db: Db;
const count = async () => Number((await db.first<{ c: number }>("SELECT count(*) AS c FROM metric_rollups"))?.c);

beforeEach(async () => {
  db = memoryStorage().db;
  await ensureMigrated(db);
});

describe("ring slots", () => {
  it("keeps 1 h steps for 8 days", () => {
    expect(HOUR_STEP_S).toBe(3600);
    expect(RETENTION_SLOTS[HOUR_STEP_S]).toBe(SLOTS);
  });

  it("maps a whole step to one slot and wraps after the retention", () => {
    expect(slotOf(T0, HOUR_STEP_S)).toBe(slotOf(T0 + HOUR - 1, HOUR_STEP_S));
    expect(slotOf(T0 + HOUR, HOUR_STEP_S)).not.toBe(slotOf(T0, HOUR_STEP_S));
    expect(slotOf(T0 + SLOTS * HOUR, HOUR_STEP_S)).toBe(slotOf(T0, HOUR_STEP_S));
  });
});

describe("writeRollup", () => {
  it("stores the point at the start of its step", async () => {
    await writeRollup(db, "node", HOUR_STEP_S, T0 + 1234, { requests: 5 });
    expect(await readRollups(db, "node", HOUR_STEP_S, T0, T0 + HOUR)).toEqual([{ ts: T0, data: { requests: 5 } }]);
  });

  it("replaces the value within one step", async () => {
    await writeRollup(db, "node", HOUR_STEP_S, T0, { requests: 1 });
    await writeRollup(db, "node", HOUR_STEP_S, T0 + 60_000, { requests: 2 });
    expect(await count()).toBe(1);
    expect(await readRollups(db, "node", HOUR_STEP_S, T0, T0 + HOUR)).toEqual([{ ts: T0, data: { requests: 2 } }]);
  });

  it("overwrites the slot when the ring wraps: the old point is gone, the size is unchanged", async () => {
    await writeRollup(db, "node", HOUR_STEP_S, T0, { requests: 1 });
    const later = T0 + SLOTS * HOUR;
    await writeRollup(db, "node", HOUR_STEP_S, later, { requests: 2 });
    expect(await count()).toBe(1);
    expect(await readRollups(db, "node", HOUR_STEP_S, T0, T0 + HOUR)).toEqual([]);
    expect(await readRollups(db, "node", HOUR_STEP_S, later, later + HOUR)).toEqual([{ ts: later, data: { requests: 2 } }]);
  });

  it("never grows past the slot count", async () => {
    for (let i = 0; i < SLOTS + 20; i++) await writeRollup(db, "node", HOUR_STEP_S, T0 + i * HOUR, { requests: i });
    expect(await count()).toBe(SLOTS);
  });

  it("a late write for an older cycle does not clobber the newer point", async () => {
    const later = T0 + SLOTS * HOUR;
    await writeRollup(db, "node", HOUR_STEP_S, later, { requests: 2 });
    await writeRollup(db, "node", HOUR_STEP_S, T0, { requests: 1 });
    expect(await readRollups(db, "node", HOUR_STEP_S, later, later + HOUR)).toEqual([{ ts: later, data: { requests: 2 } }]);
  });

  it("writes no row for an empty hour", async () => {
    await writeRollup(db, "node", HOUR_STEP_S, T0, {});
    expect(await count()).toBe(0);
  });

  it("keeps scopes apart", async () => {
    await writeRollup(db, "node", HOUR_STEP_S, T0, { requests: 1 });
    await writeRollup(db, "svc_1", HOUR_STEP_S, T0, { requests: 2 });
    expect(await readRollups(db, "svc_1", HOUR_STEP_S, T0, T0 + HOUR)).toEqual([{ ts: T0, data: { requests: 2 } }]);
  });

  it("refuses bad input and writes nothing", async () => {
    await expect(writeRollup(db, "", HOUR_STEP_S, T0, { a: 1 })).rejects.toThrow();
    await expect(writeRollup(db, "node", 60, T0, { a: 1 })).rejects.toThrow();
    await expect(writeRollup(db, "node", HOUR_STEP_S, Number.NaN, { a: 1 })).rejects.toThrow();
    await expect(writeRollup(db, "node", HOUR_STEP_S, -1, { a: 1 })).rejects.toThrow();
    await expect(writeRollup(db, "node", HOUR_STEP_S, T0, { a: "x".repeat(5000) })).rejects.toThrow();
    expect(await count()).toBe(0);
  });
});

describe("readRollups", () => {
  it("returns points oldest first, from inclusive and to exclusive", async () => {
    // Slot order differs from time order once the ring has wrapped.
    for (let i = 0; i < SLOTS; i++) await writeRollup(db, "node", HOUR_STEP_S, T0 + i * HOUR, { i });
    const pts = await readRollups(db, "node", HOUR_STEP_S, T0 + HOUR, T0 + 4 * HOUR);
    expect(pts.map((p) => p.data.i)).toEqual([1, 2, 3]);
  });

  it("hides a stale slot older than the retention, as no job prunes it", async () => {
    await writeRollup(db, "node", HOUR_STEP_S, T0, { a: 1 });
    expect(await readRollups(db, "node", HOUR_STEP_S, 0, T0 + (SLOTS + 1) * HOUR)).toEqual([]);
  });

  it("skips a row whose data is not valid JSON instead of failing the read", async () => {
    await db.run("INSERT INTO metric_rollups (scope, step_s, slot, ts, data) VALUES ('node', 3600, 1, ?, 'not json')", [T0]);
    expect(await readRollups(db, "node", HOUR_STEP_S, T0, T0 + HOUR)).toEqual([]);
  });
});

describe("deleteRollups", () => {
  it("removes one scope's rows only", async () => {
    await writeRollup(db, "svc_1", HOUR_STEP_S, T0, { a: 1 });
    await writeRollup(db, "svc_2", HOUR_STEP_S, T0, { a: 1 });
    await deleteRollups(db, "svc_1");
    expect(await readRollups(db, "svc_1", HOUR_STEP_S, T0, T0 + HOUR)).toEqual([]);
    expect(await count()).toBe(1);
  });

  it("deleting an App deletes its rows", async () => {
    const w = await world();
    await createApp(w.admin);
    const appDb = w.app.deps.storage.db;
    const row = await appDb.first<{ service_id: string }>("SELECT service_id FROM app_index WHERE slug = 'hello'");
    const id = row?.service_id ?? "";
    expect(id).not.toBe("");
    await writeRollup(appDb, id, HOUR_STEP_S, T0, { a: 1 });
    expect((await w.admin.call("DELETE", `${APPS}/hello`)).status).toBe(204);
    expect(await appDb.all("SELECT scope FROM metric_rollups")).toEqual([]);
  });
});
