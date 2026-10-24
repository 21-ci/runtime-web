import { describe, expect, it } from "vitest";
import { audit, listAudit } from "../../src/audit/audit.ts";
import { ensureMigrated } from "../../src/db/migrate.ts";
import { testApp } from "../harness.ts";

async function setup() {
  const app = testApp();
  await ensureMigrated(app.deps.storage.db);
  const db = app.deps.storage.db;
  await db.run("INSERT INTO users (id, email, name, pw_hash, must_change, instance_admin, disabled, created_at, updated_at) VALUES ('usr_a', 'a@x.test', 'Ann', 'h', 0, 0, 0, 0, 0)");
  await db.run("INSERT INTO orgs (id, slug, name, tenant_id, created_at) VALUES ('org_1', 'acme', 'Acme', 't_1', 0)");
  await db.run("INSERT INTO orgs (id, slug, name, tenant_id, created_at) VALUES ('org_2', 'beta', 'Beta', 't_2', 0)");
  return { app, db };
}

describe("audit writer", () => {
  it("stamps entries with the injected clock", async () => {
    const { app, db } = await setup();
    await audit(app.deps, { actor: { userId: "usr_a" }, orgId: "org_1", action: "app.create", target: "x" });
    const row = await db.first<{ ts: number }>("SELECT ts FROM audit");
    expect(row?.ts).toBe(app.deps.now());
  });

  it("writes action, target, JSON detail and actor", async () => {
    const { app, db } = await setup();
    await audit(app.deps, { actor: { userId: "usr_a" }, orgId: "org_1", action: "domain.add", target: "a.example.com", detail: { app: "shop" } });
    const page = await listAudit(db);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      action: "domain.add",
      target: "a.example.com",
      detail: { app: "shop" },
      as_instance_admin: false,
      actor: { user_id: "usr_a", name: "Ann", email: "a@x.test" },
      org: { id: "org_1", slug: "acme" },
    });
  });

  it("marks instance-admin actions and records system actions without an actor", async () => {
    const { app, db } = await setup();
    await audit(app.deps, { actor: { userId: "usr_a", asInstanceAdmin: true }, orgId: "org_2", action: "member.role" });
    await audit(app.deps, { actor: {}, orgId: null, action: "session.expire" });
    const page = await listAudit(db);
    const admin = page.items.find((e) => e.action === "member.role");
    const sys = page.items.find((e) => e.action === "session.expire");
    expect(admin?.as_instance_admin).toBe(true);
    expect(sys).toMatchObject({ org: null, actor: { user_id: null, name: null } });
  });
});

describe("audit listing", () => {
  async function seed(db: Awaited<ReturnType<typeof setup>>["db"], app: Awaited<ReturnType<typeof setup>>["app"]) {
    for (let i = 0; i < 5; i++) {
      app.tick(1);
      await audit(app.deps, { actor: { userId: "usr_a" }, orgId: "org_1", action: i % 2 ? "app.deploy" : "app.create", target: `t${i}` });
    }
    app.tick(1);
    await audit(app.deps, { actor: { userId: "usr_a" }, orgId: "org_2", action: "app.create", target: "other" });
  }

  it("filters by org, actor and action", async () => {
    const { app, db } = await setup();
    await seed(db, app);
    expect((await listAudit(db, { orgId: "org_1" })).items).toHaveLength(5);
    expect((await listAudit(db, { orgId: "org_1", action: "app.deploy" })).items).toHaveLength(2);
    expect((await listAudit(db, { actorId: "usr_nobody" })).items).toHaveLength(0);
    expect((await listAudit(db, {})).items).toHaveLength(6);
  });

  it("pages newest first without repeats", async () => {
    const { app, db } = await setup();
    await seed(db, app);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listAudit(db, { limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((e) => e.id));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });

  it("rejects a malformed cursor with 422", async () => {
    const { db } = await setup();
    await expect(listAudit(db, { cursor: "nope" })).rejects.toMatchObject({ status: 422, code: "invalid" });
  });
});
