// Where alerts go. A channel's config holds credentials (a webhook URL can carry a token in its path), so it is
// sealed to its row and no route returns it. An update replaces the whole config: keeping a stored signing secret
// while moving the URL would let an edit read that secret back through a signature.

import type { Deps } from "../app.ts";
import { assertPublicHost } from "../auth/oauth.ts";
import { dbOf, sealerOf } from "../auth/types.ts";
import { base64url, randomBytes } from "../crypto/random.ts";
import { publicLiteral } from "../git/provider.ts";
import { signOutbound } from "../hooks/verify.ts";
import { AppError, conflict, invalid, notFound } from "../http/errors.ts";
import { rethrowBudget } from "../jobs/budget.ts";
import type { Row } from "../storage/types.ts";

/** A status class only: anything finer would make last_error an oracle for what the target answers. */
export type SendStatus = "ok" | "3xx" | "4xx" | "5xx" | "network" | "blocked" | "config";

/** The kinds a channel can be created with. The table also admits `email`, which has no delivery yet. */
const KINDS = ["webhook", "telegram"] as const;
type ChannelKind = (typeof KINDS)[number];

const MAX_CHANNELS = 20;
const MAX_NAME = 64;
const MAX_URL = 2048;
const SECRET_RE = /^[\x21-\x7e]{16,256}$/;
const BOT_TOKEN_RE = /^\d{1,20}:[A-Za-z0-9_-]{20,100}$/;
const CHAT_ID_RE = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/;
const SEND_TIMEOUT_MS = 3_000;
const TEST_WINDOW_MS = 60_000;
const TEST_LIMIT = 5;
const EXCERPT_READ_BYTES = 4096;
const EXCERPT_CHARS = 200;
const CREATE_FIELDS = new Set(["kind", "name", "config"]);
const PATCH_FIELDS = new Set(["name", "config"]);

export interface ChannelRow extends Row {
  id: string;
  org_id: string | null;
  kind: string;
  name: string;
  config_sealed: Uint8Array;
  created_at: number;
  last_ok_at: number | null;
  last_error: string | null;
}

interface WebhookConfig {
  url: string;
  secret: string;
}
interface TelegramConfig {
  bot_token: string;
  chat_id: string;
}

export interface AlertMessage {
  event: string;
  kind?: string;
  subject?: string;
  value?: number | null;
  threshold?: number | null;
  at?: number;
  count?: number;
  items?: unknown[];
}

type SendDeps = Pick<Deps, "storage" | "config" | "now" | "fetch">;

const configContext = (id: string) => `alert.channel:${id}`;
const enc = new TextEncoder();

const view = (c: ChannelRow) => ({ id: c.id, kind: c.kind, name: c.name, created_at: c.created_at, last_ok_at: c.last_ok_at, last_error: c.last_error });

function webhookUrlError(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > MAX_URL) return "invalid_format";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "invalid_format";
  }
  if (u.protocol !== "https:" || u.username || u.password || u.hash || !u.hostname) return "not_public_https";
  return publicLiteral(u.hostname) ? null : "not_public_https";
}

/** Rejects a name resolving to a private address. The runtime's egress guard resolves again when it connects. */
async function resolvesPublic(deps: SendDeps, url: string): Promise<boolean> {
  try {
    await assertPublicHost(deps as Deps, new URL(url).hostname.replace(/\.+$/, ""));
    return true;
  } catch (e) {
    // The guard wraps a lookup failure, and running out of budget says nothing about the host.
    rethrowBudget((e as Error).cause);
    rethrowBudget(e);
    return false;
  }
}

async function parseConfig(deps: SendDeps, kind: ChannelKind, raw: unknown): Promise<WebhookConfig | TelegramConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid({ config: "not_object" });
  const c = raw as Record<string, unknown>;
  const fields: Record<string, string> = {};
  if (kind === "webhook") {
    for (const k of Object.keys(c)) if (k !== "url" && k !== "secret") fields[`config.${k}`] = "unknown";
    const urlError = webhookUrlError(c.url);
    if (urlError) fields["config.url"] = urlError;
    if (typeof c.secret !== "string" || !SECRET_RE.test(c.secret)) fields["config.secret"] = "pattern";
    if (Object.keys(fields).length) throw invalid(fields);
    if (!(await resolvesPublic(deps, c.url as string))) throw invalid({ "config.url": "not_public" });
    return { url: c.url as string, secret: c.secret as string };
  }
  for (const k of Object.keys(c)) if (k !== "bot_token" && k !== "chat_id") fields[`config.${k}`] = "unknown";
  if (typeof c.bot_token !== "string" || !BOT_TOKEN_RE.test(c.bot_token)) fields["config.bot_token"] = "pattern";
  if (typeof c.chat_id !== "string" || !CHAT_ID_RE.test(c.chat_id)) fields["config.chat_id"] = "pattern";
  if (Object.keys(fields).length) throw invalid(fields);
  return { bot_token: c.bot_token as string, chat_id: c.chat_id as string };
}

