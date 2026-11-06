// Turns what the node reports into alert state. Sends nothing: a state change and its outbox rows are written in
// one transaction, and the send job drains them later, so a crash on either side of that write neither loses a
// notification nor repeats one.
//
// Silence is not health. Only a figure that was actually read moves a rule; a failed or budget-cut read leaves
// every state as it was. /v1/node/stats omits services with no traffic, so a missing row counts as clear only
// once a whole pass over its pages has finished, which may take several ticks.

import { appIndexSlugs, appIndexTenants } from "../apps/index-table.ts";
import { sha256Hex } from "../crypto/hash.ts";
import { rethrowBudget } from "../jobs/budget.ts";
import type { Job, JobCtx } from "../jobs/runner.ts";
import { rtOf } from "../keys/keys.ts";
import type { Deps } from "../app.ts";
import { isNotFound } from "../runtime/client.ts";
import type { NodeStatsItem } from "../runtime/types.ts";
import type { Db, Row, Tx } from "../storage/types.ts";
import type { AlertMessage } from "./channels.ts";
import { channelIds, paramOf, type RuleRow } from "./rules.ts";

const ERROR_WINDOW_MS = 5 * 60_000;
const DLQ_WINDOW_MS = 15 * 60_000;
const EVERY_MS = 2 * 60_000;
const STALE_PASS_MS = 15 * 60_000;
const STATS_PAGE = 200;
const STATS_PAGES_PER_RUN = 5;
const EVENT_PAGE = 200;
const EVENT_PAGES_PER_RUN = 3;
const BUILD_MARK_TTL_MS = 30 * 86_400_000;
const EVENTS_AFTER_KEY = "alerts.events_after";
const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

type Deps2 = JobCtx["deps"];
type AlertRule = RuleRow & { tenant_id: string | null };

interface StateRow extends Row {
  rule_id: string;
  subject: string;
  state: "ok" | "pending" | "firing";
  since: number;
  last_sent_at: number | null;
  last_value: number | null;
  baseline_at: number | null;
  clear_since: number | null;
  seen_pass: number | null;
}

interface Observation {
  /** The condition holds right now. */
  bad: boolean;
  value: number | null;
  threshold: number | null;
  label: string;
  baselineAt?: number | null;
  pass?: number;
}

const round = (n: number) => Math.round(n * 100) / 100;
const stateKey = (rule: string, subject: string) => `${rule}|${subject}`;

/** Fixed per incident, so a re-run of the same evaluation cannot queue the same notification twice. */
const outboxId = async (rule: string, subject: string, event: string, instant: number, channel: string) =>
  `aob_${(await sha256Hex(`${rule}|${subject}|${event}|${instant}|${channel}`)).slice(0, 32)}`;

async function enqueue(tx: Tx, rule: AlertRule, subject: string, event: string, instant: number, message: AlertMessage, now: number): Promise<void> {
  for (const channel of channelIds(rule)) {
    await tx.run(
      "INSERT OR IGNORE INTO alert_outbox (id, channel_id, org_id, rule_id, body, attempts, next_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
      [await outboxId(rule.id, subject, event, instant, channel), channel, rule.org_id, rule.id, JSON.stringify(message), now],
    );
  }
}

async function saveState(tx: Tx, s: StateRow): Promise<void> {
  await tx.run(
    `INSERT INTO alert_state (rule_id, subject, state, since, last_sent_at, last_value, baseline_at, clear_since, seen_pass) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (rule_id, subject) DO UPDATE SET state = excluded.state, since = excluded.since, last_sent_at = excluded.last_sent_at,
       last_value = excluded.last_value, baseline_at = excluded.baseline_at, clear_since = excluded.clear_since, seen_pass = excluded.seen_pass`,
    [s.rule_id, s.subject, s.state, s.since, s.last_sent_at, s.last_value, s.baseline_at, s.clear_since, s.seen_pass],
  );
}

/** Time a problem must stay gone before it counts as resolved, so a flapping one does not notify on each flap. */
const clearMs = (rule: AlertRule) => Math.max(2 * rule.for_s * 1000, 2 * EVERY_MS);

