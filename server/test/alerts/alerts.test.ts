import { afterEach, describe, expect, it, vi } from "vitest";
import { ALERTS_EVAL_JOB } from "../../src/alerts/evaluate.ts";
import { ALERTS_SEND_JOB, MAX_ATTEMPTS } from "../../src/alerts/outbox.ts";
import { hex, hmacSha256 } from "../../src/crypto/hash.ts";
import { HOUSEKEEPING_JOBS } from "../../src/jobs.ts";
import { runJobs } from "../../src/jobs/runner.ts";
import type { Db } from "../../src/storage/types.ts";
import { createApp, errOf, world, type World } from "../apps/helpers.ts";
import type { Client } from "../auth/helpers.ts";

const ORG = "/api/orgs/acme/alerts";
const ADMIN = "/api/admin/alerts";
const HOOK = "https://hooks.example.com/in/s3cret-path";
const SIGNING = "signing-secret-0123456789";
const TG_TOKEN = "123456:AAtelegramtokentelegramtoken";
const MIN = 60_000;

interface Sent {
  url: string;
  init: RequestInit;
  body: string;
}

/** Answers DoH from `dns` (public by default) and records everything else. */
function net(w: World, respond: (url: string) => Response | Promise<Response> = () => new Response("ok")) {
  const dns: Record<string, string> = {};
  const sent: Sent[] = [];
  const lookups: string[] = [];
  w.app.deps.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith("https://cloudflare-dns.com/")) {
      const q = new URL(url).searchParams;
      lookups.push(q.get("name") ?? "");
      const answer = q.get("type") === "A" ? dns[q.get("name") ?? ""] ?? "93.184.216.34" : null;
      return Response.json({ Status: 0, Answer: answer ? [{ type: 1, data: answer }] : [] });
    }
    sent.push({ url, init, body: String(init.body ?? "") });
    return respond(url);
  }) as typeof fetch;
  return { dns, sent, lookups };
}

async function okJson<T = Record<string, unknown>>(res: Response, status = 201): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function channelOf(c: Client, base = ORG, url = HOOK): Promise<string> {
  const res = await c.call("POST", `${base}/channels`, { kind: "webhook", name: "ops", config: { url, secret: SIGNING } });
  return (await okJson<{ id: string }>(res)).id;
}

async function ruleOf(c: Client, body: Record<string, unknown>, base = ORG): Promise<string> {
  const res = await c.call("POST", `${base}/rules`, body);
  return (await okJson<{ id: string }>(res)).id;
}

const stat = (service: string, tenant: string, count = 200, errors = 40, dlq = 0) => ({ service, tenant, slug: "hello", count, errors, p50: null, p95: null, p99: null, dlq, depth: 0 });

async function appWorld() {
  const w = await world();
  const n = net(w);
  const { body } = await createApp(w.admin);
  const id = [...w.fake.services.values()].find((s) => s.view.slug === "hello")?.view.id ?? String(body.id);
  return { w, n, id };
}

const evalTick = async (w: World, ms = 121_000) => {
  w.app.tick(ms);
  return runJobs(w.app.deps, [ALERTS_EVAL_JOB]);
};
const sendTick = async (w: World, ms = 61_000) => {
  w.app.tick(ms);
  return runJobs(w.app.deps, [ALERTS_SEND_JOB]);
};
const db = (w: World) => w.app.deps.storage.db;
const outboxCount = async (w: World) => Number((await db(w).first<{ c: number }>("SELECT count(*) AS c FROM alert_outbox"))?.c);
const stateOf = (w: World, rule: string) => db(w).all<{ subject: string; state: string; last_sent_at: number | null }>("SELECT subject, state, last_sent_at FROM alert_state WHERE rule_id = ?", [rule]);
const channelRow = (w: World, id: string) => db(w).first<{ last_ok_at: number | null; last_error: string | null }>("SELECT last_ok_at, last_error FROM alert_channels WHERE id = ?", [id]);

/** Drives a firing app_error_rate rule to its first enqueue. */
async function firing(w: World, rule: string) {
  for (let i = 0; i < 4; i++) await evalTick(w);
  expect((await stateOf(w, rule))[0]?.state).toBe("firing");
}

afterEach(() => vi.restoreAllMocks());

