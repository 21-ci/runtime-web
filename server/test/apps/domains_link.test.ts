import { describe, expect, it } from "vitest";
import { scheduled } from "../../src/jobs.ts";
import { serviceDeleteBackoff } from "../../src/apps/service.ts";
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

  it("a failed unmap during app delete stays queued and the scheduled job converges", async () => {
    const w = await world();
    await createApp(w.admin);
    await w.admin.call("POST", `${APPS}/hello/domains`, { host: "a.example.com" });
    const db = w.app.deps.storage.db;
    await db.run("UPDATE domains SET status = 'active' WHERE host = 'a.example.com'");
    const svc = (await db.first<{ service_id: string }>("SELECT service_id FROM domains"))?.service_id ?? "";
    w.fake.hosts.set("a.example.com", { host: "a.example.com", service: svc } as never);
    w.fake.failNext({ status: 503, match: (r) => r.method === "DELETE" && r.path.includes("/hosts/") });
    expect((await w.admin.call("DELETE", `${APPS}/hello`)).status).toBe(204);
    expect(await db.all("SELECT id FROM domains")).toEqual([]);
    expect(await db.all("SELECT host FROM pending_unmaps")).toEqual([{ host: "a.example.com" }]);
    await scheduled(w.app.deps);
    expect(await db.all("SELECT host FROM pending_unmaps")).toEqual([]);
    expect(w.fake.hosts.has("a.example.com")).toBe(false);
  });

  it("a failed cleanup after a failed create is queued and retried by the scheduled job", async () => {
    const w = await world();
    w.fake.failNext({ status: 503, match: (r) => r.method === "POST" && r.path.endsWith("/versions") });
    w.fake.failNext({ status: 503, match: (r) => r.method === "DELETE" && r.path.startsWith("/v1/services/") });
    const r = await w.admin.call("POST", APPS, { project: "default", environment: "production", slug: "orphan", template: "http" });
    expect(r.status).toBeGreaterThanOrEqual(500);
    const db = w.app.deps.storage.db;
    const q = () => db.all<{ service_id: string; attempts: number }>("SELECT service_id, attempts FROM pending_service_deletes");
    expect(await q()).toHaveLength(1);
    // Due now, but the runtime is still failing: the row backs off.
    w.fake.failNext({ status: 503, match: (r) => r.method === "DELETE" && r.path.startsWith("/v1/services/") });
    await scheduled(w.app.deps);
    expect((await q())[0]?.attempts).toBe(1);
    await scheduled(w.app.deps); // not due yet
    expect((await q())[0]?.attempts).toBe(1);
    w.app.tick(serviceDeleteBackoff(1));
    await scheduled(w.app.deps);
    expect(await q()).toEqual([]);
    const again = await w.admin.call("POST", APPS, { project: "default", environment: "production", slug: "orphan", template: "http" });
    expect(again.status).toBe(201);
  });
});
