import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { testApp } from "../harness.ts";
import { fake, people, seedOrg } from "./helpers.ts";

async function setup() {
  const app = testApp();
  const org = await seedOrg(app);
  return { app, p: await people(app, org), f: fake(app) };
}
const ROUTES: [string, string][] = [
  ["GET", "/api/admin/backups"], ["GET", "/api/admin/backups/status"], ["POST", "/api/admin/backups"],
  ["GET", "/api/admin/node/series?range=1h"], ["GET", "/api/admin/node/stats"], ["GET", "/api/admin/node/events"],
];

describe("admin backups and monitoring", () => {
  it("is instance-admin only, for an org owner too", async () => {
    const { p } = await setup();
    for (const [m, path] of ROUTES) expect((await p.owner.call(m, path)).status, path).toBe(403);
  });

  it("lists, reports status and creates with an audit trail", async () => {
    const { app, p, f } = await setup();
    const made = await p.admin.call("POST", "/api/admin/backups");
    expect(made.status).toBe(202);
    const { id } = (await made.json()) as { id: string };
    const list = (await (await p.admin.call("GET", "/api/admin/backups")).json()) as { items: { id: string }[] };
    expect(list.items[0]?.id).toBe(id);
    expect(((await (await p.admin.call("GET", "/api/admin/backups/status")).json()) as { enabled: boolean }).enabled).toBe(true);
    const rows = await app.deps.storage.db.all<{ data: string }>("SELECT data FROM audit WHERE action = 'node.backup.create' ORDER BY rowid");
    expect(rows.map((r) => JSON.parse(r.data).status)).toEqual(["pending", "applied"]);
    void f;
  });

  it("maps the runtime's refusals", async () => {
    const { p, f } = await setup();
    f.failNext({ status: 503, code: "backup_disabled", match: (r) => r.method === "POST" && r.path === "/v1/node/backups" });
    const off = await p.admin.call("POST", "/api/admin/backups");
    expect(off.status).toBe(503);
    expect(((await off.json()) as { error: { code: string } }).error.code).toBe("backup_disabled");
    await p.admin.call("POST", "/api/admin/backups");
    expect((await p.admin.call("POST", "/api/admin/backups")).status).toBe(409);
  });

  it("offers no route to the archive or to delete", async () => {
    const { p } = await setup();
    expect((await p.admin.call("GET", "/api/admin/backups/bkp_1/archive")).status).toBe(404);
    expect((await p.admin.call("DELETE", "/api/admin/backups/bkp_1")).status).toBeGreaterThanOrEqual(404);
  });

  it("the node's series, stats and events pass through with checked parameters", async () => {
    const { p, f } = await setup();
    f.nodeSeries = [{ ts: 1, cpu_pct: 5, load1: 1, mem_committed: 1, disk_free: 1, rx: 1, tx: 1 }];
    const s = (await (await p.admin.call("GET", "/api/admin/node/series?range=6h")).json()) as { points: unknown[]; range: string };
    expect(s.range).toBe("6h");
    expect(s.points).toHaveLength(1);
    expect((await p.admin.call("GET", "/api/admin/node/series?range=2y")).status).toBe(422);
    expect((await p.admin.call("GET", "/api/admin/node/series?range=7d")).status).toBe(200);
    expect((await p.admin.call("GET", "/api/admin/node/events?kinds=a%0Ab")).status).toBe(422);
    expect((await p.admin.call("GET", "/api/admin/node/events?limit=5000")).status).toBe(422);
    expect((await p.admin.call("GET", "/api/admin/node/events?after=12&kinds=service.promoted")).status).toBe(200);
    await p.admin.call("GET", "/api/admin/node/stats");
    expect(f.nodeStatsQueries.at(-1)?.fields).toBe("counts");
  });
});

describe("binding paths", () => {
  const toml = readFileSync(new URL("../../../deploy/rt.rtweb.toml", import.meta.url), "utf8");
  const NODE = ["status", "config", "cache", "scheduler", "drain", "series", "stats", "events", "backups", "backups/status"];

  it("the node's rtctl-op binding holds no node glob and lists what the console calls", () => {
    expect(toml).not.toContain('"/v1/node/*"');
    for (const n of NODE) expect(toml, n).toContain(`"/v1/node/${n}"`);
  });

  it("the fake refuses a backup archive as the binding would", async () => {
    const { f } = await setup();
    const res = await f.op({ method: "GET", path: "/v1/node/backups/bkp_1/archive" });
    expect(res.status).toBe(403);
    expect(res.headers["x-rt-reason"]).toBe("binding_denied");
  });
});
