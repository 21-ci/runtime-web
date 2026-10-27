// Node-wide App index: slug -> (org, service). Slugs are unique on the node, so tls-ask answers
// "is <slug>.<apps domain> an App?" with one SELECT instead of a runtime call per org.
//
// Writers: createApp calls appIndexPut after the service exists, deleteApp calls appIndexDelete after the service is
// gone. Apps created before the table existed are filled in by appIndexBackfill (the scheduled job), a few orgs per
// run. The table is created on first use (CREATE ... IF NOT EXISTS), so it needs no numbered migration slot.

import type { Deps } from "../app.ts";
import { dbOf } from "../auth/types.ts";
import { getOrg } from "../orgs/orgs.ts";
import { rt } from "../runtime/errors.ts";
import type { Db } from "../storage/types.ts";
import { isSlug } from "./slug.ts";

export const APP_INDEX_DDL = [
  `CREATE TABLE IF NOT EXISTS app_index (
    slug TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    service_id TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS app_index_org ON app_index (org_id)`,
  // Orgs whose Apps were listed into app_index by appIndexBackfill.
  `CREATE TABLE IF NOT EXISTS app_index_orgs (org_id TEXT PRIMARY KEY, indexed_at INTEGER NOT NULL)`,
] as const;

const ready = new WeakSet<Db>();

async function ensure(db: Db): Promise<void> {
  if (ready.has(db)) return;
  await db.batch(APP_INDEX_DDL.map((sql) => ({ sql })));
  ready.add(db);
}

export interface AppIndexEntry {
  orgId: string;
  slug: string;
  serviceId: string;
}

/** Records (or replaces) the App with this slug. Call after the runtime service exists. */
export async function appIndexPut(db: Db, e: AppIndexEntry): Promise<void> {
  await ensure(db);
  await db.run(
    "INSERT INTO app_index (slug, org_id, service_id) VALUES (?, ?, ?) ON CONFLICT(slug) DO UPDATE SET org_id = excluded.org_id, service_id = excluded.service_id",
    [e.slug, e.orgId, e.serviceId],
  );
}

/** Forgets the App with this slug. Call after the runtime service is deleted. */
export async function appIndexDelete(db: Db, slug: string): Promise<void> {
  await ensure(db);
  await db.run("DELETE FROM app_index WHERE slug = ?", [slug]);
}

/** Forgets every App of an org (org deletion). */
export async function appIndexDeleteOrg(db: Db, orgId: string): Promise<void> {
  await ensure(db);
  await db.run("DELETE FROM app_index WHERE org_id = ?", [orgId]);
  await db.run("DELETE FROM app_index_orgs WHERE org_id = ?", [orgId]);
}

/** The App with this slug in a live org, or null. One query, no runtime call. */
export async function appIndexGet(db: Db, slug: string): Promise<AppIndexEntry | null> {
  if (!isSlug(slug)) return null;
  await ensure(db);
  const row = await db.first<{ org_id: string; service_id: string }>(
    "SELECT a.org_id, a.service_id FROM app_index a JOIN orgs o ON o.id = a.org_id WHERE a.slug = ? AND o.deleted_at IS NULL",
    [slug],
  );
  return row ? { orgId: row.org_id, slug, serviceId: row.service_id } : null;
}

/**
 * Lists the Apps of up to `maxOrgs` orgs not indexed yet into app_index (one runtime call per page per org), so
 * Apps created before the index existed get certificates too. Returns the number of orgs indexed.
 */
export async function appIndexBackfill(deps: Pick<Deps, "storage" | "now" | "config" | "rtctl">, maxOrgs = 10): Promise<number> {
  if (!deps.rtctl) return 0;
  const db = await dbOf(deps as Deps);
  await ensure(db);
  const todo = await db.all<{ id: string }>(
    "SELECT id FROM orgs WHERE deleted_at IS NULL AND id NOT IN (SELECT org_id FROM app_index_orgs) ORDER BY created_at LIMIT ?",
    [maxOrgs],
  );
  // Imported lazily: service.ts imports this module (createApp / deleteApp).
  const { orgClient } = await import("./service.ts");
  let n = 0;
  for (const { id } of todo) {
    const org = await getOrg(db, id);
    if (!org) continue;
    const cli = await orgClient(deps as Deps, org);
    let cursor: string | undefined;
    do {
      const page = await rt(() => cli.listServices(cursor ? { cursor } : {}));
      for (const s of page.items) {
        if (isSlug(s.slug)) await appIndexPut(db, { orgId: id, slug: s.slug, serviceId: s.id });
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    await db.run("INSERT OR REPLACE INTO app_index_orgs (org_id, indexed_at) VALUES (?, ?)", [id, deps.now()]);
    n++;
  }
  return n;
}
