// The data browser, bundles, async promote and rate rules: who may reach them and what crosses to the runtime.
import { describe, expect, it } from "vitest";
import { defaultKeyScopes } from "../../src/authz/policy.ts";
import { KEY_SCOPES } from "../../src/keys/keys.ts";
import { APPS, createApp, errOf, world } from "./helpers.ts";

const D = `${APPS}/hello/data`;
const setup = async () => {
  const w = await world();
  const owner = await w.user("o@example.com", "owner");
  await createApp(owner);
  return { w, owner };
};
const SECRET_SQL = "SELECT * FROM users WHERE email = 'alice@example.com'";

describe("data:read", () => {
  it("is in no default key and cannot be minted as a token", async () => {
    expect(KEY_SCOPES as readonly string[]).not.toContain("data:read");
    expect(defaultKeyScopes()).not.toContain("data:read");
    const { owner } = await setup();
    const res = await owner.call("POST", "/api/orgs/acme/tokens", { name: "t", scopes: ["data:read"], projects: [], environments: [], expires_at: null });
    expect(res.status).toBe(422);
  });

  it("reads with a separate key holding only data:read, minted once", async () => {
    const { w, owner } = await setup();
    await owner.call("GET", `${D}/tables`);
    await owner.call("GET", `${D}/tables`);
    const browse = w.fake.calls.filter((c) => c.path.endsWith("/data/tables"));
    expect(browse).toHaveLength(2);
    expect(browse[0]?.key).toBe(browse[1]?.key);
    const defaults = w.fake.calls.find((c) => c.path === "/v1/services" && c.scope === "tenant")?.key;
    expect(browse[0]?.key).not.toBe(defaults);
    const minted = w.fake.calls.filter((c) => c.method === "POST" && /\/keys$/.test(c.path) && (c.body as { scopes?: string[] }).scopes?.includes("data:read"));
    expect(minted).toHaveLength(1);
    expect((minted[0]?.body as { scopes: string[] }).scopes).toEqual(["data:read"]);
  });
});

describe("data browser", () => {
  it("answers all five routes for a project admin", async () => {
    const { owner } = await setup();
    expect((await owner.call("GET", `${D}/tables`)).status).toBe(200);
    expect((await owner.call("POST", `${D}/query`, { sql: "SELECT 1" })).status).toBe(200);
    expect((await owner.call("GET", `${D}/kv?prefix=a`)).status).toBe(200);
    expect((await owner.call("GET", `${D}/kv/aw`)).status).toBe(200);
    expect((await owner.call("GET", `${D}/blobs`)).status).toBe(200);
  });

  it("refuses viewers and developers, and an instance admin without a role of their own", async () => {
    const { w, owner } = await setup();
    void owner;
    const viewer = await w.user("v@example.com", "member", { default: "viewer" });
    const dev = await w.user("d@example.com", "member", { default: "developer" });
    for (const u of [viewer, dev]) {
      expect((await u.call("GET", `${D}/tables`)).status).toBe(403);
      expect((await u.call("POST", `${D}/query`, { sql: "SELECT 1" })).status).toBe(403);
      expect((await u.call("GET", `${D}/kv/aw`)).status).toBe(403);
    }
    expect((await w.admin.call("GET", `${D}/tables`)).status).toBe(403);
    expect(w.fake.dataReads).toEqual([]);
  });

  it("another org's app is 404 (IDOR)", async () => {
    const { w } = await setup();
    await w.addOrg("other");
    const base = "/api/orgs/other/apps/hello/data";
    for (const [m, p, b] of [["GET", `${base}/tables`], ["POST", `${base}/query`, { sql: "SELECT 1" }], ["GET", `${base}/kv`], ["GET", `${base}/kv/aw`], ["GET", `${base}/blobs`]] as const) {
      expect((await w.admin.call(m, p, b)).status, p).toBe(404);
    }
    expect(w.fake.dataReads).toEqual([]);
  });

  it("audits who and a hash, never the SQL text or values", async () => {
    const { w, owner } = await setup();
    await owner.call("POST", `${D}/query`, { sql: SECRET_SQL, args: ["alice"] });
    const rows = await w.app.deps.storage.db.all<{ action: string; data: string }>("SELECT action, data FROM audit WHERE action = 'app.data.query'");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toContain("sql_sha256");
    expect(rows[0]?.data).not.toContain("alice");
    expect(rows[0]?.data).not.toContain("SELECT");
  });

  it.each([[422, "sql_not_readonly"], [413, "result_too_large"], [422, "sql_error"], [503, "sql_busy"]])("passes on %i %s", async (status, code) => {
    const { w, owner } = await setup();
    w.fake.dataRefusal = { status, code, message: "driver text" };
    const res = await owner.call("POST", `${D}/query`, { sql: "DROP TABLE x" });
    expect((await errOf(res)).code).toBe(code);
    expect(await w.app.deps.storage.db.first("SELECT 1 AS x FROM audit WHERE action = 'app.data.query'")).toBeNull();
  });

  it("checks the shape of a query", async () => {
    const { owner } = await setup();
    for (const b of [{ sql: "" }, { sql: 1 }, { sql: "SELECT 1", limit: 501 }, { sql: "SELECT 1", args: "x" }, { sql: "SELECT 1", cell_max: 1 }]) {
      expect((await owner.call("POST", `${D}/query`, b)).status, JSON.stringify(b)).toBe(422);
    }
  });
});

