// The read-only data browser. Rows may be personal, so: project admins only, never an instance admin on that
// title alone, and every read is audited with who and what, never values or args. The runtime enforces read-only;
// the console holds no SQL rules of its own beyond shape checks.
//
// These reads use a key holding only data:read, kept apart from the default key: that one acts on behalf of every
// other console route, and a bug in any of them must not become a path to row contents.

import { audit } from "../audit/audit.ts";
import { dbOf, sealerOf } from "../auth/types.ts";
import { can, type Subject } from "../authz/policy.ts";
import { sha256Hex } from "../crypto/hash.ts";
import { AppError, forbidden, invalid, notFound } from "../http/errors.ts";
import { DATA_KEY_NAME } from "../keys/keys.ts";
import { authorize } from "../orgs/members.ts";
import { Runtime, type Scoped } from "../runtime/client.ts";
import { rt } from "../runtime/errors.ts";
import type { Deps } from "../app.ts";
import { resolve, type OrgCtx } from "./service.ts";

const MAX_SQL = 16 << 10;
const MAX_ARGS = 64;
const KEY_B64_RE = /^[A-Za-z0-9_-]{1,1024}={0,2}$/;
const ACTION = "app.data.read";

const dataKeyContext = (orgId: string) => `org.data_key:${orgId}`;

async function dataClient(c: OrgCtx): Promise<Scoped> {
  const { deps, org } = c;
  const unavailable = () => new AppError(502, "runtime_unavailable", "runtime unavailable");
  if (!deps.rtctl) throw unavailable();
  const db = await dbOf(deps);
  const sealer = await sealerOf(deps);
  const row = await db.first<{ data_key_sealed: Uint8Array | null }>("SELECT data_key_sealed FROM orgs WHERE id = ?", [org.id]);
  const runtime = new Runtime(deps.rtctl);
  if (row?.data_key_sealed) {
    const plain = await sealer.open(new Uint8Array(row.data_key_sealed), dataKeyContext(org.id));
    return runtime.as(new TextDecoder().decode(plain));
  }
  const key = await rt(() => runtime.op().createTenantKey(org.tenantId, { name: DATA_KEY_NAME, scopes: ["data:read"] }));
  const sealed = await sealer.seal(new TextEncoder().encode(key.secret), dataKeyContext(org.id));
  const out = await db.run("UPDATE orgs SET data_key_id = ?, data_key_sealed = ? WHERE id = ? AND data_key_sealed IS NULL", [key.id, sealed, org.id]);
  if (out.changes === 0) {
    // Lost a race: keep the winner's key and queue this one for the job that retries revokes.
    await db.run("INSERT OR IGNORE INTO pending_key_revokes (runtime_key_id, tenant_id, attempts, next_at) VALUES (?, ?, 0, ?)", [key.id, org.tenantId, deps.now()]);
    return dataClient(c);
  }
  return runtime.as(key.secret);
}

/** An instance admin needs a role of their own here: the override covers running the node, not reading its tenants' rows. */
function checkAccess(sub: Subject, project: string): void {
  authorize(sub, ACTION, project);
  if (sub.instanceAdmin && !can({ ...sub, instanceAdmin: false }, ACTION, project)) throw forbidden("forbidden", "not allowed");
}

async function target(c: OrgCtx, slug: string) {
  const app = await resolve(c, slug);
  checkAccess(c.sub, app.project);
  return app;
}

type Read = { deps: Deps; c: OrgCtx; slug: string; what: string; detail?: Record<string, unknown> };

const record = ({ deps, c, slug, what, detail }: Read) =>
  audit(deps, { actor: c.actor, orgId: c.org.id, action: what, target: slug, detail: detail ?? {} });

export async function tables(c: OrgCtx, slug: string) {
  const app = await target(c, slug);
  const cli = await dataClient(c);
  const out = await rt(() => cli.dataTables(app.id));
  await record({ deps: c.deps, c, slug, what: "app.data.tables" });
  return out;
}

export async function query(c: OrgCtx, slug: string, b: Record<string, unknown>) {
  const fields: Record<string, string> = {};
  for (const k of Object.keys(b)) if (k !== "sql" && k !== "args" && k !== "limit") fields[k] = "unknown";
  if (typeof b.sql !== "string" || b.sql.trim() === "" || b.sql.length > MAX_SQL) fields.sql = "out_of_range";
  if (b.args !== undefined && (!Array.isArray(b.args) || b.args.length > MAX_ARGS)) fields.args = "out_of_range";
  if (b.limit !== undefined && !(Number.isInteger(b.limit) && (b.limit as number) >= 1 && (b.limit as number) <= 500)) fields.limit = "out_of_range";
  const app = await target(c, slug);
  if (Object.keys(fields).length) throw invalid(fields);
  const cli = await dataClient(c);
  const out = await rt(() => cli.dataQuery(app.id, {
    sql: b.sql as string,
    ...(b.args ? { args: b.args as unknown[] } : {}),
    ...(b.limit ? { limit: b.limit as number } : {}),
  }));
  // The hash ties repeated reads together. The text can quote a value, so it stays out.
  await record({ deps: c.deps, c, slug, what: "app.data.query", detail: { sql_sha256: await sha256Hex(b.sql as string), rows: out.rows.length, truncated: out.truncated } });
  return out;
}

function listParams(q: URLSearchParams) {
  const raw = q.get("limit");
  const limit = raw === null ? undefined : Number(raw);
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= 200)) throw invalid({ limit: "out_of_range" });
  return { prefix: q.get("prefix") ?? undefined, cursor: q.get("cursor") ?? undefined, limit };
}

export async function kvList(c: OrgCtx, slug: string, q: URLSearchParams) {
  const app = await target(c, slug);
  const params = listParams(q);
  const cli = await dataClient(c);
  const out = await rt(() => cli.dataKv(app.id, params));
  await record({ deps: c.deps, c, slug, what: "app.data.kv_list", detail: { count: out.items.length } });
  return out;
}

export async function kvGet(c: OrgCtx, slug: string, keyB64: string) {
  const app = await target(c, slug);
  if (!KEY_B64_RE.test(keyB64)) throw notFound();
  const cli = await dataClient(c);
  const out = await rt(() => cli.dataKvGet(app.id, keyB64));
  // A key can hold personal data, so only its hash is kept.
  await record({ deps: c.deps, c, slug, what: "app.data.kv_read", detail: { key_sha256: await sha256Hex(keyB64) } });
  return out;
}

export async function blobs(c: OrgCtx, slug: string, q: URLSearchParams) {
  const app = await target(c, slug);
  const params = listParams(q);
  const cli = await dataClient(c);
  const out = await rt(() => cli.dataBlobs(app.id, params));
  await record({ deps: c.deps, c, slug, what: "app.data.blobs", detail: { count: out.items.length } });
  return out;
}
