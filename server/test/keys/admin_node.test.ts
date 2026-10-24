import { describe, expect, it } from "vitest";
import { testApp } from "../harness.ts";
import { count, fake, people, seedOrg } from "./helpers.ts";

const errCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe("admin node", () => {
  it("is instance-admin only", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    for (const path of ["/api/admin/node/status", "/api/admin/node/config", "/api/admin/node/version", "/api/admin/node/cache"]) {
      expect((await p.owner.call("GET", path)).status, path).toBe(403);
      expect((await p.admin.call("GET", path)).status, path).toBe(200);
    }
  });

  it("returns runtime passthroughs and the web version", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    const status = (await (await p.admin.call("GET", "/api/admin/node/status")).json()) as { version: string };
    expect(status.version).toBe("rtctl-fake");
    const version = await (await p.admin.call("GET", "/api/admin/node/version")).json();
    expect(version).toEqual({ version: "rtctl-fake", web_version: "test" });
  });

  it("PUT config accepts only degradation_mode, default_profile and rate_limit", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    const bad = await p.admin.call("PUT", "/api/admin/node/config", { degradation_mode: "normal", pool_size: 3 });
    expect(bad.status).toBe(422);
    expect(await errCode(bad)).toBe("invalid");
    expect((await p.admin.call("PUT", "/api/admin/node/config", {})).status).toBe(422);
  });

  it("PUT config applies the patch and audits pending then applied", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    const res = await p.admin.call("PUT", "/api/admin/node/config", { default_profile: "large" });
    expect(res.status).toBe(200);
    expect(fake(app).nodeConfig.default_profile).toBe("large");
    const rows = await app.deps.storage.db.all<{ data: string }>("SELECT data FROM audit WHERE action = 'node.config.update' ORDER BY rowid");
    expect(rows.map((r) => JSON.parse(r.data).status)).toEqual(["pending", "applied"]);
    expect(await count(app, "SELECT COUNT(*) AS n FROM audit WHERE org_id IS NULL AND target = 'node'")).toBe(2);
  });

  it("a failed runtime change is audited as failed with its error code", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    fake(app).failNext({ status: 503, code: "control_disabled", match: (r) => r.method === "PUT" && r.path === "/v1/node/config" });
    const res = await p.admin.call("PUT", "/api/admin/node/config", { default_profile: "large" });
    expect(res.status).toBe(503);
    const rows = await app.deps.storage.db.all<{ data: string }>("SELECT data FROM audit WHERE action = 'node.config.update' ORDER BY rowid");
    expect(JSON.parse(rows[1]?.data ?? "{}")).toMatchObject({ status: "failed", error_code: "control_disabled" });
  });

  it("drain needs body {confirm: \"drain\"}", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    for (const body of [{}, { confirm: "yes" }, { confirm: "Drain" }]) {
      const res = await p.admin.call("POST", "/api/admin/node/drain", body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect(fake(app).drained).toBe(false);

    const ok = await p.admin.call("POST", "/api/admin/node/drain", { confirm: "drain" });
    expect(ok.status).toBe(202);
    expect(fake(app).drained).toBe(true);
    const rows = await app.deps.storage.db.all<{ data: string }>("SELECT data FROM audit WHERE action = 'node.drain' ORDER BY rowid");
    expect(rows.map((r) => JSON.parse(r.data).status)).toEqual(["pending", "applied"]);
  });
});