const seal = async (deps: SendDeps, id: string, config: WebhookConfig | TelegramConfig) =>
  (await sealerOf(deps)).seal(enc.encode(JSON.stringify(config)), configContext(id));

function validName(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= MAX_NAME;
}

async function rowOf(deps: SendDeps, orgId: string | null, id: string): Promise<ChannelRow> {
  const row = await (await dbOf(deps)).first<ChannelRow>("SELECT * FROM alert_channels WHERE id = ? AND org_id IS ?", [id, orgId]);
  if (!row) throw notFound();
  return row;
}

export async function listChannels(deps: SendDeps, orgId: string | null) {
  const rows = await (await dbOf(deps)).all<ChannelRow>("SELECT * FROM alert_channels WHERE org_id IS ? ORDER BY created_at, id", [orgId]);
  return { items: rows.map(view) };
}

export async function createChannel(deps: SendDeps, orgId: string | null, userId: string, b: Record<string, unknown>) {
  const fields: Record<string, string> = {};
  for (const k of Object.keys(b)) if (!CREATE_FIELDS.has(k)) fields[k] = "unknown";
  if (!(KINDS as readonly unknown[]).includes(b.kind)) fields.kind = "not_one_of";
  if (!validName(b.name)) fields.name = "invalid_format";
  if (Object.keys(fields).length) throw invalid(fields);
  const config = await parseConfig(deps, b.kind as ChannelKind, b.config);
  const db = await dbOf(deps);
  const count = await db.first<{ c: number }>("SELECT count(*) AS c FROM alert_channels WHERE org_id IS ?", [orgId]);
  if (Number(count?.c ?? 0) >= MAX_CHANNELS) throw conflict("alert_channel_limit", "too many alert channels");
  const id = `ach_${base64url(randomBytes(12))}`;
  const row: ChannelRow = { id, org_id: orgId, kind: b.kind as string, name: b.name as string, config_sealed: await seal(deps, id, config), created_at: deps.now(), last_ok_at: null, last_error: null };
  await db.run(
    "INSERT INTO alert_channels (id, org_id, kind, name, config_sealed, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, orgId, row.kind, row.name, row.config_sealed, userId, row.created_at],
  );
  return view(row);
}

export async function updateChannel(deps: SendDeps, orgId: string | null, id: string, b: Record<string, unknown>) {
  const row = await rowOf(deps, orgId, id);
  const fields: Record<string, string> = {};
  for (const k of Object.keys(b)) if (!PATCH_FIELDS.has(k)) fields[k] = "unknown";
  if (b.name !== undefined && !validName(b.name)) fields.name = "invalid_format";
  if (Object.keys(fields).length) throw invalid(fields);
  const next: ChannelRow = { ...row, name: (b.name as string | undefined) ?? row.name };
  if (b.config !== undefined) {
    if (!(KINDS as readonly string[]).includes(row.kind)) throw invalid({ config: "not_supported" });
    next.config_sealed = await seal(deps, id, await parseConfig(deps, row.kind as ChannelKind, b.config));
    next.last_error = null;
  }
  await (await dbOf(deps)).run("UPDATE alert_channels SET name = ?, config_sealed = ?, last_error = ? WHERE id = ? AND org_id IS ?", [next.name, next.config_sealed, next.last_error, id, orgId]);
  return view(next);
}

export async function deleteChannel(deps: SendDeps, orgId: string | null, id: string): Promise<void> {
  await rowOf(deps, orgId, id);
  const db = await dbOf(deps);
  const used = await db.first("SELECT 1 AS x FROM alert_rules, json_each(alert_rules.channels) WHERE org_id IS ? AND json_each.value = ? LIMIT 1", [orgId, id]);
  if (used) throw conflict("alert_channel_in_use", "a rule uses this channel");
  await db.batch([
    { sql: "DELETE FROM alert_outbox WHERE channel_id = ?", args: [id] },
    { sql: "DELETE FROM alert_channels WHERE id = ? AND org_id IS ?", args: [id, orgId] },
  ]);
}

function statusClass(status: number): SendStatus {
  if (status >= 200 && status < 300) return "ok";
  // An opaque redirect reports status 0.
  if (status === 0 || (status >= 300 && status < 400)) return "3xx";
  return status >= 500 ? "5xx" : "4xx";
}

function telegramText(m: AlertMessage): string {
  if (m.event === "digest") return `Alerts: ${m.count ?? 0} notifications`;
  const parts = [`[${m.event}] ${m.kind ?? "alert"}`];
  if (m.subject) parts.push(m.subject);
  if (typeof m.value === "number") parts.push(`value ${m.value}`);
  if (typeof m.threshold === "number") parts.push(`threshold ${m.threshold}`);
  return parts.join(" ");
}