describe("SSRF on the webhook URL", () => {
  const post = (c: Client, url: string) => c.call("POST", `${ORG}/channels`, { kind: "webhook", name: "x", config: { url, secret: SIGNING } });

  it.each([
    "http://hooks.example.com/x",
    "https://user:pw@hooks.example.com/x",
    "https://localhost/x",
    "https://svc.internal/x",
    "https://10.0.0.8/x",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/x",
    "https://[::ffff:7f00:1]/x",
    "https://2130706433/x",
    "https://0x7f.0.0.1/x",
    "https://localhost./x",
    "not a url",
  ])("refuses %s as written", async (url) => {
    const w = await world();
    const n = net(w);
    const res = await post(w.admin, url);
    expect(res.status).toBe(422);
    expect(n.sent).toEqual([]);
    expect(await db(w).first("SELECT 1 AS x FROM alert_channels")).toBeNull();
  });

  it("refuses a name that resolves to a private address, and stores nothing", async () => {
    const w = await world();
    const n = net(w);
    n.dns["hooks.example.com"] = "10.1.2.3";
    const res = await post(w.admin, HOOK);
    expect(res.status).toBe(422);
    expect((await errOf(res)).details?.fields).toEqual({ "config.url": "not_public" });
    expect(await db(w).first("SELECT 1 AS x FROM alert_channels")).toBeNull();
  });

  it("checks again at send time: a name rebound to a private address gets no request", async () => {
    const { w, n, id } = await appWorld();
    const ch = await channelOf(w.admin);
    const rule = await ruleOf(w.admin, { kind: "app_error_rate", channels: [ch], for_s: 0 });
    w.fake.nodeStats = [stat(id, w.org.tenant)];
    await evalTick(w);
    expect((await stateOf(w, rule))[0]?.state).toBe("firing");
    n.dns["hooks.example.com"] = "192.168.1.1";
    await sendTick(w);
    expect(n.sent).toEqual([]);
    expect((await channelRow(w, ch))?.last_error).toBe("blocked");
  });

  it("does not follow a redirect", async () => {
    const w = await world();
    const n = net(w, () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }));
    const ch = await channelOf(w.admin);
    const out = await okJson(await w.admin.call("POST", `${ORG}/channels/${ch}/test`), 200);
    expect(out).toEqual({ ok: false, status: "3xx" });
    expect(n.sent).toHaveLength(1);
    expect(n.sent[0]?.init.redirect).toBe("manual");
    expect((await channelRow(w, ch))?.last_error).toBe("3xx");
  });
});