/** The state machine: ok, pending for for_s, firing, resolved after the clear time. Re-sends at repeat_s. */
function step(prev: StateRow | undefined, rule: AlertRule, subject: string, o: Observation, now: number): { next: StateRow; event: "firing" | "repeat" | "resolved" | null; instant: number } {
  const base: StateRow = prev ?? { rule_id: rule.id, subject, state: "ok", since: now, last_sent_at: null, last_value: null, baseline_at: null, clear_since: null, seen_pass: null };
  const next: StateRow = { ...base, last_value: o.value, seen_pass: o.pass ?? base.seen_pass, baseline_at: o.baselineAt === undefined ? base.baseline_at : o.baselineAt };
  if (o.bad) {
    next.clear_since = null;
    if (next.state === "ok") {
      next.state = "pending";
      next.since = now;
    }
    if (next.state === "pending" && now - next.since >= rule.for_s * 1000) {
      next.state = "firing";
      next.last_sent_at = now;
      return { next, event: "firing", instant: next.since };
    }
    if (next.state === "firing" && now - (next.last_sent_at ?? next.since) >= rule.repeat_s * 1000) {
      next.last_sent_at = now;
      return { next, event: "repeat", instant: Math.floor(now / (rule.repeat_s * 1000)) };
    }
    return { next, event: null, instant: now };
  }
  if (next.state === "pending") {
    next.state = "ok";
    next.since = now;
    return { next, event: null, instant: now };
  }
  if (next.state === "firing") {
    next.clear_since ??= now;
    if (now - next.clear_since >= clearMs(rule)) {
      const instant = next.since;
      next.state = "ok";
      next.since = now;
      next.clear_since = null;
      return { next, event: "resolved", instant };
    }
  }
  return { next, event: null, instant: now };
}

class Evaluation {
  private readonly states = new Map<string, StateRow>();

  constructor(
    private readonly db: Db,
    private readonly now: number,
    existing: StateRow[],
  ) {
    for (const s of existing) this.states.set(stateKey(s.rule_id, s.subject), s);
  }

  stateOf(rule: string, subject: string): StateRow | undefined {
    return this.states.get(stateKey(rule, subject));
  }

  all(): StateRow[] {
    return [...this.states.values()];
  }

  async observe(rule: AlertRule, subject: string, o: Observation): Promise<void> {
    const prev = this.stateOf(rule.id, subject);
    // No row and nothing wrong: nothing to remember, unless a baseline has to be kept.
    if (!prev && !o.bad && o.baselineAt === undefined) return;
    const { next, event, instant } = step(prev, rule, subject, o, this.now);
    const unchanged = prev && !event && (["state", "since", "last_sent_at", "last_value", "baseline_at", "clear_since", "seen_pass"] as const).every((k) => prev[k] === next[k]);
    if (unchanged) return;
    const message: AlertMessage = { event: event ?? "", kind: rule.kind, subject: o.label, value: o.value, threshold: o.threshold, at: this.now };
    await this.db.tx(async (tx) => {
      await saveState(tx, next);
      if (event) await enqueue(tx, rule, subject, event, instant, message, this.now);
    });
    this.states.set(stateKey(rule.id, subject), next);
  }
}

async function loadRules(db: Db, now: number): Promise<AlertRule[]> {
  return db.all<AlertRule>(
    `SELECT r.*, o.tenant_id FROM alert_rules r LEFT JOIN orgs o ON o.id = r.org_id
     WHERE r.enabled = 1 AND (r.muted_until IS NULL OR r.muted_until <= ?) AND (r.org_id IS NULL OR o.deleted_at IS NULL)`,
    [now],
  );
}

async function evaluateInstance(deps: Deps2, ev: Evaluation, rules: AlertRule[], now: number): Promise<void> {
  const cli = rtOf(deps as Deps).op();
  const disk = rules.filter((r) => r.kind === "disk_low");
  if (disk.length) {
    const d = (await cli.nodeStatus()).host?.disk;
    // A node that reports no disk says nothing about it, either way.
    if (d && d.total_bytes > 0) {
      const pct = round((d.free_bytes / d.total_bytes) * 100);
      for (const r of disk) {
        const threshold = paramOf(r, "min_free_pct");
        await ev.observe(r, "node", { bad: pct < threshold, value: pct, threshold, label: "node" });
      }
    }
  }
  const stale = rules.filter((r) => r.kind === "backup_stale");
  if (stale.length) {
    let status;
    try {
      status = await cli.backupStatus();
    } catch (e) {
      // A node older than this route has nothing to say.
      if (isNotFound(e)) return;
      throw e;
    }
    for (const r of stale) {
      const threshold = paramOf(r, "max_age_h");
      // A node that never finished a backup is judged from when somebody started caring.
      const hours = round((now - (status.last_ok_at ?? r.created_at)) / 3600_000);
      await ev.observe(r, "backups", { bad: status.enabled && hours > threshold, value: hours, threshold, label: "backups" });
    }
  }
}

