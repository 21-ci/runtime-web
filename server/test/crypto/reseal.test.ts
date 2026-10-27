import { describe, expect, it } from "vitest";
import { getProvider, setProvider } from "../../src/auth/oauth.ts";
import { sealerOf } from "../../src/auth/types.ts";
import { base64url } from "../../src/crypto/random.ts";
import { RESEAL_DONE_KEY, resealLegacy } from "../../src/crypto/reseal.ts";
import { scheduled } from "../../src/jobs.ts";
import { addUser, testApp } from "../auth/helpers.ts";

const enc = (s: string) => new TextEncoder().encode(s);

describe("legacy reseal job", () => {
  it("reseals every no-AAD org key, TOTP secret and OAuth secret once, then skips", async () => {
    const app = testApp();
    const db = app.deps.storage.db;
    const s = await sealerOf(app.deps);
    const uid = await addUser(app, "u@example.com");
    await db.run(
      "INSERT INTO orgs (id, slug, name, tenant_id, default_key_id, default_key_sealed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["org_a", "a", "a", "t_a", "k_a", await s.seal(enc("legacy-key")), app.deps.now()],
    );
    await db.run(
      "INSERT INTO orgs (id, slug, name, tenant_id, default_key_id, default_key_sealed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["org_b", "b", "b", "t_b", "k_b", await s.seal(enc("bound-key"), "org.default_key:org_b"), app.deps.now()],
    );
    await db.run("INSERT INTO user_totp (user_id, secret_sealed, enabled_at, last_step) VALUES (?, ?, NULL, -1)", [uid, await s.seal(enc("totp"))]);
    await setProvider(app.deps, { id: "oidc", enabled: true, client_id: "cid", client_secret: "csecret", issuer: "https://idp.example.com", name: "Corp" });
    await db.run("UPDATE settings SET value = ? WHERE key = ?", [JSON.stringify(base64url(await s.seal(enc("csecret")))), "oauth.oidc.client_secret"]);

    const r = await resealLegacy(app.deps);
    expect(r).toEqual({ resealed: 3, failed: 0, skipped: false });

    const a = await db.first<{ k: Uint8Array }>("SELECT default_key_sealed AS k FROM orgs WHERE id = 'org_a'");
    await expect(s.open(new Uint8Array(a?.k as Uint8Array))).rejects.toThrow();
    expect(new TextDecoder().decode(await s.open(new Uint8Array(a?.k as Uint8Array), "org.default_key:org_a"))).toBe("legacy-key");
    const t = await db.first<{ v: Uint8Array }>("SELECT secret_sealed AS v FROM user_totp");
    expect(new TextDecoder().decode(await s.open(new Uint8Array(t?.v as Uint8Array), `user_totp.secret:${uid}`))).toBe("totp");
    expect((await getProvider(app.deps, "oidc"))?.clientSecret).toBe("csecret");
    const sec = await db.first<{ value: string }>("SELECT value FROM settings WHERE key = 'oauth.oidc.client_secret'");
    expect(sec?.value).not.toContain("=");

    expect(await db.first("SELECT 1 AS x FROM settings WHERE key = ?", [RESEAL_DONE_KEY])).toBeTruthy();
    expect(await resealLegacy(app.deps)).toEqual({ resealed: 0, failed: 0, skipped: true });
  });

  it("a blob that opens under no key is counted as failed and the pass is retried", async () => {
    const app = testApp();
    const db = app.deps.storage.db;
    await addUser(app, "u@example.com");
    await db.run(
      "INSERT INTO orgs (id, slug, name, tenant_id, default_key_id, default_key_sealed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["org_x", "x", "x", "t_x", "k_x", new Uint8Array(40), app.deps.now()],
    );
    expect(await resealLegacy(app.deps)).toMatchObject({ failed: 1, skipped: false });
    expect(await db.first("SELECT 1 AS x FROM settings WHERE key = ?", [RESEAL_DONE_KEY])).toBeFalsy();
  });

  it("runs as a scheduled() step", async () => {
    const app = testApp();
    await addUser(app, "u@example.com");
    await scheduled(app.deps);
    expect(await app.deps.storage.db.first("SELECT 1 AS x FROM settings WHERE key = ?", [RESEAL_DONE_KEY])).toBeTruthy();
  });
});
