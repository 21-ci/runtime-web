import { describe, expect, it } from "vitest";
import { APPS, createApp, errOf, world } from "./helpers.ts";
import { RuntimeError } from "../../src/runtime/client.ts";
import { runtimeAppError } from "../../src/runtime/errors.ts";

const CONFIG = { topic: "changes", tables: [{ name: "orders", ops: ["insert"], payload: "keys" }], kv_prefixes: [] };

describe("data-change events", () => {
  it("enables with a short-lived key holding both scopes, then revokes it", async () => {
    const w = await world();
    const owner = await w.user("o@example.com", "owner");
    await createApp(owner);
    // An instance admin needs a role of their own here, as for the data browser.
    expect((await w.admin.call("PUT", `${APPS}/hello/data-events`, CONFIG)).status).toBe(403);
    const r = await owner.call("PUT", `${APPS}/hello/data-events`, CONFIG);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ state: "pending", topic: "changes" });
    const minted = w.fake.calls.find((c) => c.method === "POST" && /\/keys$/.test(c.path) && JSON.stringify(c.body).includes("rtweb-data-events"));
    expect(minted).toBeTruthy();
    expect(JSON.stringify(minted?.body)).toContain("data:read");
    expect(w.fake.calls.some((c) => c.method === "DELETE" && /\/v1\/tenants\/.+\/keys\//.test(c.path))).toBe(true);
    expect((await (await w.admin.call("GET", `${APPS}/hello/data-events`)).json()) as object).toMatchObject({ topic: "changes" });
    expect((await w.admin.call("DELETE", `${APPS}/hello/data-events`)).status).toBe(204);
    expect((await (await w.admin.call("GET", `${APPS}/hello/data-events`)).json()) as object).toMatchObject({ state: "disabled" });
  });

  it("rejects a bad body before minting anything", async () => {
    const w = await world();
    await createApp(w.admin);
    for (const bad of [{ tables: [] }, { ...CONFIG, tables: [{ name: "o", ops: ["drop"] }] }, { ...CONFIG, kv_prefixes: [{ prefix: 1 }] }, { ...CONFIG, max_backlog: 0 }]) {
      expect((await w.admin.call("PUT", `${APPS}/hello/data-events`, bad)).status).toBe(422);
    }
    expect(w.fake.calls.some((c) => JSON.stringify(c.body ?? "").includes("rtweb-data-events"))).toBe(false);
  });
});

describe("Vault secret refs", () => {
  it("links, lists the source, syncs and unlinks", async () => {
    const w = await world();
    await createApp(w.admin);
    const put = await w.admin.call("PUT", `${APPS}/hello/secrets/API_KEY/ref`, { path: "apps/hello", field: "key" });
    expect(put.status).toBe(200);
    const list = (await (await w.admin.call("GET", `${APPS}/hello/secrets`)).json()) as { items: { name: string; source: string }[] };
    expect(list.items).toContainEqual(expect.objectContaining({ name: "API_KEY", source: "vault" }));
    expect((await w.admin.call("POST", `${APPS}/hello/secrets/sync`)).status).toBe(202);
    expect((await w.admin.call("DELETE", `${APPS}/hello/secrets/API_KEY/ref`)).status).toBe(204);
  });

  it("needs path and field, and passes the runtime's refusal on", async () => {
    const w = await world();
    await createApp(w.admin);
    expect((await w.admin.call("PUT", `${APPS}/hello/secrets/A/ref`, { path: "x" })).status).toBe(422);
    const r = await w.admin.call("PUT", `${APPS}/hello/secrets/A/ref`, { path: "outside/x", field: "k" });
    expect(r.status).toBe(422);
    expect((await errOf(r)).code).toBe("ref_outside_prefix");
  });

  it("keeps the Vault source codes apart from a missing App and a down runtime", () => {
    const code = (status: number, c: string) => runtimeAppError(new RuntimeError(status, c, "x"));
    expect(code(404, "secret_source_not_found")).toMatchObject({ status: 404, code: "secret_source_not_found" });
    expect(code(503, "secret_source_unavailable")).toMatchObject({ status: 503, code: "secret_source_unavailable" });
    expect(code(409, "secret_is_ref")).toMatchObject({ status: 409, code: "secret_is_ref" });
  });
});

describe("plan usage", () => {
  it("is not found on a node without the route, and passes only the known shape", async () => {
    const w = await world();
    const url = APPS.replace(/\/apps$/, "/plan-usage");
    expect((await w.admin.call("GET", url)).status).toBe(404);
    w.fake.planUsage = {
      plan: "pro",
      day: "2026-11-05",
      resets_at: 1000,
      secret: "x",
      limits: { max_projects: 3 },
      quotas: {
        secrets: { limit: null, used: 1, remaining: null, period: "per_service" },
        invocations: { limit: 10, used: 5, remaining: 5, period: "day", extra: 1 },
        projects: { limit: 3, used: "5", remaining: 0, period: "total" },
        unknown_row: { limit: 1, used: 1, remaining: 0, period: "total" },
      },
    };
    expect(await (await w.admin.call("GET", url)).json()).toEqual({
      plan: "pro",
      resets_at: 1000,
      metrics: [
        { key: "invocations", used: 5, limit: 10, period: "day" },
        { key: "secrets", used: 1, limit: null, period: "per_service" },
      ],
    });
  });
});
