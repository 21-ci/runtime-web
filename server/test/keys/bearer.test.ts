// Bearer tokens on the console API (review item 8).
import { describe, expect, it } from "vitest";
import { TOKEN_REQUESTS_PER_MINUTE } from "../../src/keys/bearer.ts";
import { can } from "../../src/authz/policy.ts";
import { APPS, createApp, errOf, world, type World } from "../apps/helpers.ts";
import { TEST_ORIGIN } from "../harness.ts";

interface Minted {
  id: string;
  secret: string;
}

async function mint(w: World, body: Record<string, unknown>): Promise<Minted> {
  const res = await w.admin.call("POST", "/api/orgs/acme/tokens", { name: "ci", ...body });
  expect(res.status, await res.clone().text()).toBe(201);
  const b = (await res.json()) as { token: { id: string }; secret: string };
  return { id: b.token.id, secret: b.secret };
}

/** A token-only call: no cookie, no Origin, no CSRF. */
const call = (w: World, t: Minted | string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  w.app.call(method, path, {
    ...(body !== undefined ? { body } : {}),
    headers: { authorization: `Bearer ${typeof t === "string" ? t : t.secret}`, ...headers },
  });

async function otherProject(w: World): Promise<void> {
  const r = await w.admin.call("POST", "/api/orgs/acme/projects", { slug: "other", environments: ["production", "staging"] });
  expect(r.status, await r.clone().text()).toBe(201);
  const a = await w.admin.call("POST", APPS, { project: "other", environment: "production", slug: "elsewhere", template: "http" });
  expect(a.status, await a.clone().text()).toBe(201);
}

const DEPLOYER = ["services:read", "services:write", "deploy", "logs:read"];

describe("bearer tokens on the app routes", () => {
  it("a project-scoped token deploys and reads logs in its project without Origin or CSRF", async () => {
    const w = await world();
    await createApp(w.admin);
    const t = await mint(w, { scopes: DEPLOYER, projects: ["default"] });

    const got = await call(w, t, "GET", `${APPS}/hello`);
    expect(got.status).toBe(200);
    const put = await call(w, t, "PUT", `${APPS}/hello/files`, { entry: "main.ts", files: { "main.ts": "export default { fetch: () => new Response('v2') };" } }, { "if-match": got.headers.get("etag") ?? "" });
    expect(put.status, await put.clone().text()).toBe(200);
    expect((await call(w, t, "GET", `${APPS}/hello/logs`)).status).toBe(200);
    const list = (await (await call(w, t, "GET", APPS)).json()) as { items: { slug: string }[] };
    expect(list.items.map((i) => i.slug)).toEqual(["hello"]);

    const created = await call(w, t, "POST", APPS, { project: "default", environment: "production", slug: "made-by-ci", template: "http" });
    expect(created.status, await created.clone().text()).toBe(201);
    const rows = await w.app.deps.storage.db.all<{ actor_id: string; action: string }>("SELECT actor_id, action FROM audit WHERE action = 'app.create' AND target = 'made-by-ci'");
    expect(rows).toEqual([{ actor_id: t.id, action: "app.create" }]);
    const feed = (await (await w.admin.call("GET", "/api/orgs/acme/audit?action=app.create")).json()) as { items: { actor: { user_id: string; name: string } }[] };
    expect(feed.items.find((i) => i.actor.user_id === t.id)?.actor.name).toBe("ci");
  });

  it("gets 403 outside its projects and for actions its scopes do not cover", async () => {
    const w = await world();
    await createApp(w.admin);
    await otherProject(w);
    const t = await mint(w, { scopes: DEPLOYER, projects: ["default"] });
    expect((await call(w, t, "GET", `${APPS}/elsewhere`)).status).toBe(403);
    expect((await call(w, t, "GET", `${APPS}/elsewhere/logs`)).status).toBe(403);
    expect((await call(w, t, "POST", APPS, { project: "other", environment: "production", slug: "nope", template: "http" })).status).toBe(403);
    const list = (await (await call(w, t, "GET", APPS)).json()) as { items: { slug: string }[] };
    expect(list.items.map((i) => i.slug)).toEqual(["hello"]);
    expect((await call(w, t, "PUT", `${APPS}/hello/secrets/API_KEY`, { value: "x" })).status).toBe(403);
    expect((await call(w, t, "PUT", `${APPS}/hello/env`, { env: { A: "1" } })).status).toBe(403);
    expect((await call(w, t, "GET", `${APPS}/hello/export`)).status).toBe(403);
    expect((await call(w, t, "POST", `${APPS}/hello/domains`, { host: "ci.example.org" })).status).toBe(403);

    const reader = await mint(w, { scopes: ["services:read"] });
    expect((await call(w, reader, "GET", `${APPS}/elsewhere`)).status).toBe(200);
    expect((await call(w, reader, "GET", `${APPS}/hello/logs`)).status).toBe(403);
    expect((await call(w, reader, "DELETE", `${APPS}/hello`)).status).toBe(403);
  });

  it("an environment-restricted token stays in its environments", async () => {
    const w = await world();
    await createApp(w.admin);
    await otherProject(w);
    const t = await mint(w, { scopes: DEPLOYER, environments: ["staging"] });
    expect((await call(w, t, "GET", `${APPS}/hello`)).status).toBe(403);
    expect((await call(w, t, "GET", APPS)).status).toBe(403);
    expect((await call(w, t, "GET", `${APPS}?environment=staging`)).status).toBe(200);
    expect((await call(w, t, "POST", APPS, { project: "other", environment: "production", slug: "p1", template: "http" })).status).toBe(403);
    expect((await call(w, t, "POST", APPS, { project: "other", environment: "staging", slug: "s1", template: "http" })).status).toBe(201);
    expect((await call(w, t, "GET", `${APPS}/s1`)).status).toBe(200);
  });

  it("is refused on auth, users, tokens, admin and settings routes", async () => {
    const w = await world();
    const t = await mint(w, { scopes: DEPLOYER });
    for (const [method, path, body] of [
      ["POST", "/api/orgs/acme/tokens", { name: "x", scopes: ["deploy"] }],
      ["GET", "/api/orgs/acme/tokens", undefined],
      ["GET", "/api/me", undefined],
      ["POST", "/api/auth/logout", undefined],
      ["GET", "/api/orgs", undefined],
      ["GET", "/api/orgs/acme/members", undefined],
      ["GET", "/api/admin/users", undefined],
      ["GET", "/api/admin/settings", undefined],
      ["PUT", "/api/admin/branding", { name: "x" }],
      ["GET", "/api/admin/domains", undefined],
    ] as const) {
      const r = await call(w, t, method, path, body, { origin: TEST_ORIGIN });
      expect(r.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
      expect(r.status, `${method} ${path}`).toBeLessThan(500);
      if (r.status === 403) expect((await errOf(r)).code, `${method} ${path}`).toMatch(/bearer_not_allowed|origin_invalid/);
      else expect([404, 405], `${method} ${path}`).toContain(r.status);
    }
    const mintAttempt = await call(w, t, "POST", "/api/orgs/acme/tokens", { name: "x", scopes: ["deploy"] }, { origin: TEST_ORIGIN });
    expect(mintAttempt.status).toBe(403);
    expect((await errOf(mintAttempt)).code).toBe("bearer_not_allowed");
    const admin = await call(w, t, "GET", "/api/admin/users");
    expect(admin.status).toBe(403);
    expect((await errOf(admin)).code).toBe("bearer_not_allowed");
    expect(await w.app.deps.storage.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM tokens")).toEqual({ n: 1 });
  });

  it("is refused alongside a session cookie, and unsafe requests then need Origin again", async () => {
    const w = await world();
    await createApp(w.admin);
    const t = await mint(w, { scopes: DEPLOYER });
    const r = await w.admin.call("GET", `${APPS}/hello`, undefined, { authorization: `Bearer ${t.secret}` });
    expect(r.status).toBe(400);
    expect((await errOf(r)).code).toBe("ambiguous_credentials");
    const d = await w.app.call("DELETE", `${APPS}/hello`, { headers: { authorization: `Bearer ${t.secret}`, cookie: w.admin.cookie } });
    expect(d.status).toBe(403);
    expect((await errOf(d)).code).toBe("origin_invalid");
  });

  it("unknown, empty, revoked and expired tokens are 401", async () => {
    const w = await world();
    await createApp(w.admin);
    expect((await call(w, "rtk_nope", "GET", `${APPS}/hello`)).status).toBe(401);
    expect((await call(w, "", "GET", `${APPS}/hello`)).status).toBe(401);
    expect((await call(w, "rtk_nope", "DELETE", `${APPS}/hello`)).status).toBe(401);

    const t = await mint(w, { scopes: DEPLOYER, expires_at: w.app.deps.now() + 60_000 });
    expect((await call(w, t, "GET", `${APPS}/hello`)).status).toBe(200);
    await w.app.tick(60_000);
    expect((await call(w, t, "GET", `${APPS}/hello`)).status).toBe(401);

    const r = await mint(w, { scopes: DEPLOYER });
    expect((await w.admin.call("DELETE", `/api/orgs/acme/tokens/${r.id}`)).status).toBe(204);
    expect((await call(w, r, "GET", `${APPS}/hello`)).status).toBe(401);
  });

  it("a token minted before secret hashes existed cannot call the API", async () => {
    const w = await world();
    const t = await mint(w, { scopes: DEPLOYER });
    await w.app.deps.storage.db.run("UPDATE tokens SET secret_hash = NULL");
    expect((await call(w, t, "GET", APPS)).status).toBe(401);
  });

  it("is limited per token and per minute", async () => {
    const w = await world();
    const t = await mint(w, { scopes: DEPLOYER });
    const other = await mint(w, { scopes: DEPLOYER });
    const minute = Math.floor(w.app.deps.now() / 60_000);
    await w.app.deps.storage.kv.incr(`rl:tok:${t.id}:${minute}`, TOKEN_REQUESTS_PER_MINUTE);
    const r = await call(w, t, "GET", APPS);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await call(w, other, "GET", APPS)).status).toBe(200);
  });

  it("acts only in its own org", async () => {
    const w = await world();
    await w.addOrg("beta");
    const t = await mint(w, { scopes: DEPLOYER });
    expect((await call(w, t, "GET", "/api/orgs/beta/apps")).status).toBe(404);
  });
});

describe("token policy", () => {
  it("maps scopes and projects onto actions, never org roles", () => {
    const token = { scopes: ["deploy", "services:read"], projects: ["p"] };
    const s = { userId: "tok_1", orgRole: "owner", instanceAdmin: true, token };
    expect(can(s, "app.deploy", "p")).toBe(true);
    expect(can(s, "app.read", "p")).toBe(true);
    expect(can(s, "app.read", "q")).toBe(false);
    expect(can(s, "app.read", "")).toBe(false);
    expect(can(s, "app.env.write", "p")).toBe(false);
    for (const a of ["org.read", "tokens.manage", "members.manage", "domains.manage", "instance.admin", "nope"]) expect(can(s, a, "p")).toBe(false);
    expect(can({ userId: "tok_2", token: { scopes: ["services:read"], projects: [] } }, "app.read", "")).toBe(true);
  });
});
