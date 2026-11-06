import { describe, expect, it } from "vitest";
import { renderTemplate } from "../../src/apps/templates.ts";
import { appIndexPut } from "../../src/apps/index-table.ts";
import { createApp, world } from "../apps/helpers.ts";
import { testApp } from "../harness.ts";
import { fake, people, seedOrg } from "./helpers.ts";

async function setup() {
  const app = testApp();
  const org = await seedOrg(app);
  return { app, org, p: await people(app, org), f: fake(app) };
}

const stat = (service: string, tenant: string, slug: string) => ({ service, tenant, slug, count: 1, errors: 0, p50: null, p95: null, p99: null, dlq: 0, depth: 0 });

describe("the node's pages name what they list", () => {
  it("marks a service of no org as the node's own", async () => {
    const { org, p, f } = await setup();
    f.nodeStats = [stat("svc_user", org.tenantId, "todo"), stat("svc_sys", "tnt_system", "rtweb")];
    const { items } = (await (await p.admin.call("GET", "/api/admin/node/stats")).json()) as { items: { slug: string; org: string | null; system: boolean }[] };
    expect(items.find((i) => i.slug === "todo")).toMatchObject({ org: org.slug, system: false });
    expect(items.find((i) => i.slug === "rtweb")).toMatchObject({ org: null, system: true });
  });

  it("adds the App's name to node events, from the index and then from traffic", async () => {
    const { app, org, p, f } = await setup();
    await appIndexPut(app.deps.storage.db, { orgId: org.orgId, slug: "todo", serviceId: "svc_user" });
    f.nodeStats = [stat("svc_sys", "tnt_system", "rtweb")];
    f.nodeEvents = [
      { id: 1, ts: 1, tenant: org.tenantId, service: "svc_user", kind: "service.created", data: {} },
      { id: 2, ts: 2, tenant: "tnt_system", service: "svc_sys", kind: "service.created", data: {} },
      { id: 3, ts: 3, tenant: null, service: null, kind: "node.started", data: {} },
    ];
    const { items } = (await (await p.admin.call("GET", "/api/admin/node/events")).json()) as { items: { app: string | null; org: string | null }[] };
    expect(items.map((i) => i.app)).toEqual(["todo", "rtweb", null]);
    expect(items[0]?.org).toBe(org.slug);
  });

  it("leaves the cache's digests out of owners when no indexed App has them", async () => {
    const { p } = await setup();
    const res = (await (await p.admin.call("GET", "/api/admin/node/cache")).json()) as { owners: Record<string, unknown> };
    expect(res.owners).toEqual({});
  });

  it("names the App and version behind a cached digest, and leaves a stranger unnamed", async () => {
    const w = await world();
    await createApp(w.admin);
    w.fake.nodeCacheBody = { top: { deno: ["sha256:1", "sha256:nobody"], wasm: [] } };
    const res = (await (await w.admin.call("GET", "/api/admin/node/cache")).json()) as { owners: Record<string, { app: string; version: number }> };
    expect(res.owners["sha256:1"]).toMatchObject({ app: "hello", version: 1 });
    expect(res.owners["sha256:nobody"]).toBeUndefined();
  });

  it("reports the branches and previews hidden in the App count", async () => {
    const w = await world();
    await createApp(w.admin);
    const quota = (used: number) => ({ used, limit: 10, remaining: 10, period: "total" });
    w.fake.planUsage = { plan: "free", quotas: { branches: quota(1), previews: quota(2) } };
    const body = (await (await w.admin.call("GET", "/api/orgs/acme/limits")).json()) as { hidden_services: number | null };
    expect(body.hidden_services).toBe(3);
  });
});

describe("templates", () => {
  it("gives sqlite-crud a working root, so a new App's preview is no 404", () => {
    const src = renderTemplate("sqlite-crud", "todo") ?? "";
    expect(src).toContain('path === ""');
    expect(src).toContain('"GET /items"');
    expect(src).not.toContain("{{SLUG}}");
  });
});
