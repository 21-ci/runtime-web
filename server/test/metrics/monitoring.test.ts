import { describe, expect, it } from "vitest";
import { METRICS_JOB } from "../../src/metrics/collect.ts";
import { HOUR_STEP_S, readRollups, writeRollup } from "../../src/metrics/rollups.ts";
import { runJobs } from "../../src/jobs/runner.ts";
import { APPS, createApp, world } from "../apps/helpers.ts";

const H = HOUR_STEP_S * 1000;

async function setup() {
  const w = await world();
  const owner = await w.user("owner@example.com", "owner");
  await createApp(owner);
  const svc = [...w.fake.services.values()].find((s) => s.view.slug === "hello");
  const id = svc?.view.id ?? "";
  const hour = Math.floor(w.app.deps.now() / H) - 1;
  const from = hour * H;
  const db = w.app.deps.storage.db;
  const row = await db.first<{ tenant_id: string }>("SELECT tenant_id FROM orgs WHERE slug = 'acme'");
  return { w, owner, id, from, db, tenant: row?.tenant_id ?? "", until: from + 2 * H };
}
const stat = (service: string, tenant: string, count = 5) => ({ service, tenant, slug: "x", count, errors: 1, p50: null, p95: null, p99: null, dlq: 0, depth: 0 });

describe("metrics job", () => {
  it("asks for counts only and writes the finished hour of known Apps", async () => {
    const { w, id, from, db, tenant, until } = await setup();
    w.fake.nodeStats = [stat(id, tenant)];
    await runJobs(w.app.deps, [METRICS_JOB]);
    expect(w.fake.nodeStatsQueries[0]?.fields).toBe("counts");
    expect(w.fake.nodeStatsQueries[0]?.from).toBe(String(from));
    expect((await readRollups(db, id, HOUR_STEP_S, from, until))[0]?.data).toMatchObject({ count: 5, errors: 1 });
  });

  it("drops a row for a service of another tenant, an unknown service and an idle one", async () => {
    const { w, id, db, tenant, from, until } = await setup();
    w.fake.nodeStats = [stat(id, "ten_other"), stat("svc_unknown", tenant), stat(id, tenant, 0)];
    await runJobs(w.app.deps, [METRICS_JOB]);
    expect(await readRollups(db, id, HOUR_STEP_S, from, until)).toEqual([]);
    expect(await readRollups(db, "svc_unknown", HOUR_STEP_S, from, until)).toEqual([]);
  });

  it("writes the node point from the series", async () => {
    const { w, from, db, until } = await setup();
    w.fake.nodeSeries = [
      { ts: from + 60_000, cpu_pct: 10, load1: 1, mem_committed: 100, disk_free: 900, rx: 1, tx: 2 },
      { ts: from + 120_000, cpu_pct: 30, load1: null, mem_committed: 300, disk_free: 800, rx: 3, tx: 4 },
    ];
    await runJobs(w.app.deps, [METRICS_JOB]);
    expect((await readRollups(db, "node", HOUR_STEP_S, from, until))[0]?.data).toMatchObject({ cpu_pct: 20, mem_committed: 200, disk_free: 800 });
  });

  it("resumes by cursor at 1,000 Apps under the fetch budget", async () => {
    const { w, id, tenant } = await setup();
    w.fake.nodeStats = Array.from({ length: 1000 }, (_, i) => stat(i === 999 ? id : `svc_${i}`, tenant));
    const limits = { wallMs: 20_000, fetches: 3 };
    await runJobs(w.app.deps, [METRICS_JOB], limits);
    const seen = w.fake.nodeStatsQueries.length;
    expect(seen).toBeLessThanOrEqual(3);
    const state = await w.app.deps.storage.db.first<{ cursor: string | null }>("SELECT cursor FROM job_state WHERE name = 'metric_rollups'");
    expect(state?.cursor).toBeTruthy();
    for (let i = 0; i < 6; i++) {
      w.app.tick(1);
      await runJobs(w.app.deps, [METRICS_JOB], limits);
    }
    const cursors = w.fake.nodeStatsQueries.map((q) => q.cursor ?? "");
    expect(cursors.filter((c) => c === "").length).toBe(1);
    expect(w.fake.nodeStatsQueries.length).toBe(5);
  });
});