async function evaluateEvents(deps: Deps2, db: Db, rules: AlertRule[], now: number): Promise<void> {
  if (rules.length === 0) return;
  const cli = rtOf(deps as Deps).op();
  const saved = await db.first<{ value: string }>("SELECT value FROM settings WHERE key = ?", [EVENTS_AFTER_KEY]);
  let after = saved ? (JSON.parse(saved.value) as string) : undefined;
  for (let i = 0; i < EVENT_PAGES_PER_RUN; i++) {
    const page = await cli.nodeEvents({ after, kinds: "build.failed", limit: EVENT_PAGE });
    const services = [...new Set(page.items.flatMap((e) => (e.service ? [e.service] : [])))];
    const owners = await appIndexTenants(db, services);
    const slugs = await appIndexSlugs(db, services);
    for (const e of page.items) {
      const version = (e.data as { version?: unknown } | null)?.version;
      if (!e.service || !Number.isSafeInteger(version)) continue;
      const tenant = owners.get(e.service);
      if (!tenant || (e.tenant && e.tenant !== tenant)) continue;
      const subject = `${e.service}:${version as number}`;
      for (const r of rules) {
        if (r.tenant_id !== tenant || e.ts < r.created_at || (r.app_id && r.app_id !== e.service)) continue;
        const message: AlertMessage = { event: "firing", kind: r.kind, subject: slugs.get(e.service) ?? e.service, value: version as number, threshold: null, at: now };
        // The row is the "already told them" mark; it never shows as active because nothing clears a past build.
        await db.tx(async (tx) => {
          const mark = await tx.run(
            "INSERT OR IGNORE INTO alert_state (rule_id, subject, state, since, last_sent_at) VALUES (?, ?, 'ok', ?, ?)",
            [r.id, subject, now, now],
          );
          if (mark.changes > 0) await enqueue(tx, r, subject, "firing", 0, message, now);
        });
      }
    }
    const last = page.items.at(-1);
    if (last && EVENT_ID_RE.test(String(last.id))) {
      after = String(last.id);
      await db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [EVENTS_AFTER_KEY, JSON.stringify(after)]);
    }
    if (!page.next_cursor) return;
  }
}

function dlqObservation(prev: StateRow | undefined, rule: AlertRule, dlq: number, now: number): Pick<Observation, "bad" | "baselineAt" | "value"> {
  if (!prev || prev.baseline_at === null) {
    // Letters older than the rule are not growth; on an older rule, a service first seen with letters grew from none.
    const fresh = now - rule.created_at < DLQ_WINDOW_MS;
    return { bad: !fresh && dlq > 0, baselineAt: now, value: dlq };
  }
  if (now - prev.baseline_at < DLQ_WINDOW_MS) {
    // Between comparisons the last verdict stands. last_value stays the baseline.
    return { bad: prev.state !== "ok" && prev.clear_since === null, baselineAt: prev.baseline_at, value: prev.last_value };
  }
  return { bad: dlq > (prev.last_value ?? 0), baselineAt: now, value: dlq };
}

async function observeStat(ev: Evaluation, rules: AlertRule[], s: NodeStatsItem | { service: string; label: string }, pass: number, now: number): Promise<void> {
  const count = "count" in s ? s.count : 0;
  const errors = "count" in s ? s.errors : 0;
  const dlq = "count" in s ? s.dlq : 0;
  const label = "count" in s ? (s.slug ?? s.service) : s.label;
  for (const r of rules) {
    if (r.app_id && r.app_id !== s.service) continue;
    if (r.kind === "app_error_rate") {
      const threshold = paramOf(r, "threshold_pct");
      const volume = count >= paramOf(r, "min_requests");
      const pct = count > 0 ? round((errors / count) * 100) : 0;
      await ev.observe(r, s.service, { bad: volume && pct > threshold, value: pct, threshold, label, pass });
    } else if (r.kind === "dlq_growth") {
      if (dlq === 0 && !ev.stateOf(r.id, s.service)) continue;
      await ev.observe(r, s.service, { ...dlqObservation(ev.stateOf(r.id, s.service), r, dlq, now), threshold: null, label, pass });
    }
  }
}

