import { describe, expect, it } from "vitest";
import { hotp, base32Decode } from "../../src/crypto/totp.ts";
import { requireAdmin, requireSession, authOf } from "../../src/auth/middleware.ts";
import { Router } from "../../src/http/router.ts";
import { json } from "../../src/http/json.ts";
import { addUser, client, codeFor, cookieOf, enableTotp, errCode, loginAs, post, PW, setupAdmin, signIn, testApp, TEST_ORIGIN } from "./helpers.ts";

describe("middleware", () => {
  it("CSRF missing or wrong is 403 csrf_invalid; GET needs none", async () => {
    const app = testApp();
    const c = await setupAdmin(app);
    for (const tok of ["", "wrong"]) {
      const res = await app.call("POST", "/api/me/sessions/revoke-others", { headers: { origin: TEST_ORIGIN, cookie: c.cookie, "x-csrf-token": tok } });
      expect(res.status).toBe(403);
      expect(await errCode(res)).toBe("csrf_invalid");
    }
    expect((await app.call("GET", "/api/me", { headers: { cookie: c.cookie } })).status).toBe(200);
    expect((await c.call("POST", "/api/me/sessions/revoke-others")).status).toBe(200);
  });

  it("Origin missing or foreign is 403 origin_invalid on unsafe methods", async () => {
    const app = testApp();
    const c = await setupAdmin(app);
    for (const o of [undefined, "https://evil.test", "http://console.test"]) {
      const headers: Record<string, string> = { cookie: c.cookie, "x-csrf-token": c.csrf };
      if (o) headers.origin = o;
      const res = await app.call("POST", "/api/auth/logout", { headers });
      expect(res.status).toBe(403);
      expect(await errCode(res)).toBe("origin_invalid");
    }
  });

  it("no or bad cookie is 401 unauthenticated", async () => {
    const app = testApp();
    expect(await errCode(await app.call("GET", "/api/me"))).toBe("unauthenticated");
    expect((await app.call("GET", "/api/me", { headers: { cookie: "__Host-rtw_session=zz" } })).status).toBe(401);
  });

  it("must_change_password gates everything but /api/me, password and logout", async () => {
    const app = testApp();
    await addUser(app, "m@example.com", { mustChange: true });
    const c = await signIn(app, "m@example.com");
    const blocked = await c.call("GET", "/api/me/sessions");
    expect(blocked.status).toBe(403);
    expect(await errCode(blocked)).toBe("password_change_required");
    expect((await c.call("GET", "/api/me")).status).toBe(200);
    expect((await c.call("PUT", "/api/me/password", { current_password: PW, new_password: "a brand new password" })).status).toBe(204);
    expect((await c.call("GET", "/api/me/sessions")).status).toBe(200);
  });

  it("require_2fa gates users without TOTP except /api/me and /api/me/totp/*", async () => {
    const app = testApp();
    await addUser(app, "u@example.com");
    await app.deps.storage.db.run("INSERT INTO settings (key, value) VALUES ('auth.require_2fa', 'true')");
    const c = await signIn(app, "u@example.com");
    const res = await c.call("GET", "/api/me/sessions");
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("mfa_enrollment_required");
    const me = (await (await c.call("GET", "/api/me")).json()) as Record<string, unknown>;
    expect(me).toMatchObject({ mfa_enrollment_required: true, policy: { require_2fa: true, password_login_disabled: false }, orgs: [] });
    await enableTotp(app, c);
    expect((await c.call("GET", "/api/me/sessions")).status).toBe(200);
  });

  it("requireAdmin and authOf for other route modules", async () => {
    const app = testApp();
    const admin = await setupAdmin(app);
    await addUser(app, "u@example.com");
    const user = await signIn(app, "u@example.com");
    const r = new Router();
    r.get("/x", requireAdmin(app.deps, async (ctx) => json({ id: authOf(ctx).user.id })));
    r.get("/y", requireSession(app.deps, async (ctx) => json({ email: authOf(ctx).user.email })));
    const go = (path: string, cookie: string) => r.handle(new Request(`http://localhost${path}`, { headers: { cookie } }), { basePath: "", clientIp: undefined });
    expect((await go("/x", admin.cookie)).status).toBe(200);
    expect((await go("/x", user.cookie)).status).toBe(403);
    expect(await (await go("/y", user.cookie)).json()).toEqual({ email: "u@example.com" });
  });
});