describe("secrets", () => {
  it("seals the config, and returns or audits none of it", async () => {
    const w = await world();
    net(w);
    const created = await w.admin.call("POST", `${ORG}/channels`, { kind: "webhook", name: "ops", config: { url: HOOK, secret: SIGNING } });
    const tg = await w.admin.call("POST", `${ORG}/channels`, { kind: "telegram", name: "tg", config: { bot_token: TG_TOKEN, chat_id: "-100123" } });
    const list = await w.admin.call("GET", `${ORG}/channels`);
    const texts = [await created.text(), await tg.text(), await list.text()];
    expect(list.status).toBe(200);
    const rows = await db(w).all("SELECT * FROM alert_channels");
    const raw = rows.map((r) => Object.values(r).map((v) => (v instanceof Uint8Array ? new TextDecoder("latin1").decode(v) : String(v))).join("|"));
    const audits = await db(w).all("SELECT * FROM audit WHERE action LIKE 'alert.%'");
    expect(audits.length).toBe(2);
    for (const hay of [...texts, ...raw, JSON.stringify(audits)]) {
      for (const secret of [HOOK, "s3cret-path", SIGNING, TG_TOKEN]) expect(hay).not.toContain(secret);
    }
  });

  it("logs and stores only a status class when a send fails, whatever the error says", async () => {
    const w = await world();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    net(w, () => {
      throw new Error(`connect failed https://api.telegram.org/bot${TG_TOKEN}/sendMessage`);
    });
    const res = await w.admin.call("POST", `${ORG}/channels`, { kind: "telegram", name: "tg", config: { bot_token: TG_TOKEN, chat_id: "-100123" } });
    const { id } = await okJson<{ id: string }>(res);
    const out = await okJson(await w.admin.call("POST", `${ORG}/channels/${id}/test`), 200);
    expect(out).toEqual({ ok: false, status: "network" });
    expect((await channelRow(w, id))?.last_error).toBe("network");
    expect(JSON.stringify(log.mock.calls)).not.toContain(TG_TOKEN);
  });

  it("stores no response text", async () => {
    const w = await world();
    net(w, () => new Response(`denied ${SIGNING}`, { status: 403 }));
    const ch = await channelOf(w.admin);
    await w.admin.call("POST", `${ORG}/channels/${ch}/test`);
    expect((await channelRow(w, ch))?.last_error).toBe("4xx");
  });

  it("binds the sealed config to its row", async () => {
    const w = await world();
    const n = net(w);
    const a = await channelOf(w.admin);
    const b = await channelOf(w.admin);
    await db(w).run("UPDATE alert_channels SET config_sealed = (SELECT config_sealed FROM alert_channels WHERE id = ?) WHERE id = ?", [a, b]);
    const out = await okJson(await w.admin.call("POST", `${ORG}/channels/${b}/test`), 200);
    expect(out).toEqual({ ok: false, status: "config" });
    expect(n.sent).toEqual([]);
  });

  it("signs the exact body with X-Rtweb-Signature", async () => {
    const w = await world();
    const n = net(w);
    const ch = await channelOf(w.admin);
    await w.admin.call("POST", `${ORG}/channels/${ch}/test`);
    const req = n.sent[0] as Sent;
    const sig = new Headers(req.init.headers).get("x-rtweb-signature") ?? "";
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig);
    expect(m).not.toBeNull();
    expect(m?.[2]).toBe(hex(await hmacSha256(SIGNING, new TextEncoder().encode(`${m?.[1]}.${req.body}`))));
  });

  it("sends Telegram to the fixed host, with no markup and no DNS step", async () => {
    const w = await world();
    const n = net(w);
    const res = await w.admin.call("POST", `${ORG}/channels`, { kind: "telegram", name: "tg", config: { bot_token: TG_TOKEN, chat_id: "-100123" } });
    const { id } = await okJson<{ id: string }>(res);
    await w.admin.call("POST", `${ORG}/channels/${id}/test`);
    expect(n.sent[0]?.url).toBe(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`);
    expect(JSON.parse(n.sent[0]?.body ?? "{}")).not.toHaveProperty("parse_mode");
    expect(n.lookups).toEqual([]);
  });

  it("refuses a kind with no delivery yet, and a malformed Telegram config", async () => {
    const w = await world();
    net(w);
    const email = await w.admin.call("POST", `${ORG}/channels`, { kind: "email", name: "m", config: {} });
    expect(email.status).toBe(422);
    const bad = await w.admin.call("POST", `${ORG}/channels`, { kind: "telegram", name: "t", config: { bot_token: "../x", chat_id: "1" } });
    expect(bad.status).toBe(422);
  });
});

describe("IDOR and authorization", () => {
  it("refuses another org's channel on a rule, on create and on patch", async () => {
    const { w } = await appWorld();
    await w.addOrg("beta");
    const mine = await channelOf(w.admin);
    const theirs = await channelOf(w.admin, "/api/orgs/beta/alerts");
    const created = await w.admin.call("POST", `${ORG}/rules`, { kind: "build_failed", channels: [theirs] });
    expect(created.status).toBe(422);
    const rule = await ruleOf(w.admin, { kind: "build_failed", channels: [mine] });
    const patched = await w.admin.call("PATCH", `${ORG}/rules/${rule}`, { channels: [theirs] });
    expect(patched.status).toBe(422);
  });

  it("refuses an instance channel on an org rule, and an org channel on an instance rule", async () => {
    const w = await world();
    net(w);
    const inst = await channelOf(w.admin, ADMIN);
    const org = await channelOf(w.admin);
    expect((await w.admin.call("POST", `${ORG}/rules`, { kind: "build_failed", channels: [inst] })).status).toBe(422);
    expect((await w.admin.call("POST", `${ADMIN}/rules`, { kind: "disk_low", channels: [org] })).status).toBe(422);
  });

  it("does not reach another org's channel or rule through this org's path", async () => {
    const w = await world();
    net(w);
    await w.addOrg("beta");
    const theirs = await channelOf(w.admin, "/api/orgs/beta/alerts");
    const rule = await ruleOf(w.admin, { kind: "build_failed", channels: [theirs] }, "/api/orgs/beta/alerts");
    expect((await w.admin.call("PATCH", `${ORG}/channels/${theirs}`, { name: "x" })).status).toBe(404);
    expect((await w.admin.call("DELETE", `${ORG}/channels/${theirs}`)).status).toBe(404);
    expect((await w.admin.call("POST", `${ORG}/channels/${theirs}/test`)).status).toBe(404);
    expect((await w.admin.call("PATCH", `${ORG}/rules/${rule}`, { enabled: false })).status).toBe(404);
    expect((await w.admin.call("DELETE", `${ORG}/rules/${rule}`)).status).toBe(404);
    expect((await w.admin.call("DELETE", `${ADMIN}/channels/${theirs}`)).status).toBe(404);
  });

  it("refuses an App of another org on a rule", async () => {
    const { w } = await appWorld();
    await w.addOrg("beta");
    const ch = await channelOf(w.admin, "/api/orgs/beta/alerts");
    const res = await w.admin.call("POST", "/api/orgs/beta/alerts/rules", { kind: "app_error_rate", app: "hello", channels: [ch] });
    expect(res.status).toBe(404);
  });

  it("checks the channel again at send: a tampered rule delivers nothing", async () => {
    const { w, n, id } = await appWorld();
    await w.addOrg("beta");
    const mine = await channelOf(w.admin);
    const theirs = await channelOf(w.admin, "/api/orgs/beta/alerts");
    const rule = await ruleOf(w.admin, { kind: "app_error_rate", channels: [mine], for_s: 0 });
    await db(w).run("UPDATE alert_rules SET channels = ? WHERE id = ?", [JSON.stringify([theirs]), rule]);
    w.fake.nodeStats = [stat(id, w.org.tenant)];
    await evalTick(w);
    expect(await outboxCount(w)).toBe(1);
    await sendTick(w);
    expect(n.sent).toEqual([]);
    expect(await outboxCount(w)).toBe(0);
  });

  it("applies the roles: admins write, others get 403, outsiders 404, tokens are refused", async () => {
    const w = await world();
    net(w);
    const member = await w.user("m@example.com", "member", { default: "admin" });
    const owner = await w.user("o@example.com", "owner");
    const outsider = await w.user("x@example.com", null);
    expect((await owner.call("GET", `${ORG}/channels`)).status).toBe(200);
    expect((await member.call("GET", `${ORG}/channels`)).status).toBe(403);
    expect((await member.call("POST", `${ORG}/channels`, { kind: "webhook", name: "x", config: { url: HOOK, secret: SIGNING } })).status).toBe(403);
    expect((await outsider.call("GET", `${ORG}/rules`)).status).toBe(404);
    expect((await owner.call("GET", `${ADMIN}/channels`)).status).toBe(403);
    const bearer = await w.app.call("GET", `${ORG}/channels`, { headers: { authorization: "Bearer rtw_nope" } });
    expect(bearer.status).toBe(403);
  });

  it("keeps one org's rows to itself", async () => {
    const w = await world();
    net(w);
    await w.addOrg("beta");
    await channelOf(w.admin, "/api/orgs/beta/alerts");
    expect(await okJson<{ items: unknown[] }>(await w.admin.call("GET", `${ORG}/channels`), 200)).toEqual({ items: [] });
    expect(await okJson<{ items: unknown[] }>(await w.admin.call("GET", `${ADMIN}/channels`), 200)).toEqual({ items: [] });
  });

  it("ignores stats of a service in another tenant", async () => {
    const { w, id } = await appWorld();
    const ch = await channelOf(w.admin);
    const rule = await ruleOf(w.admin, { kind: "app_error_rate", channels: [ch], for_s: 0 });
    w.fake.nodeStats = [stat(id, "ten_other"), stat("svc_unknown", w.org.tenant)];
    await evalTick(w);
    expect(await stateOf(w, rule)).toEqual([]);
  });

  it("forgets everything with the org", async () => {
    const w = await world();
    net(w);
    const ch = await channelOf(w.admin);
    await ruleOf(w.admin, { kind: "build_failed", channels: [ch] });
    expect((await w.admin.call("DELETE", "/api/admin/orgs/acme", { confirm: "acme" })).status).toBeLessThan(300);
    expect(await db(w).first("SELECT 1 AS x FROM alert_channels")).toBeNull();
    expect(await db(w).first("SELECT 1 AS x FROM alert_rules")).toBeNull();
  });

  it("limits test sends and caps channels", async () => {
    const w = await world();
    net(w);
    const ch = await channelOf(w.admin);
    for (let i = 0; i < 5; i++) expect((await w.admin.call("POST", `${ORG}/channels/${ch}/test`)).status).toBe(200);
    const limited = await w.admin.call("POST", `${ORG}/channels/${ch}/test`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    w.app.tick(MIN + 1);
    expect((await w.admin.call("POST", `${ORG}/channels/${ch}/test`)).status).toBe(200);
    for (let i = 0; i < 19; i++) await channelOf(w.admin);
    expect((await w.admin.call("POST", `${ORG}/channels`, { kind: "webhook", name: "x", config: { url: HOOK, secret: SIGNING } })).status).toBe(409);
  });

  it("refuses to delete a channel a rule uses", async () => {
    const w = await world();
    net(w);
    const ch = await channelOf(w.admin);
    const rule = await ruleOf(w.admin, { kind: "build_failed", channels: [ch] });
    expect((await w.admin.call("DELETE", `${ORG}/channels/${ch}`)).status).toBe(409);
    expect((await w.admin.call("DELETE", `${ORG}/rules/${rule}`)).status).toBe(204);
    expect((await w.admin.call("DELETE", `${ORG}/channels/${ch}`)).status).toBe(204);
  });
});

describe("state and dedupe", () => {
  it("goes ok, pending, firing after for_s, and notifies once until repeat_s", async () => {
    const { w, n, id } = await appWorld();
    const ch = await channelOf(w.admin);
    const rule = await ruleOf(w.admin, { kind: "app_error_rate", channels: [ch], for_s: 300, repeat_s: 3600 });
    w.fake.nodeStats = [stat(id, w.org.tenant)];
    await evalTick(w);
    expect((await stateOf(w, rule))[0]?.state).toBe("pending");
    expect(await outboxCount(w)).toBe(0);
    await firing(w, rule);
    await sendTick(w, 0);
    expect(n.sent).toHaveLength(1);
    const body = JSON.parse(n.sent[0]?.body ?? "{}");
    expect(body).toMatchObject({ event: "firing", kind: "app_error_rate", subject: "hello", value: 20 });
    for (let i = 0; i < 10; i++) {
      await evalTick(w);
      await sendTick(w, 0);
    }
    expect(n.sent).toHaveLength(1);
    w.app.tick(3600_000);
    await evalTick(w);
    await sendTick(w);
    expect(n.sent).toHaveLength(2);
    expect(JSON.parse(n.sent[1]?.body ?? "{}").event).toBe("repeat");
  });

  it("needs the minimum volume", async () => {
    const { w, id } = await appWorld();
    const ch = await channelOf(w.admin);
    const rule = await ruleOf(w.admin, { kind: "app_error_rate", channels: [ch], for_s: 0 });
    w.fake.nodeStats = [stat(id, w.org.tenant, 99, 99)];
    await evalTick(w);
    expect(await stateOf(w, rule)).toEqual([]);
  });

  it("resolves once, after the condition has been clear for 2x for_s, and a flap sends nothing", async () => {
    const { w, n, id } = await appWorld();
    const ch = await channelOf(w.admin);
    const rule = await ruleOf(w.admin, { kind: "app_error_rate", channels: [ch], for_s: 300, repeat_s: 86400 });
    w.fake.nodeStats = [stat(id, w.org.tenant)];
    await firing(w, rule);
    await sendTick(w, 0);
    w.fake.nodeStats = [];
    await evalTick(w);
    w.fake.nodeStats = [stat(id, w.org.tenant)];
    await evalTick(w);
    w.fake.nodeStats = [];
    for (let i = 0; i < 4; i++) await evalTick(w);
    expect((await stateOf(w, rule))[0]?.state).toBe("firing");
    expect(await outboxCount(w)).toBe(0);
    for (let i = 0; i < 2; i++) await evalTick(w);
    expect((await stateOf(w, rule))[0]?.state).toBe("ok");
    await sendTick(w);
    for (let i = 0; i < 5; i++) await evalTick(w);
    await sendTick(w);
    expect(n.sent.map((s) => JSON.parse(s.body).event)).toEqual(["firing", "resolved"]);
  });

  it("a pending condition that clears notifies nobody", async () => {
    const { w, n, id } = await appWorld();
    const ch = await channelOf(w.admin);
    const rule = await ruleOf(w.admin, { kind: "app_error_rate", channels: [ch], for_s: 300 });
    w.fake.nodeStats = [stat(id, w.org.tenant)];
    await evalTick(w);
    w.fake.nodeStats = [];
    await evalTick(w);
    expect((await stateOf(w, rule))[0]?.state).toBe("ok");
    await sendTick(w);
    expect(n.sent).toEqual([]);
  });

  it("stopping backups raises exactly one backup_stale and one resolve", async () => {
    const w = await world();
    const n = net(w);
    const ch = await channelOf(w.admin, ADMIN);
    await ruleOf(w.admin, { kind: "backup_stale", channels: [ch], for_s: 0, repeat_s: 604800 }, ADMIN);
    w.fake.backupStatusOver = { enabled: true, last_ok_at: w.app.deps.now() };
    await evalTick(w);
    await sendTick(w);
    expect(n.sent).toEqual([]);
    w.app.tick(27 * 3600_000);
    for (let i = 0; i < 3; i++) {
      await evalTick(w);
      await sendTick(w);
    }
    expect(n.sent).toHaveLength(1);
    w.fake.backupStatusOver = { enabled: true, last_ok_at: w.app.deps.now() };
    for (let i = 0; i < 4; i++) {
      await evalTick(w);
      await sendTick(w);
    }
    expect(n.sent.map((s) => JSON.parse(s.body).event)).toEqual(["firing", "resolved"]);
  });

  it("does not call a disabled backup stale", async () => {
    const w = await world();
    net(w);
    const ch = await channelOf(w.admin, ADMIN);
    const rule = await ruleOf(w.admin, { kind: "backup_stale", channels: [ch], for_s: 0 }, ADMIN);
    w.fake.backupStatusOver = { enabled: false, last_ok_at: null };
    w.app.tick(30 * 3600_000);
    await evalTick(w);
    expect(await stateOf(w, rule)).toEqual([]);
  });

  it("reads disk_low from the node, and an absent figure says nothing", async () => {
    const w = await world();
    net(w);
    const ch = await channelOf(w.admin, ADMIN);
    const rule = await ruleOf(w.admin, { kind: "disk_low", channels: [ch], for_s: 0 }, ADMIN);
    await evalTick(w);
    expect(await stateOf(w, rule)).toEqual([]);
    w.fake.nodeHost = { disk: { free_bytes: 10, total_bytes: 100 } };
    await evalTick(w);
    expect((await stateOf(w, rule))[0]?.state).toBe("firing");
    w.fake.nodeHost = {};
    for (let i = 0; i < 4; i++) await evalTick(w);
    expect((await stateOf(w, rule))[0]?.state).toBe("firing");
  });

  it("fires build_failed once per version, only for its own org", async () => {
    const { w, n, id } = await appWorld();
    const ch = await channelOf(w.admin);
    await ruleOf(w.admin, { kind: "build_failed", channels: [ch] });
    const at = w.app.deps.now() + 1;
    const ev = (eid: number, service: string, version: number, tenant: string | null = null) => ({ id: eid, ts: at, tenant, service, kind: "build.failed", data: { version, reason: `leak ${SIGNING}` } });
    w.fake.nodeEvents = [ev(1, id, 3), ev(2, id, 3), ev(3, "svc_other", 3), ev(4, id, 9, "ten_other")];
    await evalTick(w);
    await evalTick(w);
    await sendTick(w);
    expect(n.sent).toHaveLength(1);
    expect(n.sent[0]?.body).not.toContain(SIGNING);
    expect(JSON.parse(n.sent[0]?.body ?? "{}")).toMatchObject({ event: "firing", subject: "hello", value: 3 });
    w.fake.nodeEvents.push(ev(5, id, 4));
    await evalTick(w);
    await sendTick(w);
    expect(n.sent).toHaveLength(2);
  });

  it("ignores build failures from before the rule", async () => {
    const { w, id } = await appWorld();
    w.fake.nodeEvents = [{ id: 1, ts: w.app.deps.now() - 1000, tenant: null, service: id, kind: "build.failed", data: { version: 1 } }];
    const ch = await channelOf(w.admin);
    await ruleOf(w.admin, { kind: "build_failed", channels: [ch] });
    await evalTick(w);
    expect(await outboxCount(w)).toBe(0);
  });

  it("alerts when dead letters grew over the window, and not on letters already there", async () => {
    const { w, id } = await appWorld();
    const ch = await channelOf(w.admin);
    const rule = await ruleOf(w.admin, { kind: "dlq_growth", channels: [ch], for_s: 0 });
    w.fake.nodeStats = [stat(id, w.org.tenant, 0, 0, 5)];
    await evalTick(w);
    expect(await outboxCount(w)).toBe(0);
    w.app.tick(16 * MIN);
    await evalTick(w);
    expect(await outboxCount(w)).toBe(0);
    w.fake.nodeStats = [stat(id, w.org.tenant, 0, 0, 7)];
    w.app.tick(16 * MIN);
    await evalTick(w);
    expect((await stateOf(w, rule))[0]?.state).toBe("firing");
    expect(await outboxCount(w)).toBe(1);
  });

  it("a muted rule sends nothing, a disabled one forgets its state", async () => {
    const { w, id } = await appWorld();
    const ch = await channelOf(w.admin);
    const rule = await ruleOf(w.admin, { kind: "app_error_rate", channels: [ch], for_s: 0 });
    await okJson(await w.admin.call("PATCH", `${ORG}/rules/${rule}`, { muted_until: w.app.deps.now() + 3600_000 }), 200);
    w.fake.nodeStats = [stat(id, w.org.tenant)];
    await evalTick(w);
    expect(await outboxCount(w)).toBe(0);
    await okJson(await w.admin.call("PATCH", `${ORG}/rules/${rule}`, { muted_until: null }), 200);
    await evalTick(w);
    expect(await outboxCount(w)).toBe(1);
    const active = await okJson<{ items: { subject: string; state: string }[] }>(await w.admin.call("GET", `${ORG}/active`), 200);
    expect(active.items).toMatchObject([{ subject: "hello", state: "firing", kind: "app_error_rate" }]);
    await okJson(await w.admin.call("PATCH", `${ORG}/rules/${rule}`, { enabled: false }), 200);
    expect(await stateOf(w, rule)).toEqual([]);
  });
});

describe("crashes", () => {
  it("a crash between the state write and the send loses nothing and sends once", async () => {
    const { w, n, id } = await appWorld();
    const ch = await channelOf(w.admin);
    await ruleOf(w.admin, { kind: "app_error_rate", channels: [ch], for_s: 0 });
    w.fake.nodeStats = [stat(id, w.org.tenant)];
    await evalTick(w);
    expect(n.sent).toEqual([]);
    expect(await outboxCount(w)).toBe(1);
    await sendTick(w);
    await sendTick(w, 7200_000);
    expect(n.sent).toHaveLength(1);
    expect(await outboxCount(w)).toBe(0);
  });

  it("moves the state and the outbox together", async () => {
    const { w, id } = await appWorld();
    const ch = await channelOf(w.admin);
    const rule = await ruleOf(w.admin, { kind: "app_error_rate", channels: [ch], for_s: 0 });
    w.fake.nodeStats = [stat(id, w.org.tenant)];
    const real = w.app.deps.storage.db;
    const failing: Db = {
      ...real,
      tx: (fn) => real.tx((tx) => fn({
        all: tx.all,
        run: (q, a) => (q.includes("alert_outbox") ? Promise.reject(new Error("crash")) : tx.run(q, a)),
      })),
    };
    w.app.deps.storage = { ...w.app.deps.storage, db: failing };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await evalTick(w);
    w.app.deps.storage = { ...w.app.deps.storage, db: real };
    expect(await stateOf(w, rule)).toEqual([]);
    w.app.tick(600_000);
    await evalTick(w);
    expect(await outboxCount(w)).toBe(1);
  });

  it("a crash after the send repeats it at most MAX_ATTEMPTS times", async () => {
    const { w, n, id } = await appWorld();
    const ch = await channelOf(w.admin);
    await ruleOf(w.admin, { kind: "app_error_rate", channels: [ch], for_s: 0 });
    w.fake.nodeStats = [stat(id, w.org.tenant)];
    await evalTick(w);
    const real = w.app.deps.storage.db;
    const crashing: Db = { ...real, run: (q, a) => (q.startsWith("DELETE FROM alert_outbox") ? Promise.reject(new Error("crash")) : real.run(q, a)) };
    w.app.deps.storage = { ...w.app.deps.storage, db: crashing };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (let i = 0; i < 30; i++) await sendTick(w, 7200_000);
    expect(n.sent).toHaveLength(MAX_ATTEMPTS);
    const ids = new Set(n.sent.map((s) => new Headers(s.init.headers).get("x-rtweb-delivery")));
    expect(ids.size).toBe(1);
    w.app.deps.storage = { ...w.app.deps.storage, db: real };
    await sendTick(w, 7200_000);
    expect(n.sent).toHaveLength(MAX_ATTEMPTS);
    expect(await outboxCount(w)).toBe(0);
  });

  it("retries a failed send with backoff, then gives up", async () => {
    const { w, id } = await appWorld();
    let calls = 0;
    const n = net(w, () => {
      calls++;
      return new Response("", { status: 500 });
    });
    void n;
    const ch = await channelOf(w.admin);
    await ruleOf(w.admin, { kind: "app_error_rate", channels: [ch], for_s: 0 });
    w.fake.nodeStats = [stat(id, w.org.tenant)];
    await evalTick(w);
    await sendTick(w);
    expect(calls).toBe(1);
    await sendTick(w, 1000);
    expect(calls).toBe(1);
    for (let i = 0; i < 20; i++) await sendTick(w, 7200_000);
    expect(calls).toBe(MAX_ATTEMPTS);
    expect(await outboxCount(w)).toBe(0);
    expect((await channelRow(w, ch))?.last_error).toBe("5xx");
  });
});

describe("budget", () => {
  const none = { wallMs: 20_000, fetches: 0 };

  it("no budget for the read: no alert, no state, no resolve", async () => {
    const { w, id } = await appWorld();
    const ch = await channelOf(w.admin);
    const rule = await ruleOf(w.admin, { kind: "app_error_rate", channels: [ch], for_s: 0 });
    w.fake.nodeStats = [stat(id, w.org.tenant)];
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    w.app.tick(121_000);
    expect((await runJobs(w.app.deps, [ALERTS_EVAL_JOB], none)).stopped).toBe("budget_exhausted");
    expect(await stateOf(w, rule)).toEqual([]);
    expect(await outboxCount(w)).toBe(0);
    await evalTick(w);
    expect((await stateOf(w, rule))[0]?.state).toBe("firing");
    w.fake.nodeStats = [];
    for (let i = 0; i < 6; i++) {
      w.app.tick(121_000);
      await runJobs(w.app.deps, [ALERTS_EVAL_JOB], none);
    }
    expect((await stateOf(w, rule))[0]?.state).toBe("firing");
    expect(await outboxCount(w)).toBe(1);
  });

  it("a stats read cut off by the budget does not resolve what it did not reach", async () => {
    const { w, id } = await appWorld();
    const ch = await channelOf(w.admin);
    const rule = await ruleOf(w.admin, { kind: "app_error_rate", channels: [ch], for_s: 0 });
    w.fake.nodeStats = [stat(id, w.org.tenant)];
    await evalTick(w);
    await db(w).run("DELETE FROM alert_outbox");
    // The firing App now sits past the first page.
    w.fake.nodeStats = [...Array.from({ length: 200 }, (_, i) => stat(`svc_${i}`, w.org.tenant)), stat(id, w.org.tenant, 1, 0)];
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (let i = 0; i < 5; i++) {
      w.app.tick(121_000);
      await runJobs(w.app.deps, [ALERTS_EVAL_JOB], { wallMs: 20_000, fetches: 1 });
      await db(w).run("UPDATE job_state SET cursor = NULL WHERE name = ?", [ALERTS_EVAL_JOB.name]);
    }
    expect((await stateOf(w, rule))[0]?.state).toBe("firing");
    expect(await outboxCount(w)).toBe(0);
  });

  it("finishes a long read across ticks, and only then clears", async () => {
    const { w, id } = await appWorld();
    const ch = await channelOf(w.admin);
    const rule = await ruleOf(w.admin, { kind: "app_error_rate", channels: [ch], for_s: 0 });
    w.fake.nodeStats = [stat(id, w.org.tenant)];
    await evalTick(w);
    w.fake.nodeStats = Array.from({ length: 450 }, (_, i) => stat(`svc_${i}`, w.org.tenant));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const clearSince = async () => (await db(w).first<{ clear_since: number | null }>("SELECT clear_since FROM alert_state WHERE rule_id = ?", [rule]))?.clear_since;
    for (let i = 0; i < 2; i++) {
      w.app.tick(121_000);
      await runJobs(w.app.deps, [ALERTS_EVAL_JOB], { wallMs: 20_000, fetches: 1 });
      expect(await clearSince()).toBeNull();
    }
    w.app.tick(121_000);
    await runJobs(w.app.deps, [ALERTS_EVAL_JOB], { wallMs: 20_000, fetches: 1 });
    expect(w.fake.nodeStatsQueries.slice(-3).map((q) => q.cursor ?? "")).toEqual(["", "200", "400"]);
    expect(await clearSince()).not.toBeNull();
  });

  it("a node that cannot answer changes nothing", async () => {
    const { w, id } = await appWorld();
    const ch = await channelOf(w.admin);
    const rule = await ruleOf(w.admin, { kind: "app_error_rate", channels: [ch], for_s: 0 });
    w.fake.nodeStats = [stat(id, w.org.tenant)];
    await evalTick(w);
    await db(w).run("DELETE FROM alert_outbox");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const realOp = w.fake.op.bind(w.fake);
    w.fake.op = async (req) => {
      if (req.path === "/v1/node/stats") return { status: 500, headers: {}, body: { error: { code: "internal", message: "down" } } };
      return realOp(req);
    };
    for (let i = 0; i < 6; i++) await evalTick(w, 7200_000);
    expect((await stateOf(w, rule))[0]?.state).toBe("firing");
    expect(await outboxCount(w)).toBe(0);
  });

  it("a send refused by the budget is not charged to the row", async () => {
    const { w, n, id } = await appWorld();
    const ch = await channelOf(w.admin);
    await ruleOf(w.admin, { kind: "app_error_rate", channels: [ch], for_s: 0 });
    w.fake.nodeStats = [stat(id, w.org.tenant)];
    await evalTick(w);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    w.app.tick(61_000);
    await runJobs(w.app.deps, [ALERTS_SEND_JOB], none);
    expect(n.sent).toEqual([]);
    const row = await db(w).first<{ attempts: number }>("SELECT attempts FROM alert_outbox");
    expect(row?.attempts).toBe(0);
    expect((await channelRow(w, ch))?.last_error).toBeNull();
    await sendTick(w);
    expect(n.sent).toHaveLength(1);
  });
});

describe("the send job", () => {
  it("runs after the evaluation and last of all the jobs", () => {
    const names = HOUSEKEEPING_JOBS.map((j) => j.name);
    expect(names.at(-1)).toBe(ALERTS_SEND_JOB.name);
    expect(names.indexOf(ALERTS_EVAL_JOB.name)).toBeGreaterThan(names.indexOf("metric_rollups"));
    expect(names.indexOf(ALERTS_EVAL_JOB.name)).toBeLessThan(names.indexOf(ALERTS_SEND_JOB.name));
  });

  const seed = async (w: World, channel: string, orgId: string | null, n: number) => {
    for (let i = 0; i < n; i++) {
      await db(w).run("INSERT INTO alert_outbox (id, channel_id, org_id, rule_id, body, attempts, next_at) VALUES (?, ?, ?, NULL, ?, 0, 0)", [`${channel}-${i}`, channel, orgId, JSON.stringify({ event: "firing", kind: "disk_low", subject: `s${i}` })]);
    }
  };

  it("folds a storm on one channel into one digest", async () => {
    const w = await world();
    const n = net(w);
    const ch = await channelOf(w.admin, ADMIN);
    await seed(w, ch, null, 12);
    await sendTick(w);
    expect(n.sent).toHaveLength(1);
    expect(JSON.parse(n.sent[0]?.body ?? "{}")).toMatchObject({ event: "digest", count: 12 });
    expect(await outboxCount(w)).toBe(0);
  });

  it("shares a tick between orgs, with the cap of 20 sends", async () => {
    const w = await world();
    const n = net(w);
    await w.addOrg("beta");
    const a = await channelOf(w.admin, ORG, "https://a.example.com/x");
    const a2 = await channelOf(w.admin, ORG, "https://a.example.com/y");
    const b = await channelOf(w.admin, "/api/orgs/beta/alerts", "https://b.example.com/x");
    await seed(w, a, "org_acme", 4);
    await seed(w, a2, "org_acme", 4);
    await seed(w, b, "org_beta", 2);
    await sendTick(w);
    const toA = n.sent.filter((s) => s.url.includes("a.example.com")).length;
    const toB = n.sent.filter((s) => s.url.includes("b.example.com")).length;
    expect(toB).toBe(2);
    expect(toA).toBe(5);
    await sendTick(w);
    expect(n.sent.length).toBe(10);
  });

  it("stops at the first failure of a slow channel in one tick", async () => {
    const w = await world();
    let calls = 0;
    net(w, () => {
      calls++;
      throw new Error("timeout");
    });
    const ch = await channelOf(w.admin, ADMIN);
    await seed(w, ch, null, 3);
    await sendTick(w);
    expect(calls).toBe(1);
  });

  it("drops a row whose channel is gone", async () => {
    const w = await world();
    const n = net(w);
    await seed(w, "ach_gone", null, 1);
    await sendTick(w);
    expect(n.sent).toEqual([]);
    expect(await outboxCount(w)).toBe(0);
  });

  it("updates a webhook only with a whole new config, and validates it", async () => {
    const w = await world();
    const n = net(w);
    const ch = await channelOf(w.admin);
    expect((await w.admin.call("PATCH", `${ORG}/channels/${ch}`, { config: { url: "https://10.0.0.1/x", secret: SIGNING } })).status).toBe(422);
    expect((await w.admin.call("PATCH", `${ORG}/channels/${ch}`, { config: { url: "https://new.example.com/x" } })).status).toBe(422);
    await okJson(await w.admin.call("PATCH", `${ORG}/channels/${ch}`, { name: "renamed", config: { url: "https://new.example.com/x", secret: SIGNING } }), 200);
    await w.admin.call("POST", `${ORG}/channels/${ch}/test`);
    expect(n.sent[0]?.url).toBe("https://new.example.com/x");
  });

  it("validates rule fields", async () => {
    const w = await world();
    net(w);
    const ch = await channelOf(w.admin);
    for (const body of [
      { kind: "nope", channels: [ch] },
      { kind: "disk_low", channels: [ch] },
      { kind: "build_failed", channels: [] },
      { kind: "build_failed", channels: [ch, ch] },
      { kind: "build_failed", channels: [ch], for_s: -1 },
      { kind: "build_failed", channels: [ch], repeat_s: 1 },
      { kind: "app_error_rate", channels: [ch], params: { threshold_pct: 500 } },
      { kind: "build_failed", channels: [ch], extra: 1 },
    ]) {
      expect((await w.admin.call("POST", `${ORG}/rules`, body)).status, JSON.stringify(body)).toBe(422);
    }
    const inst = await channelOf(w.admin, ADMIN);
    expect((await w.admin.call("POST", `${ADMIN}/rules`, { kind: "app_error_rate", channels: [inst] })).status).toBe(422);
  });
});