interface Progress {
  pass: number;
  next: string;
}

function parseProgress(raw: string | null, now: number): Progress | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Progress;
    return Number.isSafeInteger(p.pass) && typeof p.next === "string" && now - p.pass < STALE_PASS_MS ? p : null;
  } catch {
    return null;
  }
}

/** Reads stats from where the last run stopped. Returns a cursor while pages remain. */
async function evaluateStats(ctx: JobCtx, db: Db, ev: Evaluation, rules: AlertRule[], resumed: Progress | null, now: number): Promise<{ cursor: string } | undefined> {
  if (rules.length === 0) return undefined;
  const cli = rtOf(ctx.deps as Deps).op();
  const pass = resumed?.pass ?? now;
  let next = resumed?.next;
  const byTenant = new Map<string, AlertRule[]>();
  for (const r of rules) if (r.tenant_id) byTenant.set(r.tenant_id, [...(byTenant.get(r.tenant_id) ?? []), r]);
  for (let i = 0; i < STATS_PAGES_PER_RUN; i++) {
    const page = await cli.nodeStats({ from: pass - ERROR_WINDOW_MS, to: pass, fields: "counts", limit: STATS_PAGE, cursor: next });
    const owners = await appIndexTenants(db, page.items.map((s) => s.service));
    for (const s of page.items) {
      const own = byTenant.get(s.tenant);
      // The route spans all tenants: a row counts only for an App of the org that owns that tenant.
      if (own && owners.get(s.service) === s.tenant) await observeStat(ev, own, s, pass, now);
    }
    if (!page.next_cursor) {
      await clearUnseen(ev, db, rules, pass, now);
      return undefined;
    }
    next = page.next_cursor;
    const progress = JSON.stringify({ pass, next } satisfies Progress);
    await ctx.checkpoint(progress);
    if (i === STATS_PAGES_PER_RUN - 1) return { cursor: progress };
  }
  return undefined;
}

/** The whole pass is in, so a subject it did not mention had no traffic and no letters. */
async function clearUnseen(ev: Evaluation, db: Db, rules: AlertRule[], pass: number, now: number): Promise<void> {
  const byId = new Map(rules.map((r) => [r.id, r]));
  const unseen = ev.all().filter((s) => byId.has(s.rule_id) && s.seen_pass !== pass);
  const slugs = await appIndexSlugs(db, unseen.map((s) => s.subject));
  for (const s of unseen) {
    await observeStat(ev, [byId.get(s.rule_id) as AlertRule], { service: s.subject, label: slugs.get(s.subject) ?? s.subject }, pass, now);
  }
}

async function evaluate(ctx: JobCtx): Promise<{ cursor: string } | undefined> {
  const { deps } = ctx;
  if (!deps.rtctl) return undefined;
  const db = deps.storage.db;
  const now = deps.now();
  await db.run(
    "DELETE FROM alert_state WHERE since < ? AND rule_id IN (SELECT id FROM alert_rules WHERE kind = 'build_failed')",
    [now - BUILD_MARK_TTL_MS],
  );
  const rules = await loadRules(db, now);
  if (rules.length === 0) return undefined;
  const instance = rules.filter((r) => r.org_id === null);
  const events = rules.filter((r) => r.kind === "build_failed");
  const stats = rules.filter((r) => r.kind === "app_error_rate" || r.kind === "dlq_growth");
  const marks = stats.map(() => "?").concat(instance.map(() => "?"));
  const existing = marks.length
    ? await db.all<StateRow>(`SELECT * FROM alert_state WHERE rule_id IN (${marks.join(",")})`, [...stats, ...instance].map((r) => r.id))
    : [];
  const ev = new Evaluation(db, now, existing);
  const resumed = parseProgress(ctx.cursor, now);

  // One read failing must not hide the others; instance rules go first so an org's load cannot starve them.
  let failure: unknown = null;
  const guarded = async <T>(f: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await f();
    } catch (e) {
      rethrowBudget(e);
      failure ??= e;
      return undefined;
    }
  };
  if (!resumed && instance.length) await guarded(() => evaluateInstance(deps, ev, instance, now));
  await guarded(() => evaluateEvents(deps, db, events, now));
  const out = await guarded(() => evaluateStats(ctx, db, ev, stats, resumed, now));
  if (failure) throw failure;
  return out;
}

export const ALERTS_EVAL_JOB: Job = { name: "alerts_evaluate", everyMs: EVERY_MS, run: evaluate };
