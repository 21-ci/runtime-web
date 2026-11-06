// Enabling data-change events. They can carry row contents to a topic, so the runtime wants services:write together
// with data:read, and neither long-lived console key holds both on purpose (apps/data.ts). This mints a key for the one
// call and revokes it: same people as the data browser, plus app.update.

import { audit } from "../audit/audit.ts";
import { dbOf } from "../auth/types.ts";
import { AppError, invalid } from "../http/errors.ts";
import { authorize } from "../orgs/members.ts";
import { Runtime } from "../runtime/client.ts";
import { rt } from "../runtime/errors.ts";
import type { DataEvents, DataEventsConfig } from "../runtime/types.ts";
import { target } from "./data.ts";
import type { OrgCtx } from "./service.ts";

const KEY_NAME = "rtweb-data-events";
const KEY_TTL_MS = 60_000;
const OPS = new Set(["insert", "update", "delete"]);
const MAX_ROWS = 64;

const payload = (v: unknown): "keys" | "row" | null => (v === undefined || v === "keys" ? "keys" : v === "row" ? "row" : null);

/** Shape checks only; the runtime decides whether the topic and tables exist. */
export function parseConfig(b: Record<string, unknown>): DataEventsConfig {
  const fields: Record<string, string> = {};
  if (typeof b.topic !== "string" || !b.topic) fields.topic = "required";
  const rawTables = b.tables ?? [];
  const rawKv = b.kv_prefixes ?? [];
  if (!Array.isArray(rawTables) || rawTables.length > MAX_ROWS) fields.tables = "invalid";
  if (!Array.isArray(rawKv) || rawKv.length > MAX_ROWS) fields.kv_prefixes = "invalid";
  if (b.max_backlog !== undefined && (!Number.isSafeInteger(b.max_backlog) || (b.max_backlog as number) < 1)) fields.max_backlog = "invalid";
  if (Object.keys(fields).length) throw invalid(fields);

  const tables = (rawTables as Record<string, unknown>[]).map((t) => {
    const ops = t?.ops;
    const p = payload(t?.payload);
    if (typeof t?.name !== "string" || !t.name || !Array.isArray(ops) || !ops.length || !ops.every((o) => OPS.has(o as string)) || !p) {
      throw invalid({ tables: "invalid" });
    }
    return { name: t.name, ops: ops as string[], payload: p };
  });
  const kv_prefixes = (rawKv as Record<string, unknown>[]).map((k) => {
    const p = payload(k?.payload);
    if (typeof k?.prefix !== "string" || !p) throw invalid({ kv_prefixes: "invalid" });
    return { prefix: k.prefix, payload: p };
  });
  return { topic: b.topic as string, tables, kv_prefixes, ...(b.max_backlog !== undefined ? { max_backlog: b.max_backlog as number } : {}) };
}

export async function enable(c: OrgCtx, slug: string, config: DataEventsConfig): Promise<DataEvents> {
  const { deps, org } = c;
  const app = await target(c, slug);
  authorize(c.sub, "app.update", app.project);
  if (!deps.rtctl) throw new AppError(502, "runtime_unavailable", "runtime unavailable");
  const runtime = new Runtime(deps.rtctl);
  const key = await rt(() =>
    runtime.op().createTenantKey(org.tenantId, {
      name: KEY_NAME,
      scopes: ["services:write", "data:read"],
      expires_at: new Date(deps.now() + KEY_TTL_MS).toISOString(),
    }),
  );
  try {
    const out = await rt(() => runtime.as(key.secret).putDataEvents(app.id, config));
    await audit(deps, {
      actor: c.actor,
      orgId: org.id,
      action: "app.data_events.set",
      target: slug,
      detail: { topic: config.topic, tables: config.tables.map((t) => t.name), kv_prefixes: config.kv_prefixes.length },
    });
    return out;
  } finally {
    await runtime.op().revokeTenantKey(org.tenantId, key.id).catch(async () => {
      // The job that retries revokes takes over; the key also expires by itself.
      const db = await dbOf(deps);
      await db.run("INSERT OR IGNORE INTO pending_key_revokes (runtime_key_id, tenant_id, attempts, next_at) VALUES (?, ?, 0, ?)", [key.id, org.tenantId, deps.now()]);
    });
  }
}
