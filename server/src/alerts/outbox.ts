// Drains the alert outbox, at least once and at most MAX_ATTEMPTS times: an attempt is charged before the request
// goes out, so a crash after the receiver got it repeats the send a bounded number of times instead of forever.
// Receivers can dedupe on X-Rtweb-Delivery. This job runs last in the tick, so a slow receiver only ever costs
// other receivers, and the per-org share and the stop-on-failure keep one org's tarpit from taking the whole tick.

import type { Job, JobCtx } from "../jobs/runner.ts";
import type { Db, Row } from "../storage/types.ts";
import { deliver, recordStatus, type AlertMessage, type ChannelRow, type SendStatus } from "./channels.ts";
import { channelIds, type RuleRow } from "./rules.ts";

export const MAX_ATTEMPTS = 8;
const MAX_SENDS = 20;
const ORG_SHARE = 5;
const CHANNEL_WINDOW = 25;
/** More than this due at once on one channel goes out as a single digest. */
const DIGEST_ABOVE = 5;
const DIGEST_ITEMS = 20;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 3600_000;

interface OutboxRow extends Row {
  id: string;
  channel_id: string;
  org_id: string | null;
  rule_id: string | null;
  body: string;
  attempts: number;
  next_at: number;
  total: number;
}

interface Delivery {
  channel: ChannelRow;
  rows: OutboxRow[];
  message: AlertMessage;
}

const backoff = (attempts: number) => Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_MAX_MS);

const drop = (db: Db, id: string) => db.run("DELETE FROM alert_outbox WHERE id = ?", [id]);

const parseBody = (r: OutboxRow): AlertMessage => JSON.parse(r.body) as AlertMessage;

/** The channel must still be one the row's rule names, in the same scope: the write-time check can be stale. */
function allowed(r: OutboxRow, c: ChannelRow | undefined, rule: RuleRow | undefined): c is ChannelRow {
  if (!c || c.org_id !== r.org_id) return false;
  if (r.rule_id === null) return true;
  return !!rule && rule.org_id === c.org_id && channelIds(rule).includes(c.id);
}

function digest(rows: OutboxRow[], now: number): AlertMessage {
  const items = rows.slice(0, DIGEST_ITEMS).map((r) => {
    const m = parseBody(r);
    return { event: m.event, kind: m.kind, subject: m.subject, value: m.value };
  });
  return { event: "digest", count: rows.length, items, at: now };
}

/** Instance alerts first, then one org at a time, each up to its share. */
function pick(deliveries: Delivery[]): Delivery[] {
  const byOwner = new Map<string | null, Delivery[]>();
  for (const d of deliveries) byOwner.set(d.channel.org_id, [...(byOwner.get(d.channel.org_id) ?? []), d]);
  const out = [...(byOwner.get(null) ?? [])].slice(0, MAX_SENDS);
  byOwner.delete(null);
  const queues = [...byOwner.values()].map((q) => q.slice(0, ORG_SHARE));
  for (let turn = 0; turn < ORG_SHARE && out.length < MAX_SENDS; turn++) {
    for (const q of queues) {
      const d = q[turn];
      if (d && out.length < MAX_SENDS) out.push(d);
    }
  }
  return out;
}

async function plan(db: Db, now: number): Promise<Delivery[]> {
  const rows = await db.all<OutboxRow>(
    `SELECT * FROM (SELECT o.*, row_number() OVER (PARTITION BY channel_id ORDER BY next_at, id) AS rn, count(*) OVER (PARTITION BY channel_id) AS total
       FROM alert_outbox o WHERE next_at <= ?) WHERE rn <= ? ORDER BY next_at, id`,
    [now, CHANNEL_WINDOW],
  );
  if (rows.length === 0) return [];
  const channelList = [...new Set(rows.map((r) => r.channel_id))];
  const channels = new Map((await db.all<ChannelRow>(`SELECT * FROM alert_channels WHERE id IN (${channelList.map(() => "?").join(",")})`, channelList)).map((c) => [c.id, c]));
  const ruleList = [...new Set(rows.flatMap((r) => (r.rule_id ? [r.rule_id] : [])))];
  const rules = new Map(
    (ruleList.length ? await db.all<RuleRow>(`SELECT * FROM alert_rules WHERE id IN (${ruleList.map(() => "?").join(",")})`, ruleList) : []).map((r) => [r.id, r]),
  );
  const groups = new Map<string, { channel: ChannelRow; rows: OutboxRow[] }>();
  for (const r of rows) {
    const c = channels.get(r.channel_id);
    // Spent rows go without a send: this is what bounds a crash loop.
    if (r.attempts >= MAX_ATTEMPTS || !allowed(r, c, r.rule_id ? rules.get(r.rule_id) : undefined)) {
      await drop(db, r.id);
      continue;
    }
    const g = groups.get(c.id) ?? { channel: c, rows: [] };
    g.rows.push(r);
    groups.set(c.id, g);
  }
  const out: Delivery[] = [];
  for (const g of groups.values()) {
    if (g.rows.length > DIGEST_ABOVE) out.push({ channel: g.channel, rows: g.rows, message: digest(g.rows, now) });
    else for (const r of g.rows) out.push({ channel: g.channel, rows: [r], message: parseBody(r) });
  }
  return out;
}

/** Charges the attempt. A row another tick already took is left to it. */
async function claim(db: Db, rows: OutboxRow[], now: number): Promise<OutboxRow[]> {
  const claimed: OutboxRow[] = [];
  for (const r of rows) {
    const res = await db.run("UPDATE alert_outbox SET attempts = attempts + 1, next_at = ? WHERE id = ? AND attempts = ? AND next_at = ?", [now + backoff(r.attempts), r.id, r.attempts, r.next_at]);
    if (res.changes > 0) claimed.push(r);
  }
  return claimed;
}

async function unclaim(db: Db, rows: OutboxRow[]): Promise<void> {
  for (const r of rows) await db.run("UPDATE alert_outbox SET attempts = ?, next_at = ? WHERE id = ?", [r.attempts, r.next_at, r.id]);
}

async function settle(ctx: JobCtx, d: Delivery, rows: OutboxRow[], status: SendStatus): Promise<void> {
  const db = ctx.deps.storage.db;
  if (status === "ok") {
    for (const r of rows) await drop(db, r.id);
  } else {
    console.error("alerts: delivery failed", status);
    for (const r of rows) if (r.attempts + 1 >= MAX_ATTEMPTS) await drop(db, r.id);
  }
  await recordStatus(ctx.deps, d.channel.id, status);
}

async function run(ctx: JobCtx): Promise<undefined> {
  const { deps } = ctx;
  const db = deps.storage.db;
  const failed = new Set<string>();
  for (const d of pick(await plan(db, deps.now()))) {
    if (failed.has(d.channel.id)) continue;
    const rows = await claim(db, d.rows, deps.now());
    if (rows.length === 0) continue;
    let status: SendStatus;
    try {
      status = await deliver(deps, d.channel, d.message, (rows[0] as OutboxRow).id);
    } catch (e) {
      // deliver throws only when the budget runs out, which says nothing about the receiver.
      await unclaim(db, rows);
      throw e;
    }
    await settle(ctx, d, rows, status);
    if (status !== "ok") failed.add(d.channel.id);
  }
  return undefined;
}

export const ALERTS_SEND_JOB: Job = { name: "alerts_send", everyMs: 60_000, run };
