// Applies pending migrations to a Db (src/storage/types.ts). Works on both adapters:
// the runtime's std:sql (via sql.batch = one write transaction) and node:sqlite in tests.
//
// Idempotent and safe under concurrent first requests: DDL is IF NOT EXISTS, the
// version row is INSERT OR IGNORE, and each migration's statements plus its version
// row run in one batch, so a version is recorded only if its DDL committed.

import type { Db } from "../storage/types.ts";
import { LATEST_SCHEMA_VERSION, migrations } from "./schema.ts";

export const LATEST_VERSION = LATEST_SCHEMA_VERSION;

/** Brings the database to the latest version. Returns the version now recorded. */
export async function migrate(db: Db): Promise<number> {
  // schema_version must exist before we can read it; migration 1 creates it too.
  await db.batch([{ sql: "CREATE TABLE IF NOT EXISTS schema_version (v INTEGER PRIMARY KEY)" }]);
  let current = await currentVersion(db);
  for (const m of migrations) {
    if (m.version <= current) continue;
    await db.batch([
      ...m.statements.map((sql) => ({ sql })),
      { sql: "INSERT OR IGNORE INTO schema_version (v) VALUES (?)", args: [m.version] },
    ]);
    current = await currentVersion(db);
  }
  return current;
}

const migrated = new WeakMap<Db, Promise<number>>();

/**
 * Migrates once per Db handle per isolate and returns the cached promise after that.
 * Request code calls this before its first query; a failed run is evicted so the
 * next request retries.
 */
export function ensureMigrated(db: Db): Promise<number> {
  let p = migrated.get(db);
  if (!p) {
    p = migrate(db).catch((err: unknown) => {
      migrated.delete(db);
      throw err;
    });
    migrated.set(db, p);
  }
  return p;
}

async function currentVersion(db: Db): Promise<number> {
  const row = await db.first<{ v: number | bigint | null }>("SELECT MAX(v) AS v FROM schema_version");
  return Number(row?.v ?? 0);
}
