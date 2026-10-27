import { describe, expect, it } from "vitest";
import { addUser, errCode, loginAs, PW, testApp } from "./helpers.ts";
import { fastHasher } from "../harness.ts";
import type { Hasher } from "../../src/auth/password.ts";
import {
  ACCOUNT_SOFT_LIMIT, ACCOUNT_WIDE_SOFT_LIMIT, GLOBAL_LOGINS_PER_MINUTE, IP_FAILURE_LIMIT, MAX_INFLIGHT_HASHES, mfaDelaySeconds, netPrefix,
} from "../../src/auth/ratelimit.ts";

const until = async (f: () => boolean) => {
  for (let i = 0; i < 500 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
};
const ip = (n: number | string) => ({ "x-rt-client-ip": typeof n === "string" ? n : `198.51.100.${n}` });

describe("login throttling (H2)", () => {
  it("keys on the runtime client address, never on X-Forwarded-For", async () => {
    const app = testApp();
    await addUser(app, "u@example.com");
    for (let i = 0; i < 10; i++) {
      const h = { ...ip(9), "x-forwarded-for": `203.0.113.${i}` };
      expect((await loginAs(app, "u@example.com", "wrong password!!", h)).status).toBe(401);
    }
    expect((await loginAs(app, "u@example.com", PW, { ...ip(9), "x-forwarded-for": "203.0.113.200" })).status).toBe(429);
  });

  it("the runtime-provided address wins over a header", async () => {
    const app = testApp();
    await addUser(app, "u@example.com");
    const req = (pw: string) =>
      app.fetch(
        new Request("http://localhost/api/auth/login", {
          method: "POST",
          headers: { origin: "https://console.test", "content-type": "application/json", "x-rt-client-ip": "10.9.9.9" },
          body: JSON.stringify({ email: "u@example.com", password: pw }),
        }),
        { clientIp: "203.0.113.77" },
      );
    for (let i = 0; i < 10; i++) expect((await req("wrong password!!")).status).toBe(401);
    expect((await req(PW)).status).toBe(429);
    expect((await loginAs(app, "u@example.com", PW, ip("10.9.9.9"))).status).toBe(200);
  });

  it("limits failures per IP across emails", async () => {
    const app = testApp();
    await addUser(app, "u@example.com");
    for (let i = 0; i < IP_FAILURE_LIMIT; i++) await loginAs(app, `x${i}@example.com`, "wrong password!!", ip(1));
    const res = await loginAs(app, "u@example.com", PW, ip(1));
    expect(res.status).toBe(429);
    expect(await errCode(res)).toBe("rate_limited");
    expect((await loginAs(app, "u@example.com", PW, ip(2))).status).toBe(200);
  });

  it("strangers spraying one account cannot lock out a known IP", async () => {
    const app = testApp();
    await addUser(app, "admin@example.com", { admin: true });
    expect((await loginAs(app, "admin@example.com", PW, ip(50))).status).toBe(200);
    for (let i = 0; i < ACCOUNT_SOFT_LIMIT * 3; i++) await loginAs(app, "admin@example.com", "wrong password!!", ip(100 + i));
    expect((await loginAs(app, "admin@example.com", PW, ip(50))).status).toBe(200);
  });

  it("an unknown IP gets a progressive delay on a sprayed account, not a hard lock", async () => {
    const app = testApp();
    await addUser(app, "admin@example.com", { admin: true });
    for (let i = 0; i < ACCOUNT_SOFT_LIMIT + 3; i++) await loginAs(app, "admin@example.com", "wrong password!!", ip(100 + i));
    const res = await loginAs(app, "admin@example.com", PW, ip(7));
    expect(res.status).toBe(429);
    const retry = Number(res.headers.get("retry-after"));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60);
    app.tick(retry * 1000);
    expect((await loginAs(app, "admin@example.com", PW, ip(7))).status).toBe(200);
  });

  it("spraying from one network delays only that network until the account-wide limit", async () => {
    const app = testApp();
    await addUser(app, "admin@example.com", { admin: true });
    for (let i = 0; i < ACCOUNT_SOFT_LIMIT + 3; i++) await loginAs(app, "admin@example.com", "wrong password!!", ip(100 + i));
    expect((await loginAs(app, "admin@example.com", PW, ip(7))).status).toBe(429);
    expect((await loginAs(app, "admin@example.com", PW, ip("203.0.113.7"))).status).toBe(200);

    const other = testApp();
    await addUser(other, "admin@example.com", { admin: true });
    for (let i = 0; i < ACCOUNT_WIDE_SOFT_LIMIT + 1; i++) await loginAs(other, "admin@example.com", "wrong password!!", ip(`192.0.${i}.1`));
    expect((await loginAs(other, "admin@example.com", PW, ip("203.0.113.7"))).status).toBe(429);
  });

  it("netPrefix groups IPv4 by /24 and IPv6 by /64; MFA delay doubles to 15 min", () => {
    expect(netPrefix("198.51.100.23")).toBe("198.51.100.0/24");
    expect(netPrefix("::ffff:198.51.100.23")).toBe("198.51.100.0/24");
    expect(netPrefix("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(netPrefix("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(netPrefix("[2001:DB8:0:0::9]")).toBe("2001:db8:0:0::/64");
    expect([4, 5, 6, 10, 20].map(mfaDelaySeconds)).toEqual([0, 30, 60, 900, 900]);
  });

  it("caps unauthenticated login attempts globally per minute", async () => {
    const app = testApp();
    await addUser(app, "u@example.com");
    for (let i = 0; i < GLOBAL_LOGINS_PER_MINUTE; i++) await loginAs(app, `g${i}@example.com`, "wrong password!!", ip(`2001:db8::${i.toString(16)}`));
    const res = await loginAs(app, "u@example.com", PW, ip(3));
    expect(res.status).toBe(429);
    app.tick(60_000);
    expect((await loginAs(app, "u@example.com", PW, ip(3))).status).toBe(200);
  });
});

describe("argon2 concurrency (M6)", () => {
  it("rejects hashing beyond the in-flight cap with 503 busy", async () => {
    const release: (() => void)[] = [];
    const slow: Hasher = {
      hash: fastHasher.hash,
      verify: (phc, pw) => new Promise((r) => release.push(() => void fastHasher.verify(phc, pw).then(r))),
    };
    const app = testApp({ hasher: slow });
    await addUser(app, "u@example.com");
    const pending = Array.from({ length: MAX_INFLIGHT_HASHES }, (_, i) => loginAs(app, "u@example.com", PW, ip(20 + i)));
    await until(() => release.length === MAX_INFLIGHT_HASHES);
    const over = await loginAs(app, "u@example.com", PW, ip(40));
    expect(over.status).toBe(503);
    expect(await errCode(over)).toBe("busy");
    expect(over.headers.get("retry-after")).toBe("1");
    release.forEach((f) => f());
    for (const p of await Promise.all(pending)) expect(p.status).toBe(200);
    const again = loginAs(app, "u@example.com", PW, ip(41));
    await until(() => release.length === MAX_INFLIGHT_HASHES + 1);
    release[MAX_INFLIGHT_HASHES]?.();
    expect((await again).status).toBe(200);
  });

  it("rehashes legacy 64 MiB hashes at login with the new parameters", async () => {
    const seen: string[] = [];
    const h: Hasher = {
      hash: async (p) => {
        const out = await fastHasher.hash(p);
        seen.push(out);
        return out;
      },
      verify: fastHasher.verify,
      needsRehash: (phc) => !seen.includes(phc),
    };
    const app = testApp({ hasher: h });
    await addUser(app, "u@example.com");
    const before = await app.deps.storage.db.first<{ pw_hash: string }>("SELECT pw_hash FROM users");
    seen.length = 0;
    expect((await loginAs(app, "u@example.com", PW)).status).toBe(200);
    const after = await app.deps.storage.db.first<{ pw_hash: string }>("SELECT pw_hash FROM users");
    expect(after?.pw_hash).not.toBe(before?.pw_hash);
    expect(seen).toEqual([after?.pw_hash]);
    expect((await loginAs(app, "u@example.com", PW)).status).toBe(200);
    expect(seen.length).toBe(1);
  });
});
