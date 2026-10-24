import { describe, expect, it } from "vitest";
import { APPS, createApp, world } from "./helpers.ts";

// Deps.apps is the apps service (no fake): domain routes resolve real apps, and
// deleting an app removes its domains (rows and runtime host mappings).
describe("apps ↔ domains", () => {
  it("domain routes resolve apps through the apps service", async () => {
    const w = await world();
    await createApp(w.admin);
    const add = await w.admin.call("POST", `${APPS}/hello/domains`, { host: "www.example.com" });
    expect(add.status).toBe(201);
    const list = (await (await w.admin.call("GET", `${APPS}/hello/domains`)).json()) as { items: { host: string }[] };
    expect(list.items.map((d) => d.host)).toEqual(["www.example.com"]);
    expect((await w.admin.call("GET", `${APPS}/nope/domains`)).status).toBe(404);
  });

  it("app delete removes its domains and unmaps active hosts", async () => {
    const w = await world();
    await createApp(w.admin);
    await w.admin.call("POST", `${APPS}/hello/domains`, { host: "a.example.com" });
    await w.admin.call("POST", `${APPS}/hello/domains`, { host: "b.example.com" });
    const db = w.app.deps.storage.db;
    await db.run("UPDATE domains SET status = 'active' WHERE host = 'a.example.com'");
    const svc = (await db.first<{ service_id: string }>("SELECT service_id FROM domains WHERE host = 'a.example.com'"))?.service_id ?? "";
    w.fake.hosts.set("a.example.com", { host: "a.example.com", service: svc } as never);
    expect((await w.admin.call("DELETE", `${APPS}/hello`)).status).toBe(204);
    expect(await db.all("SELECT id FROM domains")).toEqual([]);
    expect(await db.all("SELECT id FROM pending_unmaps")).toEqual([]);
    expect(w.fake.hosts.has("a.example.com")).toBe(false);
    const audit = await db.all<{ action: string }>("SELECT action FROM audit WHERE action = 'domain.remove'");
    expect(audit).toHaveLength(2);
  });
});
