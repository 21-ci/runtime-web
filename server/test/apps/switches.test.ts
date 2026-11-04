import { describe, expect, it } from "vitest";
import { APPS, createApp, errOf, world, type World } from "./helpers.ts";

const svc = (w: World, slug: string) => {
  const s = [...w.fake.services.values()].find((x) => x.view.slug === slug);
  if (!s) throw new Error(`no service ${slug}`);
  return s;
};

async function withBranch(w: World) {
  const { etag } = await createApp(w.admin);
  const parent = svc(w, "hello");
  const branch = w.fake.seedBranch(parent.view.id, "staging", { expires_at: 5000 });
  return { etag, parent, branch };
}

const auditRows = (w: World, action: string) =>
  w.app.deps.storage.db.all<{ action: string; target: string; data: string }>("SELECT action, target, data FROM audit WHERE action = ?", [action]);

interface SwitchRes {
  id?: string; state: string; from_version: number | null; to_version: number | null; inflight_old: number;
  dry_run: boolean; warnings: { code: string; names: string[] }[]; source: Record<string, unknown> | null;
  pending_migrations: string[] | null; next_cursor?: string;
}

describe("branches list", () => {
  it("shows URL, build state, digest and expiry", async () => {
    const w = await world();
    (w.app.deps.config as { runtimePublicUrl: string }).runtimePublicUrl = "https://apps.example.test";
    await withBranch(w);
    const res = await w.admin.call("GET", `${APPS}/hello/branches`);
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: Record<string, unknown>[] };
    expect(items).toEqual([{
      name: "staging", slug: "hello-br-staging", url: "https://hello-br-staging.apps.example.test/",
      build_state: "ready", live_version: 1, digest: "sha256:1", expires_at: 5000,
    }]);
  });

  it("a branch without a live version reports its newest build", async () => {
    const w = await world();
    await createApp(w.admin);
    w.fake.seedBranch(svc(w, "hello").view.id, "next", { live: false });
    const { items } = (await (await w.admin.call("GET", `${APPS}/hello/branches`)).json()) as { items: Record<string, unknown>[] };
    expect(items[0]).toMatchObject({ name: "next", live_version: null, digest: "sha256:1", expires_at: null });
  });

  it("drops a row of another project, should the runtime ever answer one", async () => {
    const w = await world();
    const { parent } = await withBranch(w);
    w.fake.seedBranch(parent.view.id, "other", { project: "elsewhere" });
    const { items } = (await (await w.admin.call("GET", `${APPS}/hello/branches`)).json()) as { items: { name: string }[] };
    expect(items.map((b) => b.name)).toEqual(["staging"]);
  });
});

describe("preflight", () => {
  it("reports names only, writes nothing and is not audited", async () => {
    const w = await world();
    const { etag, parent, branch } = await withBranch(w);
    branch.env = { API_TOKEN: "s3cret-value" };
    branch.secrets.set("DB_PASSWORD", 1);
    w.fake.inflightOld = 3;
    w.fake.dryRunExtra = { env: { API_TOKEN: "s3cret-value" }, created_by: "key_x" };
    const res = await w.admin.call("POST", `${APPS}/hello/switch`, { branch: "staging", dry_run: true }, { "if-match": etag });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("s3cret-value");
    expect(text).not.toContain("key_x");
    const body = JSON.parse(text) as SwitchRes;
    expect(body).toMatchObject({ dry_run: true, inflight_old: 3, from_version: 1, pending_migrations: null });
    expect(body.warnings).toEqual([{ code: "env_missing_on_parent", names: ["API_TOKEN", "DB_PASSWORD"] }]);
    expect(body.source).toEqual({ version: 1, digest: "sha256:1" });
    expect(parent.live).toBe(1);
    expect(parent.versions).toHaveLength(1);
    expect(await auditRows(w, "app.switch")).toHaveLength(0);
  });

  it("does not need If-Match", async () => {
    const w = await world();
    await withBranch(w);
    expect((await w.admin.call("POST", `${APPS}/hello/switch`, { branch: "staging", dry_run: true })).status).toBe(200);
  });
});