describe("sessions", () => {
  it("idle expiry after 7 days, sliding; absolute after 30 days", async () => {
    const app = testApp();
    await addUser(app, "u@example.com");
    const c = await signIn(app, "u@example.com");
    for (let i = 0; i < 4; i++) {
      app.tick(6 * 24 * 3600_000);
      expect((await c.call("GET", "/api/me")).status).toBe(200);
    }
    app.tick(6 * 24 * 3600_000); // 30 days total
    expect((await c.call("GET", "/api/me")).status).toBe(401);
    const d = await signIn(app, "u@example.com");
    app.tick(7 * 24 * 3600_000);
    expect((await d.call("GET", "/api/me")).status).toBe(401);
  });

  it("stores only the hash of the cookie", async () => {
    const app = testApp();
    const c = await setupAdmin(app);
    const raw = c.cookie.split("=")[1] as string;
    const rows = await app.deps.storage.db.all<{ id_hash: string }>("SELECT id_hash FROM sessions");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id_hash).not.toBe(raw);
  });

  it("lists own sessions, revokes one by public id, revokes others", async () => {
    const app = testApp();
    await addUser(app, "u@example.com");
    await addUser(app, "v@example.com");
    const a = await signIn(app, "u@example.com");
    const b = await signIn(app, "u@example.com");
    await signIn(app, "u@example.com");
    const other = await signIn(app, "v@example.com");
    const items = ((await (await a.call("GET", "/api/me/sessions")).json()) as { items: { id: string; current: boolean }[] }).items;
    expect(items).toHaveLength(3);
    expect(items.filter((i) => i.current)).toHaveLength(1);
    const notCurrent = items.find((i) => !i.current) as { id: string };
    expect((await other.call("DELETE", `/api/me/sessions/${notCurrent.id}`)).status).toBe(404);
    expect((await a.call("DELETE", "/api/me/sessions/nothex")).status).toBe(404);
    expect((await a.call("DELETE", `/api/me/sessions/${notCurrent.id}`)).status).toBe(204);
    const res = await a.call("POST", "/api/me/sessions/revoke-others");
    expect(await res.json()).toEqual({ revoked: 1 });
    expect((await b.call("GET", "/api/me")).status).toBe(401);
    expect((await a.call("GET", "/api/me")).status).toBe(200);
    expect((await other.call("GET", "/api/me")).status).toBe(200);
  });

  it("password change: 401 wrong current, 422 short, revokes other sessions", async () => {
    const app = testApp();
    await addUser(app, "u@example.com");
    const a = await signIn(app, "u@example.com");
    const b = await signIn(app, "u@example.com");
    const wrong = await a.call("PUT", "/api/me/password", { current_password: "nope nope nope", new_password: "a brand new password" });
    expect(wrong.status).toBe(401);
    expect(await errCode(wrong)).toBe("invalid_credentials");
    const short = await a.call("PUT", "/api/me/password", { current_password: PW, new_password: "short" });
    expect(short.status).toBe(422);
    expect((await a.call("PUT", "/api/me/password", { current_password: PW, new_password: "a brand new password" })).status).toBe(204);
    expect((await b.call("GET", "/api/me")).status).toBe(401);
    expect((await a.call("GET", "/api/me")).status).toBe(200);
    expect((await loginAs(app, "u@example.com", "a brand new password")).status).toBe(200);
  });

  it("password change: repeated wrong current passwords are throttled (429)", async () => {
    const app = testApp();
    await addUser(app, "u@example.com");
    const a = await signIn(app, "u@example.com");
    const body = { current_password: "nope nope nope", new_password: "a brand new password" };
    for (let i = 0; i < 10; i++) expect((await a.call("PUT", "/api/me/password", body)).status).toBe(401);
    const blocked = await a.call("PUT", "/api/me/password", { current_password: PW, new_password: "a brand new password" });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });

  it("disabling a user ends their sessions", async () => {
    const app = testApp();
    await addUser(app, "u@example.com");
    const a = await signIn(app, "u@example.com");
    await app.deps.storage.db.run("UPDATE users SET disabled = 1");
    expect((await a.call("GET", "/api/me")).status).toBe(401);
  });
});

