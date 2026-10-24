import { describe, expect, it } from "vitest";
import { revokeBackoff, scheduled } from "../src/jobs.ts";
import { ensureMigrated } from "../src/db/migrate.ts";
import { testApp } from "./harness.ts";
import { hostsCtl } from "./domains/fakes.ts";

async function setup() {
  const rt = hostsCtl();
  const app = testApp({ rtctl: rt });
  await ensureMigrated(app.deps.storage.db);
  return { app, db: app.deps.storage.db, rt };
}

describe("scheduled()", () => {
  it("expires sessions past expires_at and unaccepted invites past expires_at only", async () => {
    const { app, db } = await setup();
    const now = app.deps.now();
    await db.run("INSERT INTO users (id, email, name, pw_hash, must_change, instance_admin, disabled, created_at, updated_at) VALUES ('usr_1', 'u@x.test', 'U', 'h', 0, 0, 0, 0, 0)");
    await db.run("INSERT INTO sessions (id_hash, user_id, csrf, mfa_pending, created_at, last_seen_at, expires_at) VALUES ('old', 'usr_1', 'c', 0, 0, 0, ?)", [now - 1]);
    await db.run("INSERT INTO sessions (id_hash, user_id, csrf, mfa_pending, created_at, last_seen_at, expires_at) VALUES ('new', 'usr_1', 'c', 0, 0, 0, ?)", [now + 1000]);
    await db.run("INSERT INTO invites (id, token_hash, email, created_by, created_at, expires_at, accepted_at) VALUES ('i1', 'h1', 'a@x.test', 'usr_1', 0, ?, NULL)", [now - 1]);
    await db.run("INSERT INTO invites (id, token_hash, email, created_by, created_at, expires_at, accepted_at) VALUES ('i2', 'h2', 'b@x.test', 'usr_1', 0, ?, ?)", [now - 1, now - 5]);
    await db.run("INSERT INTO invites (id, token_hash, email, created_by, created_at, expires_at, accepted_at) VALUES ('i3', 'h3', 'c@x.test', 'usr_1', 0, ?, NULL)", [now + 1000]);
    await scheduled(app.deps);
    expect((await db.all<{ id_hash: string }>("SELECT id_hash FROM sessions")).map((r) => r.id_hash)).toEqual(["new"]);
    expect((await db.all<{ id: string }>("SELECT id FROM invites ORDER BY id")).map((r) => r.id)).toEqual(["i2", "i3"]);
  });

  it("retries a failed key revoke with backoff and clears it once the runtime answers", async () => {
    const { app, db, rt } = await setup();
    await db.run("INSERT INTO pending_key_revokes (runtime_key_id, tenant_id, attempts, next_at) VALUES ('key_1', 't_1', 0, ?)", [app.deps.now()]);
    rt.failNext(503, "DELETE");
    await scheduled(app.deps);
    const row = await db.first<{ attempts: number; next_at: number }>("SELECT attempts, next_at FROM pending_key_revokes");
    expect(row).toMatchObject({ attempts: 1, next_at: app.deps.now() + revokeBackoff(1) });

    // Not due yet: nothing sent.
    const before = rt.calls.length;
    await scheduled(app.deps);
    expect(rt.calls.slice(before).some((c) => c.path.endsWith("/keys/key_1"))).toBe(false);

    app.tick(revokeBackoff(1));
    await scheduled(app.deps);
    expect(await db.all("SELECT runtime_key_id FROM pending_key_revokes")).toHaveLength(0);
  });

  it("backs off exponentially, capped at one hour", () => {
    expect(revokeBackoff(0)).toBe(60_000);
    expect(revokeBackoff(1)).toBe(120_000);
    expect(revokeBackoff(30)).toBe(3_600_000);
  });
});