describe("org deletion", () => {
  it("removes the rollups and index rows of its Apps, even when the tenant is already gone", async () => {
    const { w, owner, id, from, db, until } = await setup();
    await writeRollup(db, id, HOUR_STEP_S, from, { count: 1 });
    await writeRollup(db, "node", HOUR_STEP_S, from, { cpu_pct: 1 });
    void owner;
    w.fake.services.delete(id);
    expect((await w.admin.call("DELETE", "/api/admin/orgs/acme")).status).toBe(204);
    expect(await readRollups(db, id, HOUR_STEP_S, from, until)).toEqual([]);
    expect(await readRollups(db, "node", HOUR_STEP_S, from, until)).toHaveLength(1);
    expect(await db.all("SELECT 1 FROM app_index WHERE service_id = ?", [id])).toEqual([]);
  });
});

describe("app charts and migrations: authorization", () => {
  it("serves the week from the ring to a member, and nothing across orgs", async () => {
    const { w, owner, id, from, db } = await setup();
    await writeRollup(db, id, HOUR_STEP_S, from, { count: 7, errors: 2 });
    const res = await owner.call("GET", `${APPS}/hello/stats?window=7d`);
    expect(res.status).toBe(200);
    const b = (await res.json()) as { series: { ts: number; count: number }[]; data_from: number };
    expect(b.series[0]).toMatchObject({ ts: from, count: 7, errors: 2 });
    expect(b.data_from).toBe(from);

    await w.addOrg("other");
    const other = await w.user("out@example.com", null);
    for (const path of [`${APPS}/hello/stats?window=7d`, `${APPS}/hello/stats?window=1h&step=1m`, `${APPS}/hello/migrations`]) {
      expect((await other.call("GET", path)).status, path).toBe(404);
    }
    expect((await other.call("POST", `${APPS}/hello/live/dry-run`, { version: 1 })).status).toBe(404);
    // Same slug through the outsider's own org finds nothing of acme's.
    expect((await other.call("GET", "/api/orgs/other/apps/hello/stats?window=7d")).status).toBe(404);
  });

  it("validates window and step", async () => {
    const { owner } = await setup();
    expect((await owner.call("GET", `${APPS}/hello/stats?window=9d`)).status).toBe(422);
    expect((await owner.call("GET", `${APPS}/hello/stats?window=1h&step=2m`)).status).toBe(422);
    expect((await owner.call("GET", `${APPS}/hello/stats?window=1h&step=5m`)).status).toBe(200);
  });

  it("a viewer reads migrations but cannot dry-run; the result names pending_migrations", async () => {
    const { w, owner, id } = await setup();
    const svc = w.fake.services.get(id);
    w.fake.migrations.set(id, { applied: [{ name: "0001_a.sql", sha256: "aa", applied_at: 1, version: 1 }], pending_for_latest: [{ name: "0002_b.sql", sha256: "bb" }] });
    const viewer = await w.user("v@example.com", "member", { default: "viewer" });
    const read = (await (await viewer.call("GET", `${APPS}/hello/migrations`)).json()) as { pending_for_latest: { name: string }[] };
    expect(read.pending_for_latest[0]?.name).toBe("0002_b.sql");
    expect((await viewer.call("POST", `${APPS}/hello/live/dry-run`, { version: svc?.versions.length ?? 1 })).status).toBe(403);
    const dry = await owner.call("POST", `${APPS}/hello/live/dry-run`, { version: svc?.versions.length ?? 1 });
    expect(dry.status).toBe(200);
    expect(await dry.json()).toEqual({ pending_migrations: ["0002_b.sql"] });
  });

  it("promote passes migrations_applied, and migration_failed keeps its details", async () => {
    const { w, owner, id } = await setup();
    const app = (await (await owner.call("GET", `${APPS}/hello`)).json()) as { etag: string };
    const n = w.fake.services.get(id)?.versions.length ?? 1;
    w.fake.liveError = { status: 409, code: "migration_failed", message: "bad", details: { file: "0002_b.sql", statement_index: 1, line: 3, sqlite_code: 1, message: "no such table" } };
    const failed = await owner.call("PUT", `${APPS}/hello/live`, { version: n }, { "if-match": app.etag });
    expect(failed.status).toBe(409);
    const e = (await failed.json()) as { error: { code: string; details: { file: string } } };
    expect(e.error.code).toBe("migration_failed");
    expect(e.error.details.file).toBe("0002_b.sql");
    w.fake.liveError = null;
    w.fake.liveApplied = ["0002_b.sql"];
    const done = await owner.call("PUT", `${APPS}/hello/live`, { version: n }, { "if-match": app.etag });
    expect(((await done.json()) as { migrations_applied: string[] }).migrations_applied).toEqual(["0002_b.sql"]);
  });
});