describe("TOTP", () => {
  it("RFC 6238 SHA-1 vectors (8 digits)", async () => {
    const secret = new TextEncoder().encode("12345678901234567890");
    for (const [t, want] of [[59, "94287082"], [1111111109, "07081804"], [1234567890, "89005924"], [2000000000, "69279037"]] as const) {
      expect(await hotp(secret, Math.floor(t / 30), 8)).toBe(want);
    }
  });

  it("enroll gives an otpauth URL; confirm needs a valid code and returns 10 codes", async () => {
    const app = testApp();
    const c = await setupAdmin(app);
    for (const body of [{}, { password: "wrong" }]) {
      const r = await c.call("POST", "/api/me/totp/enroll", body);
      expect(r.status).toBe(401);
      expect(await errCode(r)).toBe("invalid_credentials");
    }
    const e = (await (await c.call("POST", "/api/me/totp/enroll", { password: PW })).json()) as { otpauth_url: string };
    expect(e.otpauth_url).toMatch(/^otpauth:\/\/totp\/Runtime%20Web:admin@example\.com\?algorithm=SHA1&digits=6&issuer=Runtime\+Web&period=30&secret=[A-Z2-7]{32}$/);
    const bad = await c.call("POST", "/api/me/totp/confirm", { code: "000000" });
    expect(bad.status).toBe(422);
    expect(await errCode(bad)).toBe("invalid_code");
    const ok = await c.call("POST", "/api/me/totp/confirm", { code: await codeFor(app, e.otpauth_url) });
    const codes = ((await ok.json()) as { recovery_codes: string[] }).recovery_codes;
    expect(codes).toHaveLength(10);
    expect(codes[0]).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/);
    expect(await errCode(await c.call("POST", "/api/me/totp/enroll", { password: PW }))).toBe("totp_already_enabled");
    expect(await errCode(await c.call("POST", "/api/me/totp/confirm", { code: "123456" }))).toBe("totp_already_enabled");
    const rows = await app.deps.storage.db.all<{ code_hash: string }>("SELECT code_hash FROM recovery_codes");
    expect(rows.map((r) => r.code_hash)).not.toContain(codes[0]);
  });

  it("TOTP secret is bound to its user; a legacy no-AAD secret still verifies and is resealed", async () => {
    const app = testApp();
    const c = await setupAdmin(app);
    const { url } = await enableTotp(app, c);
    const db = app.deps.storage.db;
    const { sealerOf } = await import("../../src/auth/types.ts");
    const sealer = await sealerOf(app.deps);
    const secret = base32Decode(new URL(url).searchParams.get("secret") as string);
    const legacy = await sealer.seal(secret);
    await db.run("UPDATE user_totp SET secret_sealed = ?", [legacy]);
    const res = await loginAs(app, "admin@example.com");
    const done = await post(app, "/api/auth/mfa", { code: await codeFor(app, url) }, { cookie: cookieOf(res) });
    expect(done.status).toBe(200);
    const row = await db.first<{ s: Uint8Array; u: string }>("SELECT secret_sealed AS s, user_id AS u FROM user_totp");
    const now = new Uint8Array(row?.s as Uint8Array);
    await expect(sealer.open(now)).rejects.toThrow();
    expect(await sealer.open(now, `user_totp.secret:${row?.u}`)).toEqual(secret);
  });

  it("login with TOTP: pending cookie only works at /api/auth/mfa", async () => {
    const app = testApp();
    const c = await setupAdmin(app);
    const { url } = await enableTotp(app, c);
    const res = await loginAs(app, "admin@example.com");
    expect(await res.json()).toEqual({ mfa_required: true });
    const pending = cookieOf(res);
    const p = client(app, pending, "");
    expect((await p.call("GET", "/api/me/sessions")).status).toBe(401);
    expect((await p.call("GET", "/api/me")).status).toBe(401);
    const wrong = await post(app, "/api/auth/mfa", { code: "000000" }, { cookie: pending });
    expect(wrong.status).toBe(401);
    expect(await errCode(wrong)).toBe("invalid_code");
    const done = await post(app, "/api/auth/mfa", { code: await codeFor(app, url) }, { cookie: pending });
    expect(done.status).toBe(200);
    const body = (await done.json()) as { csrf: string; user: { totp_enabled: boolean } };
    expect(body.user.totp_enabled).toBe(true);
    const full = client(app, cookieOf(done), body.csrf);
    expect((await full.call("GET", "/api/me/sessions")).status).toBe(200);
    // the pending cookie is gone
    expect((await post(app, "/api/auth/mfa", { code: "000000" }, { cookie: pending })).status).toBe(401);
    const logins = ((await (await full.call("GET", "/api/me/logins")).json()) as { items: { result: string }[] }).items.map((i) => i.result);
    expect(logins.slice(0, 3)).toEqual(["ok", "bad_totp", "mfa_pending"]);
  });

  it("pending session expires after 5 minutes", async () => {
    const app = testApp();
    const c = await setupAdmin(app);
    const { url } = await enableTotp(app, c);
    const pending = cookieOf(await loginAs(app, "admin@example.com"));
    app.tick(5 * 60_000);
    const res = await post(app, "/api/auth/mfa", { code: await codeFor(app, url) }, { cookie: pending });
    expect(res.status).toBe(401);
    expect(await errCode(res)).toBe("unauthenticated");
  });

  it("rejects replayed codes and accepts +-1 step only", async () => {
    const app = testApp();
    const c = await setupAdmin(app);
    const { url } = await enableTotp(app, c);
    const code = await codeFor(app, url);
    const p1 = cookieOf(await loginAs(app, "admin@example.com"));
    expect((await post(app, "/api/auth/mfa", { code }, { cookie: p1 })).status).toBe(200);
    const p2 = cookieOf(await loginAs(app, "admin@example.com"));
    expect((await post(app, "/api/auth/mfa", { code }, { cookie: p2 })).status).toBe(401);
    expect((await post(app, "/api/auth/mfa", { code: await codeFor(app, url, 2) }, { cookie: p2 })).status).toBe(401);
    expect((await post(app, "/api/auth/mfa", { code: await codeFor(app, url, 1) }, { cookie: p2 })).status).toBe(200);
  });

  it("recovery codes work once, dashes and case ignored", async () => {
    const app = testApp();
    const c = await setupAdmin(app);
    const { codes } = await enableTotp(app, c);
    const rc = (codes[0] as string).toUpperCase().replaceAll("-", " ");
    const p1 = cookieOf(await loginAs(app, "admin@example.com"));
    expect((await post(app, "/api/auth/mfa", { code: rc }, { cookie: p1 })).status).toBe(200);
    const p2 = cookieOf(await loginAs(app, "admin@example.com"));
    expect((await post(app, "/api/auth/mfa", { code: codes[0] }, { cookie: p2 })).status).toBe(401);
  });

  it("5 second-factor failures give 429 with a progressive backoff, not a hard block", async () => {
    const app = testApp();
    const c = await setupAdmin(app);
    const { url } = await enableTotp(app, c);
    const p = cookieOf(await loginAs(app, "admin@example.com"));
    for (let i = 0; i < 5; i++) expect((await post(app, "/api/auth/mfa", { code: "000000" }, { cookie: p })).status).toBe(401);
    const res = await post(app, "/api/auth/mfa", { code: await codeFor(app, url) }, { cookie: p });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    // The wait doubles with each further failure, capped at 15 min.
    app.tick(30_000);
    expect((await post(app, "/api/auth/mfa", { code: "000000" }, { cookie: p })).status).toBe(401);
    expect((await post(app, "/api/auth/mfa", { code: "000000" }, { cookie: p })).headers.get("retry-after")).toBe("60");
    app.tick(60_000);
    const ok = await post(app, "/api/auth/mfa", { code: await codeFor(app, url) }, { cookie: p });
    expect(ok.status).toBe(200);
  });

  it("disable needs password and code, revokes other sessions", async () => {
    const app = testApp();
    const c = await setupAdmin(app);
    const { url } = await enableTotp(app, c);
    const pend = cookieOf(await loginAs(app, "admin@example.com"));
    const done = await post(app, "/api/auth/mfa", { code: await codeFor(app, url) }, { cookie: pend });
    const other = client(app, cookieOf(done), ((await done.json()) as { csrf: string }).csrf);
    app.tick(30_000);
    expect(await errCode(await c.call("POST", "/api/me/totp/disable", { password: "wrong password!", code: await codeFor(app, url) }))).toBe("invalid_credentials");
    expect(await errCode(await c.call("POST", "/api/me/totp/disable", { password: PW, code: "000000" }))).toBe("invalid_code");
    expect((await c.call("POST", "/api/me/totp/disable", { password: PW, code: await codeFor(app, url) })).status).toBe(204);
    expect((await other.call("GET", "/api/me")).status).toBe(401);
    expect(await errCode(await c.call("POST", "/api/me/totp/disable", { password: PW, code: "000000" }))).toBe("totp_not_enabled");
    expect((await loginAs(app, "admin@example.com").then((r) => r.json()) as { mfa_required: boolean }).mfa_required).toBe(false);
  });

  it("recovery-codes regenerate needs password and TOTP; old codes stop working", async () => {
    const app = testApp();
    const c = await setupAdmin(app);
    expect(await errCode(await c.call("POST", "/api/me/recovery-codes", { password: PW }))).toBe("totp_not_enabled");
    const { codes } = await enableTotp(app, c);
    expect(await errCode(await c.call("POST", "/api/me/recovery-codes", { password: "wrong password!" }))).toBe("invalid_credentials");
    const res = await c.call("POST", "/api/me/recovery-codes", { password: PW });
    const fresh = ((await res.json()) as { recovery_codes: string[] }).recovery_codes;
    expect(fresh).toHaveLength(10);
    const p = cookieOf(await loginAs(app, "admin@example.com"));
    expect((await post(app, "/api/auth/mfa", { code: codes[0] }, { cookie: p })).status).toBe(401);
    expect((await post(app, "/api/auth/mfa", { code: fresh[0] }, { cookie: p })).status).toBe(200);
  });

  it("secret is sealed at rest", async () => {
    const app = testApp();
    const c = await setupAdmin(app);
    const { url } = await enableTotp(app, c);
    const secret = base32Decode(new URL(url).searchParams.get("secret") as string);
    const row = await app.deps.storage.db.first<{ secret_sealed: Uint8Array }>("SELECT secret_sealed FROM user_totp");
    expect(Buffer.from(row?.secret_sealed as Uint8Array).includes(Buffer.from(secret))).toBe(false);
  });
});
