// What to watch. A rule's channels must belong to the rule's own scope: checked on every write here, and again
// at send time in outbox.ts, so a stale or edited row cannot deliver another org's alert.

import type { Deps } from "../app.ts";
import { appIndexSlugs } from "../apps/index-table.ts";
import { dbOf } from "../auth/types.ts";
import { base64url, randomBytes } from "../crypto/random.ts";
import { conflict, invalid, notFound } from "../http/errors.ts";
import type { Row } from "../storage/types.ts";

const ORG_KINDS = ["app_error_rate", "dlq_growth", "build_failed"];
const INSTANCE_KINDS = ["disk_low", "backup_stale"];
const APP_KINDS = new Set(ORG_KINDS);
const MAX_RULES = 50;
const MAX_RULE_CHANNELS = 5;
const MAX_FOR_S = 86_400;
const MIN_REPEAT_S = 300;
const MAX_REPEAT_S = 604_800;
const DEFAULT_FOR_S = 300;
const DEFAULT_REPEAT_S = 14_400;
const CREATE_FIELDS = new Set(["kind", "app", "params", "channels", "enabled", "for_s", "repeat_s", "muted_until"]);
const PATCH_FIELDS = new Set(["params", "channels", "enabled", "for_s", "repeat_s", "muted_until"]);

export interface RuleRow extends Row {
  id: string;
  org_id: string | null;
  app_id: string | null;
  kind: string;
  params: string;
  channels: string;
  enabled: number;
  for_s: number;
  repeat_s: number;
  muted_until: number | null;
  created_at: number;
}

interface ParamSpec {
  key: string;
  fallback: number;
  min: number;
  max: number;
}

const PARAMS: Record<string, ParamSpec[]> = {
  app_error_rate: [
    { key: "threshold_pct", fallback: 5, min: 0.1, max: 100 },
    { key: "min_requests", fallback: 100, min: 1, max: 1_000_000 },
  ],
  dlq_growth: [],
  build_failed: [],
  disk_low: [{ key: "min_free_pct", fallback: 15, min: 1, max: 99 }],
  backup_stale: [{ key: "max_age_h", fallback: 26, min: 1, max: 720 }],
};

/** A stored value within bounds, or the default: reads never trust the column more than writes did. */
export function paramOf(rule: Pick<RuleRow, "kind" | "params">, key: string): number {
  const spec = PARAMS[rule.kind]?.find((p) => p.key === key);
  if (!spec) throw new Error(`alerts: no param ${key}`);
  try {
    const v = (JSON.parse(rule.params) as Record<string, unknown>)[key];
    return typeof v === "number" && v >= spec.min && v <= spec.max ? v : spec.fallback;
  } catch {
    return spec.fallback;
  }
}

export const channelIds = (rule: Pick<RuleRow, "channels">): string[] => {
  try {
    const v: unknown = JSON.parse(rule.channels);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

function parseParams(kind: string, raw: unknown, fields: Record<string, string>): Record<string, number> {
  const specs = PARAMS[kind] ?? [];
  const out: Record<string, number> = {};
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) {
    fields.params = "not_object";
    return out;
  }
  const given = (raw ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(given)) if (!specs.some((s) => s.key === k)) fields[`params.${k}`] = "unknown";
  for (const s of specs) {
    const v = given[s.key] ?? s.fallback;
    if (typeof v !== "number" || !Number.isFinite(v) || v < s.min || v > s.max) fields[`params.${s.key}`] = "out_of_range";
    else out[s.key] = v;
  }
  return out;
}

function checkTiming(b: Record<string, unknown>, fields: Record<string, string>): void {
  const whole = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
  if (b.for_s !== undefined && !whole(b.for_s, 0, MAX_FOR_S)) fields.for_s = "out_of_range";
  if (b.repeat_s !== undefined && !whole(b.repeat_s, MIN_REPEAT_S, MAX_REPEAT_S)) fields.repeat_s = "out_of_range";
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") fields.enabled = "not_boolean";
  if (b.muted_until !== undefined && b.muted_until !== null && !(Number.isSafeInteger(b.muted_until) && (b.muted_until as number) >= 0)) fields.muted_until = "out_of_range";
}

async function checkChannels(deps: Pick<Deps, "storage" | "config">, orgId: string | null, raw: unknown, fields: Record<string, string>): Promise<string[]> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_RULE_CHANNELS || !raw.every((x) => typeof x === "string") || new Set(raw).size !== raw.length) {
    fields.channels = "invalid_format";
    return [];
  }
  const ids = raw as string[];
  const found = await (await dbOf(deps)).all<{ id: string }>(`SELECT id FROM alert_channels WHERE org_id IS ? AND id IN (${ids.map(() => "?").join(",")})`, [orgId, ...ids]);
  // The same answer for "no such channel" and "another org's channel".
  if (found.length !== ids.length) fields.channels = "unknown_channel";
  return ids;
}