/** What a test send saw. It goes back to the admin who asked, and is neither stored nor audited. */
export interface SendProbe {
  http_status?: number;
  excerpt?: string;
}

/**
 * The start of a refusal's body, for telling a wrong token from a wrong path. The far end can echo what it was sent,
 * so anything from the channel's config is blanked. Reads at most a few KiB, and a body that cannot be read is no
 * excerpt rather than a failed test.
 */
async function readExcerpt(res: Response, secrets: (string | undefined)[]): Promise<string | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return undefined;
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < EXCERPT_READ_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      parts.push(value);
      size += value.length;
    }
  } catch (e) {
    rethrowBudget(e);
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  let text = new TextDecoder().decode(all);
  for (const s of secrets) if (s) text = text.replaceAll(s, "***");
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  return text ? text.slice(0, EXCERPT_CHARS) : undefined;
}

/**
 * One delivery attempt. Never follows a redirect, because the hop would skip the address check. Returns a status
 * class; running out of the tick's budget is the only thing it throws. Errors are dropped unread: their text can
 * quote the URL, and the URL can hold the credential.
 *
 * `probe`, for a test send only, receives the HTTP status and a redacted excerpt of a refusal's body.
 */
export async function deliver(deps: SendDeps, c: ChannelRow, message: AlertMessage, delivery: string, probe?: SendProbe): Promise<SendStatus> {
  let config: WebhookConfig & TelegramConfig;
  try {
    const plain = await (await sealerOf(deps)).open(c.config_sealed, configContext(c.id));
    config = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return "config";
  }
  const f = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const common = { method: "POST", redirect: "manual", signal: AbortSignal.timeout(SEND_TIMEOUT_MS) } as const;
  try {
    let res: Response;
    if (c.kind === "webhook") {
      if (!(await resolvesPublic(deps, config.url))) return "blocked";
      const body = JSON.stringify({ delivery, ...message });
      const signature = await signOutbound(config.secret, enc.encode(body), deps.now());
      res = await f(config.url, { ...common, body, headers: { "content-type": "application/json", "x-rtweb-signature": signature, "x-rtweb-delivery": delivery } });
    } else if (c.kind === "telegram") {
      const body = JSON.stringify({ chat_id: config.chat_id, text: telegramText(message) });
      res = await f(`https://api.telegram.org/bot${config.bot_token}/sendMessage`, { ...common, body, headers: { "content-type": "application/json" } });
    } else {
      return "config";
    }
    const status = statusClass(res.status);
    if (probe) {
      probe.http_status = res.status;
      const excerpt = status === "ok" ? undefined : await readExcerpt(res, [config.url, config.secret, config.bot_token, config.chat_id]);
      if (excerpt) probe.excerpt = excerpt;
    }
    void res.body?.cancel().catch(() => undefined);
    return status;
  } catch (e) {
    rethrowBudget(e);
    return "network";
  }
}

export async function recordStatus(deps: SendDeps, id: string, status: SendStatus): Promise<void> {
  const db = await dbOf(deps);
  if (status === "ok") await db.run("UPDATE alert_channels SET last_ok_at = ?, last_error = NULL WHERE id = ?", [deps.now(), id]);
  else await db.run("UPDATE alert_channels SET last_error = ? WHERE id = ?", [status, id]);
}

/** Sends a fixed test message. Limited per channel, since each call makes the console knock on a chosen URL. */
export async function testChannel(deps: SendDeps, orgId: string | null, id: string): Promise<{ ok: boolean; status: SendStatus; kind: string } & SendProbe> {
  const row = await rowOf(deps, orgId, id);
  const now = deps.now();
  const start = now - TEST_WINDOW_MS;
  const taken = await (await dbOf(deps)).run(
    `UPDATE alert_channels SET
       test_count = CASE WHEN test_window_at IS NULL OR test_window_at <= ? THEN 1 ELSE test_count + 1 END,
       test_window_at = CASE WHEN test_window_at IS NULL OR test_window_at <= ? THEN ? ELSE test_window_at END
     WHERE id = ? AND (test_window_at IS NULL OR test_window_at <= ? OR test_count < ?)`,
    [start, start, now, id, start, TEST_LIMIT],
  );
  if (taken.changes === 0) throw new AppError(429, "rate_limited", "too many test sends", { retry_after: Math.ceil(TEST_WINDOW_MS / 1000) });
  const probe: SendProbe = {};
  const status = await deliver(deps, row, { event: "test", at: now }, `test_${base64url(randomBytes(9))}`, probe);
  await recordStatus(deps, id, status);
  return { ok: status === "ok", status, kind: row.kind, ...probe };
}
