import { describe, expect, it } from "vitest";
import { errCode, addUser, signIn } from "./auth/helpers.ts";
import { testApp, TEST_ORIGIN } from "./harness.ts";
import { ensureMigrated } from "../src/db/migrate.ts";

async function adminClient() {
  const app = testApp();
  await ensureMigrated(app.deps.storage.db);
  await addUser(app, "root@x.test", { admin: true });
  await addUser(app, "plain@x.test");
  return { app, admin: await signIn(app, "root@x.test"), plain: await signIn(app, "plain@x.test") };
}

describe("/api/admin/settings", () => {
  it("is instance-admin only", async () => {
    const { admin, plain } = await adminClient();
    expect((await plain.call("GET", "/api/admin/settings")).status).toBe(403);
    expect((await admin.call("GET", "/api/admin/settings")).status).toBe(200);
  });

  it("returns the policy with the public URL and no secrets", async () => {
    const { admin } = await adminClient();
    const body = (await (await admin.call("GET", "/api/admin/settings")).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ public_url: TEST_ORIGIN, require_2fa: false, password_login_disabled: false });
    expect(body.providers).toEqual([
      { id: "github", enabled: false, client_id: "", client_secret_set: false },
      { id: "google", enabled: false, client_id: "", client_secret_set: false },
      { id: "oidc", enabled: false, client_id: "", client_secret_set: false },
    ]);
  });

  it("stores the policy and audits the change", async () => {
    const { app, admin } = await adminClient();
    const res = await admin.call("PUT", "/api/admin/settings", { require_2fa: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ require_2fa: true });
    const row = await app.deps.storage.db.first<{ as_instance_admin: number }>("SELECT as_instance_admin FROM audit WHERE action = 'settings.update'");
    expect(row?.as_instance_admin).toBe(1);
  });

  it("refuses password-login-disabled without a configured SSO provider (422)", async () => {
    const { admin } = await adminClient();
    const res = await admin.call("PUT", "/api/admin/settings", { password_login_disabled: true });
    expect(res.status).toBe(422);
    expect(await errCode(res)).toBe("invalid");
  });

  it("stores a provider secret sealed and never returns it", async () => {
    const { admin } = await adminClient();
    const res = await admin.call("PUT", "/api/admin/settings", {
      providers: [{ id: "github", enabled: true, client_id: "cid", client_secret: "shh-secret" }],
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("shh-secret");
    expect(JSON.parse(text).providers[0]).toMatchObject({ id: "github", enabled: true, client_id: "cid", client_secret_set: true });
    const pw = await admin.call("PUT", "/api/admin/settings", { password_login_disabled: true });
    expect(pw.status).toBe(200);
  });

  it("rejects a malformed body with 422 fields", async () => {
    const { admin } = await adminClient();
    const res = await admin.call("PUT", "/api/admin/settings", { require_2fa: "yes" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: "invalid", details: { fields: { require_2fa: expect.any(String) } } } });
  });
});