describe("switch", () => {
  it("flips, audits and is readable by id and in history", async () => {
    const w = await world();
    const { etag, parent } = await withBranch(w);
    const res = await w.admin.call("POST", `${APPS}/hello/switch`, { branch: "staging" }, { "if-match": etag });
    expect(res.status).toBe(202);
    const body = (await res.json()) as SwitchRes;
    expect(body).toMatchObject({ state: "draining", from_version: 1, to_version: 2, dry_run: false });
    expect(parent.live).toBe(2);
    const [row] = await auditRows(w, "app.switch");
    expect(row?.target).toBe("hello");
    expect(JSON.parse(row?.data ?? "{}")).toMatchObject({ branch: "staging", from: 1, to: 2, switch: body.id });

    const one = await w.admin.call("GET", `${APPS}/hello/switches/${body.id}`);
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ id: body.id, state: "draining" });
    const page = (await (await w.admin.call("GET", `${APPS}/hello/switches?limit=10`)).json()) as { items: SwitchRes[]; next_cursor: string | null };
    expect(page.items.map((x) => x.id)).toEqual([body.id]);
    expect(page.next_cursor).toBeNull();
  });

  it("a status read is one short runtime round trip after the lookup", async () => {
    const w = await world();
    const { etag } = await withBranch(w);
    const { id } = (await (await w.admin.call("POST", `${APPS}/hello/switch`, { branch: "staging" }, { "if-match": etag })).json()) as SwitchRes;
    const before = w.fake.calls.length;
    await w.admin.call("GET", `${APPS}/hello/switches/${id}`);
    expect(w.fake.calls.slice(before).map((c) => c.path).filter((p) => p.includes("/switches"))).toHaveLength(1);
    expect(w.fake.calls.length - before).toBeLessThanOrEqual(2);
  });

  it("needs If-Match (428); a stale one is 409 stale", async () => {
    const w = await world();
    await withBranch(w);
    expect((await w.admin.call("POST", `${APPS}/hello/switch`, { branch: "staging" })).status).toBe(428);
    const res = await w.admin.call("POST", `${APPS}/hello/switch`, { branch: "staging" }, { "if-match": '"999"' });
    expect(res.status).toBe(409);
    expect((await errOf(res)).code).toBe("stale");
  });

  it("the body names a branch of this app and nothing else", async () => {
    const w = await world();
    const { etag } = await withBranch(w);
    for (const bad of [{}, { branch: "" }, { branch: "../x" }, { branch: "UPPER" }, { branch: "a".repeat(25) }, { branch: 1 }]) {
      const res = await w.admin.call("POST", `${APPS}/hello/switch`, bad, { "if-match": etag });
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
    const res = await w.admin.call("POST", `${APPS}/hello/switch`, { branch: "staging", dry_run: "yes" }, { "if-match": etag });
    expect(res.status).toBe(422);
    const sourced = await w.admin.call("POST", `${APPS}/hello/switch`, { branch: "staging", service: "svc_x", digest: "sha256:evil" }, { "if-match": etag });
    expect(sourced.status).toBe(422);
    expect(w.fake.calls.filter((c) => c.path.endsWith("/switch"))).toHaveLength(0);
  });

  it("forwards only from, dry_run and close_sockets", async () => {
    const w = await world();
    const { etag } = await withBranch(w);
    await w.admin.call("POST", `${APPS}/hello/switch`, { branch: "staging", close_sockets: true }, { "if-match": etag });
    const call = w.fake.calls.find((c) => c.path.endsWith("/switch"));
    expect(call?.body).toEqual({ from: { branch: "staging" }, close_sockets: true, dry_run: false });
  });

  it("runtime refusals keep their stable codes", async () => {
    const w = await world();
    const { etag } = await withBranch(w);
    for (const [status, code, want] of [[409, "switch_in_progress", 409], [409, "not_a_branch", 409], [422, "runtime_mismatch", 422], [403, "reserved", 403]] as const) {
      w.fake.failNext({ status, code, match: (r) => r.path.endsWith("/switch") });
      const res = await w.admin.call("POST", `${APPS}/hello/switch`, { branch: "staging" }, { "if-match": etag });
      expect(res.status).toBe(want);
      expect((await errOf(res)).code).toBe(code);
    }
    expect((await w.admin.call("POST", `${APPS}/hello/switch`, { branch: "absent" }, { "if-match": etag })).status).toBe(404);
  });
});

