import { describe, expect, it } from "vitest";
import { argon2Hasher } from "../../src/auth/password.ts";
import { ADMIN, addUser, cookieOf, errCode, loginAs, post, PW, setupAdmin, signIn, testApp, TEST_SETUP_TOKEN } from "./helpers.ts";

describe("setup", () => {
  it("GET /api/setup is public on a fresh instance (no session, under the runtime base path)", async () => {
    const app = testApp();
    const res = await app.call("GET", "/api/setup", { headers: { "x-rt-base-path": "/s/console" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ needed: true });
  });

  it("reports needed until the first user exists", async () => {
    const app = testApp();
    expect(await (await app.call("GET", "/api/setup")).json()).toEqual({ needed: true });
    await setupAdmin(app);
    expect(await (await app.call("GET", "/api/setup")).json()).toEqual({ needed: false });
  });

  it("creates an instance admin and returns a session", async () => {
    const app = testApp();
    const res = await post(app, "/api/setup", { setup_token: TEST_SETUP_TOKEN, ...ADMIN, email: " Admin@Example.com " });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: Record<string, unknown>; csrf: string };
    expect(body.user).toMatchObject({ email: "admin@example.com", name: "Admin", instance_admin: true, totp_enabled: false, must_change_password: false });
    expect(body.csrf).toMatch(/^[0-9a-f]{64}$/);
    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toMatch(/^__Host-rtw_session=[0-9a-f]{64}; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["wrong", "nope"],
  ])("rejects a %s setup token with 403 before validation", async (_n, token) => {
    const app = testApp();
    const res = await post(app, "/api/setup", { setup_token: token, email: "bad", name: "", password: "x" });
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("setup_token_invalid");
    expect(await (await app.call("GET", "/api/setup")).json()).toEqual({ needed: true });
  });

  it("refuses when no setup token is configured", async () => {
    const app = testApp();
    app.deps.config = { ...app.deps.config, setupToken: undefined };
    const res = await post(app, "/api/setup", { setup_token: "anything", ...ADMIN });
    expect(res.status).toBe(403);
  });

  it("validates fields with 422 invalid", async () => {
    const app = testApp();
    const res = await post(app, "/api/setup", { setup_token: TEST_SETUP_TOKEN, email: "no-at", name: " ", password: "short" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { details: { fields: Record<string, string> } } };
    expect(body.error.details.fields).toEqual({ email: "invalid_format", name: "required", password: "too_short" });
  });

  it("only once: 409 already_set_up", async () => {
    const app = testApp();
    await setupAdmin(app);
    const res = await post(app, "/api/setup", { setup_token: TEST_SETUP_TOKEN, ...ADMIN, email: "b@example.com" });
    expect(res.status).toBe(409);
    expect(await errCode(res)).toBe("already_set_up");
  });

  it("needs Origin", async () => {
    const app = testApp();
    const res = await app.call("POST", "/api/setup", { body: { setup_token: TEST_SETUP_TOKEN, ...ADMIN } });
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("origin_invalid");
  });
});

describe("login", () => {
  it("signs in and returns the session shape", async () => {
    const app = testApp();
    await addUser(app, "u@example.com");
    const res = await loginAs(app, "U@example.com");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.mfa_required).toBe(false);
    expect(body.user).toMatchObject({ email: "u@example.com" });
    expect(typeof body.csrf).toBe("string");
    cookieOf(res);
  });

  it("does not enumerate users: unknown, wrong password, disabled are all 401 invalid_credentials", async () => {
    const app = testApp();
    await addUser(app, "u@example.com");
    await addUser(app, "off@example.com", { disabled: true });
    for (const [email, pw] of [["nobody@example.com", PW], ["u@example.com", "wrong password!!"], ["off@example.com", PW]] as const) {
      const res = await loginAs(app, email, pw);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: { code: "invalid_credentials", message: "invalid email or password" } });
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("locks out after 10 failures per (ip, email) for 15 minutes, with Retry-After", async () => {
    const app = testApp();
    await addUser(app, "u@example.com");
    const ip = { "x-rt-client-ip": "203.0.113.5" };
    for (let i = 0; i < 10; i++) expect((await loginAs(app, "u@example.com", "wrong password!!", ip)).status).toBe(401);
    const blocked = await loginAs(app, "u@example.com", PW, ip);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("900");
    expect(await errCode(blocked)).toBe("rate_limited");
    // another IP is not affected
    expect((await loginAs(app, "u@example.com", PW, { "x-rt-client-ip": "203.0.113.6" })).status).toBe(200);
    app.tick(15 * 60_000 + 1);
    expect((await loginAs(app, "u@example.com", PW, ip)).status).toBe(200);
  });

  it("success resets the failure budget", async () => {
    const app = testApp();
    await addUser(app, "u@example.com");
    for (let i = 0; i < 9; i++) await loginAs(app, "u@example.com", "wrong password!!");
    expect((await loginAs(app, "u@example.com")).status).toBe(200);
    for (let i = 0; i < 9; i++) expect((await loginAs(app, "u@example.com", "wrong password!!")).status).toBe(401);
    expect((await loginAs(app, "u@example.com")).status).toBe(200);
  });

  it("records login events for the user", async () => {
    const app = testApp();
    await addUser(app, "u@example.com");
    await loginAs(app, "u@example.com", "wrong password!!", { "user-agent": "ua1" });
    const c = await signIn(app, "u@example.com");
    const res = await c.call("GET", "/api/me/logins");
    const items = ((await res.json()) as { items: { method: string; result: string; ua: string; id: string }[] }).items;
    expect(items.map((i) => i.result)).toEqual(["ok", "bad_password"]);
    expect(items[1]).toMatchObject({ method: "password", ua: "ua1" });
    expect(items[0]?.id).toMatch(/^lev_/);
    expect((await c.call("GET", "/api/me/logins?limit=1").then((r) => r.json()) as { items: unknown[] }).items).toHaveLength(1);
    expect((await c.call("GET", "/api/me/logins?limit=500")).status).toBe(422);
  });

  it("password_login_disabled blocks non-admins only", async () => {
    const app = testApp();
    await addUser(app, "u@example.com");
    await addUser(app, "a@example.com", { admin: true });
    await app.deps.storage.db.run("INSERT INTO settings (key, value) VALUES ('auth.password_login_disabled', 'true')");
    const res = await loginAs(app, "u@example.com");
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("password_login_disabled");
    expect((await loginAs(app, "a@example.com")).status).toBe(200);
    const prov = await (await app.call("GET", "/api/auth/providers")).json();
    expect(prov).toEqual({ password_login_disabled: true, providers: [] });
  });

  it("verifies a Go-generated argon2id hash (real parameters)", async () => {
    const app = testApp({ hasher: argon2Hasher });
    await addUser(app, "seed@example.com", { password: "placeholder-password" });
    const GO_HASH = "$argon2id$v=19$m=65536,t=3,p=2$VSqhxuPNyep9IOl0uGtMvA$doVPygo6P9coakYPE0L55D49Cs+2BmQeQvraLGH40zc";
    await app.deps.storage.db.run("UPDATE users SET pw_hash = ? WHERE email = ?", [GO_HASH, "seed@example.com"]);
    expect((await loginAs(app, "seed@example.com", "correct horse battery")).status).toBe(200);
    expect((await loginAs(app, "seed@example.com", "correct horse batter")).status).toBe(401);
  }, 60_000);

  it("logout revokes the session and clears the cookie", async () => {
    const app = testApp();
    await addUser(app, "u@example.com");
    const c = await signIn(app, "u@example.com");
    const res = await c.call("POST", "/api/auth/logout");
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await c.call("GET", "/api/me")).status).toBe(401);
  });
});
