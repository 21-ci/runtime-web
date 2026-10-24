import { describe, expect, it } from "vitest";
import { addUser, errCode, loginAs, signIn } from "../auth/helpers.ts";
import { adminId, makeOrg, member, world } from "../orgs/helpers.ts";

describe("admin users", () => {
  it("create returns a temp password that forces a change; email_taken; invalid", async () => {
    const w = await world();
    const res = await w.admin.call("POST", "/api/admin/users", { email: "New@Example.com", name: "New" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: { email: string; must_change_password: boolean; instance_admin: boolean }; temp_password: string };
    expect(body.user).toMatchObject({ email: "new@example.com", must_change_password: true, instance_admin: false });
    expect(body.temp_password).toMatch(/^[A-Z2-7]{20}$/);
    expect((await loginAs(w.app, "new@example.com", body.temp_password)).status).toBe(200);
    const dup = await w.admin.call("POST", "/api/admin/users", { email: "new@example.com", name: "x" });
    expect([dup.status, await errCode(dup)]).toEqual([409, "email_taken"]);
    const bad = await w.admin.call("POST", "/api/admin/users", { email: "nope", name: "" });
    expect(((await bad.json()) as { error: { details: { fields: object } } }).error.details.fields).toEqual({ email: "invalid_format", name: "required" });
  });

  it("list pages with cursor and filters by q", async () => {
    const w = await world();
    for (const e of ["a@x.com", "b@x.com", "c@y.com"]) await addUser(w.app, e);
    const p1 = (await (await w.admin.call("GET", "/api/admin/users?limit=2")).json()) as { items: { email: string }[]; next_cursor: string };
    expect(p1.items).toHaveLength(2);
    const p2 = (await (await w.admin.call("GET", `/api/admin/users?limit=2&cursor=${p1.next_cursor}`)).json()) as { items: unknown[]; next_cursor: null };
    expect([p2.items.length, p2.next_cursor]).toEqual([2, null]);
    const q = (await (await w.admin.call("GET", "/api/admin/users?q=X.COM")).json()) as { items: { email: string }[] };
    expect(q.items.map((u) => u.email).sort()).toEqual(["a@x.com", "b@x.com"]);
  });

  it("patch: last_admin on disable/demote, disable revokes sessions", async () => {
    const w = await world();
    const me = await adminId(w);
    for (const b of [{ disabled: true }, { instance_admin: false }]) {
      const r = await w.admin.call("PATCH", `/api/admin/users/${me}`, b);
      expect([r.status, await errCode(r)]).toEqual([409, "last_admin"]);
    }
    const u = await member(w, "u@example.com");
    const r = await w.admin.call("PATCH", `/api/admin/users/${u.id}`, { disabled: true, name: "Uu" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ name: "Uu", disabled: true });
    expect((await u.c.call("GET", "/api/me")).status).toBe(401);
    expect((await w.admin.call("PATCH", "/api/admin/users/usr_nope", { name: "x" })).status).toBe(404);
    expect((await w.admin.call("PATCH", `/api/admin/users/${u.id}`, { disabled: "yes" })).status).toBe(422);
  });

  it("delete: last_admin, last_owner, then anonymises", async () => {
    const w = await world();
    const me = await adminId(w);
    const r1 = await w.admin.call("DELETE", `/api/admin/users/${me}`);
    expect([r1.status, await errCode(r1)]).toEqual([409, "last_admin"]);
    const o = await member(w, "owner@example.com");
    await makeOrg(w, "acme", o.id);
    const r2 = await w.admin.call("DELETE", `/api/admin/users/${o.id}`);
    expect([r2.status, await errCode(r2)]).toEqual([409, "last_owner"]);
    const u = await member(w, "u@example.com", "acme", "member");
    expect((await w.admin.call("DELETE", `/api/admin/users/${u.id}`)).status).toBe(204);
    expect((await u.c.call("GET", "/api/me")).status).toBe(401);
    expect((await w.admin.call("DELETE", `/api/admin/users/${u.id}`)).status).toBe(404);
    expect((await loginAs(w.app, "u@example.com")).status).toBe(401);
    const n = await w.app.deps.storage.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE user_id = ?", [u.id]);
    expect(n?.n).toBe(0);
  });

  it("reset-password and reset totp revoke sessions", async () => {
    const w = await world();
    const u = await member(w, "u@example.com");
    const r = await w.admin.call("POST", `/api/admin/users/${u.id}/reset-password`);
    const { temp_password } = (await r.json()) as { temp_password: string };
    expect((await u.c.call("GET", "/api/me")).status).toBe(401);
    const again = await signIn(w.app, "u@example.com", temp_password);
    expect((await w.admin.call("DELETE", `/api/admin/users/${u.id}/totp`)).status).toBe(204);
    expect((await again.call("GET", "/api/me")).status).toBe(401);
    expect((await w.admin.call("POST", "/api/admin/users/usr_nope/reset-password")).status).toBe(404);
    expect((await w.admin.call("DELETE", "/api/admin/users/usr_nope/totp")).status).toBe(404);
  });

  it("needs instance admin", async () => {
    const w = await world();
    const u = await member(w, "u@example.com");
    expect((await u.c.call("GET", "/api/admin/users")).status).toBe(403);
  });
});