describe("rollback", () => {
  it("returns to the previous version as a new switch, audited", async () => {
    const w = await world();
    const { etag, parent } = await withBranch(w);
    const sw = (await (await w.admin.call("POST", `${APPS}/hello/switch`, { branch: "staging" }, { "if-match": etag })).json()) as SwitchRes;
    const cur = (await w.admin.call("GET", `${APPS}/hello`)).headers.get("etag") ?? "";
    const res = await w.admin.call("POST", `${APPS}/hello/switches/${sw.id}/rollback`, {}, { "if-match": cur });
    expect(res.status).toBe(202);
    const body = (await res.json()) as SwitchRes;
    expect(body).toMatchObject({ to_version: 1, from_version: 2 });
    expect(body.id).not.toBe(sw.id);
    expect(parent.live).toBe(1);
    expect(JSON.parse((await auditRows(w, "app.rollback"))[0]?.data ?? "{}")).toMatchObject({ switch: sw.id, rollback: body.id, to: 1 });
  });

  it("needs If-Match; a stale one is 409 stale; a gone target keeps its code", async () => {
    const w = await world();
    const { etag } = await withBranch(w);
    const sw = (await (await w.admin.call("POST", `${APPS}/hello/switch`, { branch: "staging" }, { "if-match": etag })).json()) as SwitchRes;
    expect((await w.admin.call("POST", `${APPS}/hello/switches/${sw.id}/rollback`)).status).toBe(428);
    expect((await w.admin.call("POST", `${APPS}/hello/switches/${sw.id}/rollback`, {}, { "if-match": etag })).status).toBe(409);
    const cur = (await w.admin.call("GET", `${APPS}/hello`)).headers.get("etag") ?? "";
    w.fake.failNext({ status: 409, code: "rollback_target_gone", match: (r) => r.path.endsWith("/rollback") });
    const gone = await w.admin.call("POST", `${APPS}/hello/switches/${sw.id}/rollback`, {}, { "if-match": cur });
    expect((await errOf(gone)).code).toBe("rollback_target_gone");
  });
});

