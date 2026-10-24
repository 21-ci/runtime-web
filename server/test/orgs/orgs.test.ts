import { describe, expect, it } from "vitest";
import { errCode, testApp, setupAdmin } from "../auth/helpers.ts";
import { FakeRtCtl } from "../fakes/rtctl.ts";
import { defaultKeyScopes } from "../../src/authz/policy.ts";
import { adminId, makeOrg, member, project, world } from "./helpers.ts";

describe("setup first org", () => {
  it("creates the default org with a runtime tenant and hidden default key", async () => {
    const w = await world();
    const tenantCalls = w.fake.calls.filter((c) => c.scope === "op" && c.method === "POST");
    expect(tenantCalls.map((c) => c.path)).toEqual(["/v1/tenants", expect.stringMatching(/^\/v1\/tenants\/[^/]+\/keys$/)]);
    expect((tenantCalls[1]?.body as { scopes: string[] }).scopes).toEqual(defaultKeyScopes());
    const res = await w.admin.call("GET", "/api/orgs");
    const body = (await res.json()) as { items: { slug: string; role: string }[] };
    expect(body.items).toEqual([expect.objectContaining({ slug: "default", role: "owner" })]);
    const row = await w.app.deps.storage.db.first<{ default_key_sealed: Uint8Array }>("SELECT default_key_sealed FROM orgs");
    expect(new TextDecoder().decode(row?.default_key_sealed)).not.toContain("rtk_");
  });

  it("setup still succeeds when the runtime is down", async () => {
    const fake = new FakeRtCtl();
    fake.failNext({ status: 503, code: "control_disabled" });
    const app = testApp({ rtctl: fake });
    const admin = await setupAdmin(app);
    const res = await admin.call("GET", "/api/orgs");
    expect(((await res.json()) as { items: unknown[] }).items).toEqual([]);
  });
});

describe("admin orgs", () => {
  it("create, slug_taken, invalid, rename, list", async () => {
    const w = await world();
    const me = await adminId(w);
    await makeOrg(w, "acme", me);
    expect(w.fake.tenants.size).toBe(2);
    const dup = await w.admin.call("POST", "/api/admin/orgs", { slug: "acme", name: "x", owner_user_id: me });
    expect([dup.status, await errCode(dup)]).toEqual([409, "slug_taken"]);
    const bad = await w.admin.call("POST", "/api/admin/orgs", { slug: "", name: "x" });
    expect([bad.status, await errCode(bad)]).toEqual([422, "invalid"]);
    const ren = await w.admin.call("PATCH", "/api/admin/orgs/acme", { name: "Acme Inc" });
    expect(ren.status).toBe(200);
    expect(((await ren.json()) as { name: string }).name).toBe("Acme Inc");
    expect((await w.admin.call("PATCH", "/api/admin/orgs/nope", { name: "x" })).status).toBe(404);
    const list = (await (await w.admin.call("GET", "/api/admin/orgs")).json()) as { items: unknown[] };
    expect(list.items).toHaveLength(2);
  });

  it("purges the tenant if the default key cannot be created", async () => {
    const w = await world();
    w.fake.failNext({ status: 500, match: (r) => r.path.endsWith("/keys") });
    const res = await w.admin.call("POST", "/api/admin/orgs", { slug: "acme", name: "A", owner_user_id: await adminId(w) });
    expect(res.status).toBe(502);
    expect(w.fake.tenants.size).toBe(1);
  });

  it("delete refuses org_not_empty, then deletes the tenant", async () => {
    const w = await world();
    await makeOrg(w, "acme", await adminId(w));
    const tenantId = [...w.fake.tenants.values()].find((t) => t.name === "acme")?.id as string;
    const { Runtime } = await import("../../src/runtime/client.ts");
    const { defaultKey, getOrgBySlug } = await import("../../src/orgs/orgs.ts");
    const o = await getOrgBySlug(w.app.deps.storage.db, "acme");
    const key = await defaultKey(w.app.deps, o?.id as string);
    const rt = new Runtime(w.fake).as(key);
    const svc = await rt.createService({ slug: "web-acme-1", runtime: "deno" } as never);
    const res = await w.admin.call("DELETE", "/api/admin/orgs/acme");
    expect([res.status, await errCode(res)]).toEqual([409, "org_not_empty"]);
    await rt.deleteService(svc.id);
    expect((await w.admin.call("DELETE", "/api/admin/orgs/acme")).status).toBe(204);
    expect(w.fake.tenants.has(tenantId)).toBe(false);
    expect((await w.admin.call("GET", "/api/orgs/acme")).status).toBe(404);
  });

  it("default key is sealed per org: swapped blobs fail, legacy no-AAD blobs open and get resealed", async () => {
    const w = await world();
    const { defaultKey, getOrgBySlug } = await import("../../src/orgs/orgs.ts");
    const { sealerOf } = await import("../../src/auth/types.ts");
    const { SealError } = await import("../../src/crypto/seal.ts");
    await makeOrg(w, "acme", await adminId(w));
    await makeOrg(w, "beta", await adminId(w));
    const db = w.app.deps.storage.db;
    const a = (await getOrgBySlug(db, "acme"))?.id as string;
    const b = (await getOrgBySlug(db, "beta"))?.id as string;
    const keyA = await defaultKey(w.app.deps, a);
    const blob = async (id: string) =>
      new Uint8Array((await db.first<{ s: Uint8Array }>("SELECT default_key_sealed AS s FROM orgs WHERE id = ?", [id]))?.s as Uint8Array);
    // copy acme's sealed key into beta: must not open as beta's key
    await db.run("UPDATE orgs SET default_key_sealed = ? WHERE id = ?", [await blob(a), b]);
    await expect(defaultKey(w.app.deps, b)).rejects.toBeInstanceOf(SealError);
    // legacy value (sealed before contexts) opens once and is rewritten bound to the org
    const legacy = await (await sealerOf(w.app.deps)).seal(new TextEncoder().encode(keyA));
    await db.run("UPDATE orgs SET default_key_sealed = ? WHERE id = ?", [legacy, a]);
    expect(await defaultKey(w.app.deps, a)).toBe(keyA);
    const now = await blob(a);
    expect(Buffer.from(now).equals(Buffer.from(legacy))).toBe(false);
    await expect((await sealerOf(w.app.deps)).open(now)).rejects.toBeInstanceOf(SealError);
    expect(new TextDecoder().decode(await (await sealerOf(w.app.deps)).open(now, `org.default_key:${a}`))).toBe(keyA);
  });

  it("admin routes need instance admin", async () => {
    const w = await world();
    const u = await member(w, "bob@example.com");
    const res = await u.c.call("GET", "/api/admin/orgs");
    expect([res.status, await errCode(res)]).toEqual([403, "forbidden"]);
  });
});