async function view(deps: Pick<Deps, "storage">, rows: RuleRow[]) {
  const slugs = await appIndexSlugs(deps.storage.db, rows.flatMap((r) => (r.app_id ? [r.app_id] : [])));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    app: r.app_id ? (slugs.get(r.app_id) ?? null) : null,
    params: JSON.parse(r.params) as Record<string, number>,
    channels: channelIds(r),
    enabled: r.enabled === 1,
    for_s: r.for_s,
    repeat_s: r.repeat_s,
    muted_until: r.muted_until,
    created_at: r.created_at,
  }));
}

async function rowOf(deps: Pick<Deps, "storage" | "config">, orgId: string | null, id: string): Promise<RuleRow> {
  const row = await (await dbOf(deps)).first<RuleRow>("SELECT * FROM alert_rules WHERE id = ? AND org_id IS ?", [id, orgId]);
  if (!row) throw notFound();
  return row;
}

export async function listRules(deps: Pick<Deps, "storage" | "config">, orgId: string | null) {
  const rows = await (await dbOf(deps)).all<RuleRow>("SELECT * FROM alert_rules WHERE org_id IS ? ORDER BY created_at, id", [orgId]);
  return { items: await view(deps, rows) };
}

/** `appId` resolves a slug inside the caller's org, and throws 404 for anything outside it. */
export async function createRule(deps: Pick<Deps, "storage" | "config" | "now">, orgId: string | null, userId: string, b: Record<string, unknown>, appId: (slug: string) => Promise<string>) {
  const fields: Record<string, string> = {};
  for (const k of Object.keys(b)) if (!CREATE_FIELDS.has(k)) fields[k] = "unknown";
  const kinds = orgId === null ? INSTANCE_KINDS : ORG_KINDS;
  if (typeof b.kind !== "string" || !kinds.includes(b.kind)) fields.kind = "not_one_of";
  const kind = b.kind as string;
  if (b.app !== undefined && (typeof b.app !== "string" || !APP_KINDS.has(kind))) fields.app = "invalid_format";
  const params = parseParams(kind, b.params, fields);
  checkTiming(b, fields);
  const channels = await checkChannels(deps, orgId, b.channels, fields);
  if (Object.keys(fields).length) throw invalid(fields);
  const app = typeof b.app === "string" ? await appId(b.app) : null;
  const db = await dbOf(deps);
  const count = await db.first<{ c: number }>("SELECT count(*) AS c FROM alert_rules WHERE org_id IS ?", [orgId]);
  if (Number(count?.c ?? 0) >= MAX_RULES) throw conflict("alert_rule_limit", "too many alert rules");
  const row: RuleRow = {
    id: `arl_${base64url(randomBytes(12))}`, org_id: orgId, app_id: app, kind, params: JSON.stringify(params), channels: JSON.stringify(channels),
    enabled: b.enabled === false ? 0 : 1, for_s: (b.for_s as number | undefined) ?? DEFAULT_FOR_S, repeat_s: (b.repeat_s as number | undefined) ?? DEFAULT_REPEAT_S,
    muted_until: (b.muted_until as number | null | undefined) ?? null, created_at: deps.now(),
  };
  await db.run(
    `INSERT INTO alert_rules (id, org_id, app_id, kind, params, channels, enabled, for_s, repeat_s, muted_until, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, orgId, app, kind, row.params, row.channels, row.enabled, row.for_s, row.repeat_s, row.muted_until, userId, row.created_at],
  );
  return (await view(deps, [row]))[0];
}

export async function updateRule(deps: Pick<Deps, "storage" | "config">, orgId: string | null, id: string, b: Record<string, unknown>) {
  const row = await rowOf(deps, orgId, id);
  const fields: Record<string, string> = {};
  for (const k of Object.keys(b)) if (!PATCH_FIELDS.has(k)) fields[k] = "unknown";
  checkTiming(b, fields);
  const next: RuleRow = { ...row };
  if (b.params !== undefined) next.params = JSON.stringify(parseParams(row.kind, b.params, fields));
  if (b.channels !== undefined) next.channels = JSON.stringify(await checkChannels(deps, orgId, b.channels, fields));
  if (Object.keys(fields).length) throw invalid(fields);
  if (b.enabled !== undefined) next.enabled = b.enabled ? 1 : 0;
  if (b.for_s !== undefined) next.for_s = b.for_s as number;
  if (b.repeat_s !== undefined) next.repeat_s = b.repeat_s as number;
  if (b.muted_until !== undefined) next.muted_until = b.muted_until as number | null;
  const stmts = [{
    sql: "UPDATE alert_rules SET params = ?, channels = ?, enabled = ?, for_s = ?, repeat_s = ?, muted_until = ? WHERE id = ? AND org_id IS ?",
    args: [next.params, next.channels, next.enabled, next.for_s, next.repeat_s, next.muted_until, id, orgId],
  }];
  // Off means off: a rule turned back on starts clean rather than resolving a problem nobody watched end.
  if (next.enabled === 0) stmts.push({ sql: "DELETE FROM alert_state WHERE rule_id = ?", args: [id] });
  await (await dbOf(deps)).batch(stmts);
  return (await view(deps, [next]))[0];
}

export async function deleteRule(deps: Pick<Deps, "storage" | "config">, orgId: string | null, id: string): Promise<void> {
  await rowOf(deps, orgId, id);
  await (await dbOf(deps)).batch([
    { sql: "DELETE FROM alert_state WHERE rule_id = ?", args: [id] },
    { sql: "DELETE FROM alert_outbox WHERE rule_id = ?", args: [id] },
    { sql: "DELETE FROM alert_rules WHERE id = ? AND org_id IS ?", args: [id, orgId] },
  ]);
}

export async function activeAlerts(deps: Pick<Deps, "storage" | "config">, orgId: string | null) {
  const rows = await (await dbOf(deps)).all<{ rule_id: string; subject: string; state: string; since: number; last_sent_at: number | null; last_value: number | null; kind: string }>(
    `SELECT s.rule_id, s.subject, s.state, s.since, s.last_sent_at, s.last_value, r.kind FROM alert_state s
     JOIN alert_rules r ON r.id = s.rule_id WHERE r.org_id IS ? AND s.state <> 'ok' ORDER BY s.since DESC LIMIT 200`,
    [orgId],
  );
  const slugs = await appIndexSlugs(deps.storage.db, rows.map((r) => r.subject));
  return { items: rows.map((r) => ({ rule_id: r.rule_id, kind: r.kind, subject: slugs.get(r.subject) ?? r.subject, state: r.state, since: r.since, last_sent_at: r.last_sent_at, value: r.last_value })) };
}