describe("authorization", () => {
  it("a viewer reads but cannot preflight, switch or roll back; a developer can", async () => {
    const w = await world();
    const { etag } = await withBranch(w);
    const sw = (await (await w.admin.call("POST", `${APPS}/hello/switch`, { branch: "staging" }, { "if-match": etag })).json()) as SwitchRes;
    const cur = (await w.admin.call("GET", `${APPS}/hello`)).headers.get("etag") ?? "";
    const before = w.fake.calls.length;

    const viewer = await w.user("viewer@x.test", "member", { default: "viewer" });
    expect((await viewer.call("GET", `${APPS}/hello/branches`)).status).toBe(200);
    expect((await viewer.call("GET", `${APPS}/hello/switches`)).status).toBe(200);
    expect((await viewer.call("GET", `${APPS}/hello/switches/${sw.id}`)).status).toBe(200);
    expect((await viewer.call("POST", `${APPS}/hello/switch`, { branch: "staging", dry_run: true })).status).toBe(403);
    expect((await viewer.call("POST", `${APPS}/hello/switch`, { branch: "staging" }, { "if-match": cur })).status).toBe(403);
    expect((await viewer.call("POST", `${APPS}/hello/switches/${sw.id}/rollback`, {}, { "if-match": cur })).status).toBe(403);
    expect(w.fake.calls.slice(before).filter((c) => c.method === "POST")).toHaveLength(0);

    const dev = await w.user("dev@x.test", "member", { default: "developer" });
    expect((await dev.call("POST", `${APPS}/hello/switch`, { branch: "staging", dry_run: true })).status).toBe(200);
    expect((await dev.call("POST", `${APPS}/hello/switches/${sw.id}/rollback`, {}, { "if-match": cur })).status).toBe(202);
  });

  it("a member without a grant on the project and a stranger both get 404", async () => {
    const w = await world();
    const { etag } = await withBranch(w);
    const member = await w.user("m@x.test", "member", { other: "admin" });
    expect((await member.call("GET", `${APPS}/hello/branches`)).status).toBe(404);
    expect((await member.call("POST", `${APPS}/hello/switch`, { branch: "staging" }, { "if-match": etag })).status).toBe(404);
    const stranger = await w.user("s@x.test", null);
    expect((await stranger.call("GET", `${APPS}/hello/branches`)).status).toBe(404);
    expect((await stranger.call("POST", `${APPS}/hello/switch`, { branch: "staging" }, { "if-match": etag })).status).toBe(404);
  });

  it("IDOR: another org's app and another app's switch id are 404", async () => {
    const w = await world();
    const { etag } = await withBranch(w);
    const sw = (await (await w.admin.call("POST", `${APPS}/hello/switch`, { branch: "staging" }, { "if-match": etag })).json()) as SwitchRes;

    await createApp(w.admin, "second");
    const secondEtag = (await w.admin.call("GET", `${APPS}/second`)).headers.get("etag") ?? "";
    expect((await w.admin.call("GET", `${APPS}/second/switches/${sw.id}`)).status).toBe(404);
    expect((await w.admin.call("POST", `${APPS}/second/switches/${sw.id}/rollback`, {}, { "if-match": secondEtag })).status).toBe(404);
    expect((await w.admin.call("POST", `${APPS}/second/switch`, { branch: "staging" }, { "if-match": secondEtag })).status).toBe(404);

    // The owner of a second org reaches its own tenant only: hello does not exist there.
    await w.addOrg("rival");
    const uid = "rival@x.test";
    const rival = await w.user(uid, null);
    const [row] = await w.app.deps.storage.db.all<{ id: string }>("SELECT id FROM users WHERE email = ?", [uid]);
    await w.app.deps.storage.db.run("INSERT INTO members (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', 0)", ["org_rival", row?.id ?? ""]);
    const R = "/api/orgs/rival/apps/hello";
    expect((await rival.call("GET", `${R}/branches`)).status).toBe(404);
    expect((await rival.call("GET", `${R}/switches`)).status).toBe(404);
    expect((await rival.call("GET", `${R}/switches/${sw.id}`)).status).toBe(404);
    expect((await rival.call("POST", `${R}/switch`, { branch: "staging", dry_run: true })).status).toBe(404);
    expect((await rival.call("POST", `${R}/switches/${sw.id}/rollback`, {}, { "if-match": etag })).status).toBe(404);
    // ...and it cannot address the acme app by its org either.
    expect((await rival.call("GET", `${APPS}/hello/switches/${sw.id}`)).status).toBe(404);
  });

  it("a malformed switch id is 404 before any runtime call", async () => {
    const w = await world();
    await withBranch(w);
    const before = w.fake.calls.length;
    expect((await w.admin.call("GET", `${APPS}/hello/switches/a%2F..%2Fb`)).status).toBe(404);
    expect(w.fake.calls.slice(before).filter((c) => c.path.includes("switches"))).toHaveLength(0);
  });

  it("history validates limit", async () => {
    const w = await world();
    await withBranch(w);
    expect((await w.admin.call("GET", `${APPS}/hello/switches?limit=0`)).status).toBe(422);
  });
});
