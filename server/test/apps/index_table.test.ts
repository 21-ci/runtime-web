import { describe, expect, it } from "vitest";
import { appIndexDelete, appIndexDeleteOrg, appIndexGet, appIndexPut } from "../../src/apps/index-table.ts";
import { SLUG_RE } from "../../src/apps/slug.ts";
import { ensureMigrated } from "../../src/db/migrate.ts";
import { FakeRtCtl } from "../fakes/rtctl.ts";
import { testApp, testConfig } from "../harness.ts";

describe("SLUG_RE", () => {
  it.each([
    ["a", true], ["hello", true], ["a-b", true], ["a1-2b", true], ["x".repeat(63), true],
    ["", false], ["-a", false], ["a-", false], ["a--b", false], ["A", false], ["a_b", false], ["a.b", false],
    ["x".repeat(64), false], ["é", false],
  ])("%s -> %s", (slug, ok) => {
    expect(SLUG_RE.test(slug)).toBe(ok);
  });
});

async function setup(orgs: number) {
  const rtctl = new FakeRtCtl();
  const app = testApp({ rtctl, config: testConfig({ runtimePublicUrl: "https://apps.example.com" }) });
  const db = app.deps.storage.db;
  await ensureMigrated(db);
  for (let i = 0; i < orgs; i++) {
    await db.run("INSERT INTO orgs (id, slug, name, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)", [`org_${i}`, `o${i}`, `O${i}`, `t_${i}`, i]);
  }
  return { app, db, rtctl };
}

const ask = (app: Awaited<ReturnType<typeof setup>>["app"], d: string) =>
  app.call("GET", `/api/internal/tls-ask?domain=${d}`, { headers: { "x-rt-client-ip": "127.0.0.1" } });

describe("app index and tls-ask", () => {
  it("answers for 60 orgs with no runtime call", async () => {
    const { app, db, rtctl } = await setup(60);
    await appIndexPut(db, { orgId: "org_59", slug: "last", serviceId: "svc_last" });
    const before = rtctl.calls.length;
    expect((await ask(app, "last.apps.example.com")).status).toBe(200);
    expect((await ask(app, "nope.apps.example.com")).status).toBe(404);
    expect(rtctl.calls.length - before).toBeLessThanOrEqual(1);
  });

  it("puts, replaces and deletes entries; deleted orgs do not count", async () => {
    const { db } = await setup(2);
    await appIndexPut(db, { orgId: "org_0", slug: "shop", serviceId: "svc_1" });
    await appIndexPut(db, { orgId: "org_1", slug: "shop", serviceId: "svc_2" });
    expect(await appIndexGet(db, "shop")).toEqual({ orgId: "org_1", slug: "shop", serviceId: "svc_2" });
    expect(await appIndexGet(db, "Shop")).toBeNull();
    await db.run("UPDATE orgs SET deleted_at = 1 WHERE id = 'org_1'");
    expect(await appIndexGet(db, "shop")).toBeNull();
    await db.run("UPDATE orgs SET deleted_at = NULL WHERE id = 'org_1'");
    await appIndexDelete(db, "shop");
    expect(await appIndexGet(db, "shop")).toBeNull();
    await appIndexPut(db, { orgId: "org_0", slug: "a", serviceId: "s" });
    await appIndexDeleteOrg(db, "org_0");
    expect(await appIndexGet(db, "a")).toBeNull();
  });

  it("refuses non-slug labels and nested names", async () => {
    const { app, db } = await setup(1);
    await appIndexPut(db, { orgId: "org_0", slug: "shop", serviceId: "s" });
    expect((await ask(app, "a.shop.apps.example.com")).status).toBe(404);
    expect((await ask(app, "apps.example.com")).status).toBe(404);
    expect((await ask(app, "shop.example.com")).status).toBe(404);
  });
});
