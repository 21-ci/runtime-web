import { describe, expect, it } from "vitest";
import { cookieOf, errCode, post, TEST_ORIGIN } from "../auth/helpers.ts";
import { member, world, makeOrg, type World } from "../orgs/helpers.ts";
import { INVITE_TTL_MS } from "../../src/invites/invites.ts";

const tokenOf = (link: string) => link.split("/invite/")[1] as string;

async function invite(w: World, body: Record<string, unknown>, path = "/api/orgs/default/invites") {
  const res = await w.admin.call("POST", path, body);
  expect(res.status).toBe(201);
  return (await res.json()) as { invite: { id: string; role: string | null; org: unknown }; link: string };
}

describe("invites", () => {
  it("create, list, preview; link uses the console origin; token not stored", async () => {
    const w = await world();
    const { invite: inv, link } = await invite(w, { email: "New@x.com", role: "admin" });
    expect(link.startsWith(`${TEST_ORIGIN}/invite/`)).toBe(true);
    expect(inv).toMatchObject({ email: "new@x.com", role: "admin", org: { slug: "default", name: "Default" } });
    const row = await w.app.deps.storage.db.first<{ token_hash: string }>("SELECT token_hash FROM invites");
    expect(row?.token_hash).not.toBe(tokenOf(link));
    const list = (await (await w.admin.call("GET", "/api/orgs/default/invites")).json()) as { items: unknown[] };
    expect(list.items).toHaveLength(1);
    const pv = await w.app.call("GET", `/api/invites/accept/${tokenOf(link)}`);
    expect(await pv.json()).toEqual({ email: "new@x.com", org_name: "Default" });
    expect(await errCode(await w.app.call("GET", "/api/invites/accept/nope"))).toBe("invite_invalid");
  });

  it("accept for a new email creates the user, membership and session; single use", async () => {
    const w = await world();
    const { link } = await invite(w, { email: "new@x.com" });
    const t = tokenOf(link);
    const bad = await post(w.app, `/api/invites/accept/${t}`, { name: "", password: "short" });
    expect(bad.status).toBe(422);
    const res = await post(w.app, `/api/invites/accept/${t}`, { name: "New", password: "correct horse battery" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { email: string; mfa_required: boolean; csrf: string };
    expect(body).toMatchObject({ email: "new@x.com", mfa_required: false });
    const me = await w.app.call("GET", "/api/me", { headers: { cookie: cookieOf(res) } });
    expect(((await me.json()) as { orgs: { slug: string; role: string }[] }).orgs).toEqual([{ slug: "default", name: "Default", role: "member" }]);
    const again = await post(w.app, `/api/invites/accept/${t}`, { name: "New", password: "correct horse battery" });
    expect([again.status, await errCode(again)]).toEqual([404, "invite_invalid"]);
    const pv = await w.app.call("GET", `/api/invites/accept/${t}`);
    expect(pv.status).toBe(404);
  });

  it("existing account must be signed in; membership kept if already a member", async () => {
    const w = await world();
    const u = await member(w, "u@x.com");
    const { link } = await invite(w, { email: "u@x.com", role: "admin" });
    const t = tokenOf(link);
    const anon = await post(w.app, `/api/invites/accept/${t}`, {});
    expect([anon.status, await errCode(anon)]).toEqual([403, "invite_login_required"]);
    const other = await w.admin.call("POST", `/api/invites/accept/${t}`, {});
    expect(await errCode(other)).toBe("invite_login_required");
    const ok = await u.c.call("POST", `/api/invites/accept/${t}`, {});
    expect(await ok.json()).toEqual({ email: "u@x.com", mfa_required: false });
    expect(ok.headers.get("set-cookie")).toBeNull();
    const m = await w.app.deps.storage.db.first<{ role: string }>("SELECT role FROM members WHERE user_id = ?", [u.id]);
    expect(m?.role).toBe("admin");
  });

  it("disabled account and expiry", async () => {
    const w = await world();
    const u = await member(w, "u@x.com");
    const { link } = await invite(w, { email: "u@x.com" });
    await w.admin.call("PATCH", `/api/admin/users/${u.id}`, { disabled: true });
    expect(await errCode(await post(w.app, `/api/invites/accept/${tokenOf(link)}`, {}))).toBe("account_disabled");
    const { link: l2 } = await invite(w, { email: "z@x.com" });
    w.app.tick(INVITE_TTL_MS);
    expect(await errCode(await post(w.app, `/api/invites/accept/${tokenOf(l2)}`, { name: "Z", password: "correct horse battery" }))).toBe("invite_invalid");
  });

  it("authz: org admin cannot invite owners; members cannot invite; revoke is org-scoped", async () => {
    const w = await world();
    const adm = await member(w, "a@x.com", "default", "admin");
    const mem = await member(w, "m@x.com", "default", "member");
    expect((await adm.c.call("POST", "/api/orgs/default/invites", { email: "o@x.com", role: "owner" })).status).toBe(403);
    expect((await mem.c.call("POST", "/api/orgs/default/invites", { email: "o@x.com" })).status).toBe(403);
    expect((await mem.c.call("GET", "/api/orgs/default/invites")).status).toBe(403);
    const r = await adm.c.call("POST", "/api/orgs/default/invites", { email: "o@x.com" });
    const id = ((await r.json()) as { invite: { id: string } }).invite.id;
    await makeOrg(w, "acme", (await member(w, "own@x.com")).id);
    expect((await w.admin.call("DELETE", `/api/orgs/acme/invites/${id}`)).status).toBe(404);
    expect((await adm.c.call("DELETE", `/api/orgs/default/invites/${id}`)).status).toBe(204);
    expect((await adm.c.call("DELETE", `/api/orgs/default/invites/${id}`)).status).toBe(404);
    const bad = await adm.c.call("POST", "/api/orgs/default/invites", { email: "x" });
    expect(bad.status).toBe(422);
  });

  it("admin invites: unbound, org-bound, filter, revoke", async () => {
    const w = await world();
    const un = await invite(w, { email: "free@x.com" }, "/api/admin/invites");
    expect([un.invite.org, un.invite.role]).toEqual([null, null]);
    await invite(w, { email: "b@x.com", org: "default", role: "owner" }, "/api/admin/invites");
    expect((await w.admin.call("POST", "/api/admin/invites", { email: "c@x.com", org: "nope" })).status).toBe(404);
    expect((await w.admin.call("POST", "/api/admin/invites", { email: "c@x.com", role: "admin" })).status).toBe(422);
    const all = (await (await w.admin.call("GET", "/api/admin/invites")).json()) as { items: unknown[] };
    expect(all.items).toHaveLength(2);
    const f = (await (await w.admin.call("GET", "/api/admin/invites?org=default")).json()) as { items: unknown[] };
    expect(f.items).toHaveLength(1);
    expect((await w.admin.call("DELETE", `/api/admin/invites/${un.invite.id}`)).status).toBe(204);
    const res = await post(w.app, `/api/invites/accept/${tokenOf(un.link)}`, { name: "F", password: "correct horse battery" });
    expect(res.status).toBe(404);
  });

  it("accept needs Origin", async () => {
    const w = await world();
    const { link } = await invite(w, { email: "n@x.com" });
    const res = await w.app.call("POST", `/api/invites/accept/${tokenOf(link)}`, { body: { name: "N", password: "correct horse battery" } });
    expect([res.status, await errCode(res)]).toEqual([403, "origin_invalid"]);
  });
});
