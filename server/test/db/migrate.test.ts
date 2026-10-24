import { describe, expect, it } from "vitest";
import { LATEST_VERSION, migrate } from "../../src/db/migrate.ts";
import { memoryStorage } from "../harness.ts";
import { migrations } from "../../src/db/schema.ts";

const tables = async (db: ReturnType<typeof memoryStorage>["db"]) =>
  (await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")).map((r) => r.name);

const insertUser = (id: string, email: string) =>
  [
    "INSERT INTO users (id, email, name, pw_hash, must_change, instance_admin, disabled, created_at, updated_at) VALUES (?,?,?,?,0,0,0,1,1)",
    [id, email, "n", "h"] as const,
  ] as const;

describe("migrations (0001 schema)", () => {
  it("creates every §6 table and records the version", async () => {
    const { db } = memoryStorage();
    expect(await migrate(db)).toBe(LATEST_VERSION);
    expect(await tables(db)).toEqual(
      expect.arrayContaining([
        "audit",
        "domains",
        "identities",
        "invites",
        "login_events",
        "members",
        "orgs",
        "pending_key_revokes",
        "project_grants",
        "recovery_codes",
        "schema_version",
        "sessions",
        "settings",
        "tokens",
        "user_totp",
        "users",
        "version_authors",
      ]),
    );
  });

  it("is idempotent: rerunning the DDL on an already-migrated db is a no-op", async () => {
    const { db } = memoryStorage();
    await migrate(db);
    expect(await migrate(db)).toBe(LATEST_VERSION);
    const rows = await db.all<{ v: number }>("SELECT v FROM schema_version");
    expect(rows.map((r) => r.v)).toEqual(migrations.map((m) => m.version));
  });

  it("keeps existing rows across a rerun", async () => {
    const { db } = memoryStorage();
    await migrate(db);
    const [sql, args] = insertUser("usr_1", "a@x.io");
    await db.run(sql, [...args]);
    await migrate(db);
    expect(await db.first("SELECT id FROM users")).toEqual({ id: "usr_1" });
  });

  it("enforces users.email uniqueness case-insensitively", async () => {
    const { db } = memoryStorage();
    await migrate(db);
    const [sql, args] = insertUser("usr_1", "A@x.io");
    await db.run(sql, [...args]);
    const [sql2, args2] = insertUser("usr_2", "a@X.io");
    await expect(db.run(sql2, [...args2])).rejects.toThrow(/UNIQUE/);
  });

  it("stores sealed secrets as blobs", async () => {
    const { db } = memoryStorage();
    await migrate(db);
    const [sql, args] = insertUser("usr_1", "a@x.io");
    await db.run(sql, [...args]);
    await db.run("INSERT INTO user_totp (user_id, secret_sealed, enabled_at) VALUES ('usr_1', ?, NULL)", [
      new Uint8Array([1, 2, 3]),
    ]);
    const row = await db.first<{ secret_sealed: Uint8Array }>("SELECT secret_sealed FROM user_totp");
    expect(Array.from(row?.secret_sealed ?? [])).toEqual([1, 2, 3]);
  });
});