describe("async promote", () => {
  const v1 = async (w: Awaited<ReturnType<typeof setup>>["w"], owner: Awaited<ReturnType<typeof setup>>["owner"]) => {
    const app = (await (await owner.call("GET", `${APPS}/hello`)).json()) as { etag: string };
    void w;
    return app.etag;
  };

  it("answers 202 preparing, polls to draining", async () => {
    const { w, owner } = await setup();
    const res = await owner.call("PUT", `${APPS}/hello/live?async=1`, { version: 1, close_sockets: true }, { "if-match": await v1(w, owner) });
    expect(res.status).toBe(202);
    const s = (await res.json()) as { id: string; kind: string; state: string; to_version: number };
    expect(s).toMatchObject({ kind: "promote", state: "preparing", to_version: 1 });
    const polled = (await (await owner.call("GET", `${APPS}/hello/switches/${s.id}`)).json()) as { state: string };
    expect(polled.state).toBe("draining");
    expect(w.fake.calls.find((c) => c.method === "PUT" && c.path.endsWith("/live"))?.query.async).toBe("1");
  });

  it("does not queue: a second start is 409 switch_in_progress", async () => {
    const { w, owner } = await setup();
    w.fake.asyncLiveState = "preparing";
    const etag = await v1(w, owner);
    expect((await owner.call("PUT", `${APPS}/hello/live?async=1`, { version: 1 }, { "if-match": etag })).status).toBe(202);
    const again = await owner.call("PUT", `${APPS}/hello/live?async=1`, { version: 1 }, { "if-match": await v1(w, owner) });
    expect(again.status).toBe(409);
    expect((await errOf(again)).code).toBe("switch_in_progress");
  });

  it("skipping migrations takes the export right", async () => {
    const { w, owner } = await setup();
    const dev = await w.user("d@example.com", "member", { default: "developer" });
    const res = await dev.call("PUT", `${APPS}/hello/live?async=1`, { version: 1, migrate: false }, { "if-match": await v1(w, owner) });
    expect(res.status).toBe(403);
  });

  it("needs If-Match and the deploy right", async () => {
    const { w, owner } = await setup();
    expect((await owner.call("PUT", `${APPS}/hello/live?async=1`, { version: 1 })).status).toBe(428);
    const viewer = await w.user("v@example.com", "member", { default: "viewer" });
    expect((await viewer.call("PUT", `${APPS}/hello/live?async=1`, { version: 1 }, { "if-match": "x" })).status).toBe(403);
  });
});