describe("org visibility and members", () => {
  it("non-members get 404, members see the org with their role", async () => {
    const w = await world();
    const m = await member(w, "m@example.com", "default", "member");
    const out = await member(w, "o@example.com");
    expect((await out.c.call("GET", "/api/orgs/default")).status).toBe(404);
    expect(((await (await out.c.call("GET", "/api/orgs")).json()) as { items: unknown[] }).items).toEqual([]);
    const res = await m.c.call("GET", "/api/orgs/default");
    expect(((await res.json()) as { role: string }).role).toBe("member");
    const mem = (await (await m.c.call("GET", "/api/orgs/default/members")).json()) as { items: { user: { email: string }; role: string }[] };
    expect(mem.items.map((x) => [x.user.email, x.role])).toEqual([["admin@example.com", "owner"], ["m@example.com", "member"]]);
    const add = await m.c.call("POST", "/api/orgs/default/members", { user_id: out.id, role: "member" });
    expect([add.status, await errCode(add)]).toEqual([403, "forbidden"]);
  });

  it("already_member, owner promotion needs owner, last_owner", async () => {
    const w = await world();
    const me = await adminId(w);
    const adm = await member(w, "a@example.com", "default", "admin");
    const u = await member(w, "u@example.com");
    const add = await adm.c.call("POST", "/api/orgs/default/members", { user_id: u.id, role: "member" });
    expect(add.status).toBe(201);
    expect(await add.json()).toEqual({ user: { id: u.id, email: "u@example.com", name: "u" }, role: "member", grants: {} });
    const dup = await adm.c.call("POST", "/api/orgs/default/members", { user_id: u.id, role: "member" });
    expect([dup.status, await errCode(dup)]).toEqual([409, "already_member"]);
    const promote = await adm.c.call("PATCH", `/api/orgs/default/members/${u.id}`, { role: "owner" });
    expect(promote.status).toBe(403);
    const demoteOwner = await adm.c.call("PATCH", `/api/orgs/default/members/${me}`, { role: "member" });
    expect(demoteOwner.status).toBe(403);
    const last = await w.admin.call("PATCH", `/api/orgs/default/members/${me}`, { role: "admin" });
    expect([last.status, await errCode(last)]).toEqual([409, "last_owner"]);
    const rm = await w.admin.call("DELETE", `/api/orgs/default/members/${me}`);
    expect([rm.status, await errCode(rm)]).toEqual([409, "last_owner"]);
    expect((await w.admin.call("PATCH", `/api/orgs/default/members/${u.id}`, { role: "owner" })).status).toBe(200);
    expect((await w.admin.call("PATCH", `/api/orgs/default/members/${me}`, { role: "admin" })).status).toBe(200);
    expect((await adm.c.call("DELETE", `/api/orgs/default/members/${me}`)).status).toBe(204);
    expect((await adm.c.call("DELETE", `/api/orgs/default/members/${me}`)).status).toBe(404);
    const bad = await w.admin.call("PATCH", `/api/orgs/default/members/${u.id}`, { role: "god" });
    expect(bad.status).toBe(422);
  });

  it("grants: set, project 404, visibility, remove", async () => {
    const w = await world();
    await project(w, "default", "web");
    const m = await member(w, "m@example.com", "default", "member");
    const put = await w.admin.call("PUT", `/api/orgs/default/members/${m.id}/grants/web`, { role: "admin" });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { grants: unknown }).grants).toEqual({ web: "admin" });
    expect((await w.admin.call("PUT", `/api/orgs/default/members/${m.id}/grants/nope`, { role: "viewer" })).status).toBe(404);
    expect((await w.admin.call("PUT", `/api/orgs/default/members/${m.id}/grants/web`, { role: "owner" })).status).toBe(422);
    // member with project admin can manage grants on web only
    const v = await member(w, "v@example.com", "default", "member");
    expect((await m.c.call("PUT", `/api/orgs/default/members/${v.id}/grants/web`, { role: "viewer" })).status).toBe(200);
    expect((await v.c.call("DELETE", `/api/orgs/default/members/${m.id}/grants/web`)).status).toBe(403);
    expect((await m.c.call("DELETE", `/api/orgs/default/members/${v.id}/grants/api`)).status).toBe(404);
    expect((await m.c.call("DELETE", `/api/orgs/default/members/${v.id}/grants/web`)).status).toBe(204);
    expect((await m.c.call("DELETE", `/api/orgs/default/members/${v.id}/grants/web`)).status).toBe(404);
  });

  it("instance admin sees every org with role null and acts as owner (audited)", async () => {
    const w = await world();
    const o = await member(w, "o@example.com");
    await makeOrg(w, "acme", o.id);
    const res = await w.admin.call("GET", "/api/orgs/acme");
    expect(((await res.json()) as { role: unknown }).role).toBeNull();
    const u = await member(w, "u@example.com");
    expect((await w.admin.call("POST", "/api/orgs/acme/members", { user_id: u.id, role: "owner" })).status).toBe(201);
    const a = await w.app.deps.storage.db.first<{ data: string; as_instance_admin: number }>("SELECT data, as_instance_admin FROM audit WHERE action = 'member.add'");
    expect(JSON.parse(a?.data ?? "{}")).toEqual({ role: "owner" });
    expect(a?.as_instance_admin).toBe(1);
  });

  it("CSRF is required on member mutations", async () => {
    const w = await world();
    const res = await w.admin.call("POST", "/api/orgs/default/members", { user_id: "x", role: "member" }, { "x-csrf-token": "bad" });
    expect([res.status, await errCode(res)]).toEqual([403, "csrf_invalid"]);
  });
});

describe("default plan", () => {
  it("new tenants use config.defaultPlan", async () => {
    const w = await world();
    w.app.deps.config = { ...w.app.deps.config, defaultPlan: "pro" };
    await makeOrg(w, "acme", await adminId(w));
    expect([...w.fake.tenants.values()].map((t) => t.plan)).toContain("pro");
  });

  it("a plan the runtime does not have fails with a clear error naming RTWEB_DEFAULT_PLAN", async () => {
    const w = await world();
    w.app.deps.config = { ...w.app.deps.config, defaultPlan: "nope" };
    const res = await w.admin.call("POST", "/api/admin/orgs", { slug: "acme", name: "A", owner_user_id: await adminId(w) });
    expect(res.status).toBe(500);
    const e = ((await res.json()) as { error: { code: string; message: string; details: unknown } }).error;
    expect(e.code).toBe("default_plan_missing");
    expect(e.message).toContain("RTWEB_DEFAULT_PLAN");
    expect(e.details).toMatchObject({ plan: "nope", available: expect.arrayContaining(["free", "pro"]) });
  });
});