describe("bundles and import", () => {
  it("starts, reports ready with the size, downloads", async () => {
    const { w, owner } = await setup();
    const start = await owner.call("POST", `${APPS}/hello/bundle`);
    expect(start.status).toBe(202);
    const { id } = (await start.json()) as { id: string };
    const state = (await (await owner.call("GET", `${APPS}/hello/bundle/${id}`)).json()) as { state: string; bytes: number };
    expect(state.state).toBe("ready");
    const dl = await owner.call("GET", `${APPS}/hello/bundle/${id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("application/zstd");
    expect(await w.app.deps.storage.db.first("SELECT 1 AS x FROM audit WHERE action = 'app.bundle.download'")).toBeTruthy();
  });

  it("is project admin only, and another org's bundle id is 404", async () => {
    const { w, owner } = await setup();
    const dev = await w.user("d@example.com", "member", { default: "developer" });
    expect((await dev.call("POST", `${APPS}/hello/bundle`)).status).toBe(403);
    const { id } = (await (await owner.call("POST", `${APPS}/hello/bundle`)).json()) as { id: string };
    expect((await dev.call("GET", `${APPS}/hello/bundle/${id}`)).status).toBe(403);
    await w.addOrg("other");
    expect((await w.admin.call("GET", `/api/orgs/other/apps/hello/bundle/${id}`)).status).toBe(404);
    expect((await owner.call("GET", `${APPS}/hello/bundle/nosuch`)).status).toBe(404);
  });

  it("forks by slug, sending the service id and project from the query only", async () => {
    const { w, owner } = await setup();
    const res = await owner.call("POST", `${APPS}/import?slug=hello-two&project=default&environment=production&from=hello`);
    expect(res.status).toBe(202);
    expect((await res.json()) as object).toMatchObject({ slug: "hello-two", missing_secrets: ["API_KEY"] });
    const id = [...w.fake.services.values()].find((s) => s.view.slug === "hello")?.view.id;
    expect(w.fake.imports[0]?.query).toMatchObject({ slug: "hello-two", from: id });
    expect(w.fake.imports[0]?.idempotencyKey).not.toBe("");
  });

  it("refuses a developer, who cannot read the source's data, and an unknown source", async () => {
    const { w, owner } = await setup();
    const dev = await w.user("d@example.com", "member", { default: "developer" });
    expect((await dev.call("POST", `${APPS}/import?slug=hello-two&project=default&environment=production&from=hello`)).status).toBe(403);
    expect((await owner.call("POST", `${APPS}/import?slug=hello-two&project=default&environment=production&from=nosuch`)).status).toBe(404);
    expect((await owner.call("POST", `${APPS}/import?slug=hello-two&project=default&environment=production`)).status).toBe(422);
    expect(w.fake.imports.filter((i) => i.query.slug === "hello-two")).toHaveLength(0);
  });
});

describe("rate rules", () => {
  const patch = async (o: Awaited<ReturnType<typeof setup>>["owner"], rules: unknown) => {
    const { etag } = (await (await o.call("GET", `${APPS}/hello`)).json()) as { etag: string };
    return o.call("PATCH", `${APPS}/hello`, { ingress: { rate_rules: rules } }, { "if-match": etag });
  };

  it("passes valid rules on", async () => {
    const { w, owner } = await setup();
    const rule = { path: "/api/login", methods: ["POST"], rps: 5, burst: 10, by: "ip" };
    expect((await patch(owner, [rule])).status).toBe(200);
    const call = w.fake.calls.find((c) => c.method === "PATCH" && /\/v1\/services\//.test(c.path));
    expect((call?.body as { ingress: { rate_rules: unknown[] } }).ingress.rate_rules).toEqual([rule]);
  });

  it("names the field of each bad rule", async () => {
    const { owner } = await setup();
    const res = await patch(owner, [{ path: "x", rps: 0, by: "moon", extra: 1 }]);
    expect(res.status).toBe(422);
    const text = JSON.stringify(await res.json());
    for (const f of ["rate_rules[0].path", "rate_rules[0].rps", "rate_rules[0].by", "rate_rules[0].extra"]) expect(text).toContain(f);
    expect((await patch(owner, Array.from({ length: 33 }, () => ({ path: "/a", rps: 1 })))).status).toBe(422);
  });
});
