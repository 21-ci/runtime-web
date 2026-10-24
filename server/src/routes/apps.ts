// /api/orgs/{org}/apps… (api-web §8.1–8.4, §8.6). Port of internal/api/routes_apps.go
// and routes_stream.go. Domains (§8.5) belong to T8.

import type { Deps } from "../app.ts";
import { authOf, requireSession, withRetryAfter } from "../auth/middleware.ts";
import { AppError, badRequest, invalid } from "../http/errors.ts";
import { json, noContent, readJson } from "../http/json.ts";
import type { Handler, RequestContext, Router } from "../http/router.ts";
import { orgAccess } from "../orgs/members.ts";
import { audit as writeAudit } from "../audit/audit.ts";
import { rt } from "../runtime/errors.ts";
import * as A from "../apps/service.ts";
import { LOG_RANK, sseResponse } from "../apps/logs.ts";
import type * as T from "../runtime/types.ts";

type AppHandler = (c: A.OrgCtx, ctx: RequestContext) => Promise<Response>;

/** Body cap for PUT …/files (runtime request body cap is 10 MB). */
const MAX_FILES_BODY = 10 << 20;

export function registerApps(router: Router, deps: Deps): void {
  const route = (h: AppHandler): Handler =>
    withRetryAfter(
      requireSession(deps, async (ctx) => {
        const { user } = authOf(ctx);
        const { org, subject, actor } = await orgAccess(deps, user, ctx.params.org ?? "");
        const cli = await A.orgClient(deps, org);
        return h({ deps, org, sub: subject, actor, cli }, ctx);
      }),
    );
  const base = "/api/orgs/:org/apps";
  const one = `${base}/:app`;
  const slug = (ctx: RequestContext) => ctx.params.app ?? "";

  router.get(base, route(async (c, ctx) => {
    const q = ctx.url.searchParams;
    const { offset, limit } = pageParams(q);
    const list = await A.listApps(c, q.get("project") ?? "", q.get("environment") ?? "");
    const end = Math.min(offset + limit, list.length);
    return json({ items: list.slice(Math.min(offset, list.length), end), next_cursor: end < list.length ? String(end) : null });
  }));

  router.post(base, route(async (c, ctx) => {
    const b = await readJson(ctx.req);
    const fields: Record<string, string> = {};
    const s = (k: string) => {
      const v = b[k];
      if (typeof v !== "string" || v === "") fields[k] = "required";
      return typeof v === "string" ? v : "";
    };
    const input = { project: s("project"), environment: s("environment"), slug: s("slug"), template: s("template") };
    if (b.name !== undefined && b.name !== null && typeof b.name !== "string") fields.name = "not_string";
    if (Object.keys(fields).length) throw invalid(fields);
    const { value, etag } = await A.createApp(c, { ...input, ...(typeof b.name === "string" && b.name ? { name: b.name } : {}) });
    await audit(c, "app.create", input.slug, { project: input.project, environment: input.environment, template: input.template });
    return appResponse(c, value, etag, 201);
  }));

  router.get(one, route(async (c, ctx) => {
    const { value, etag } = await A.getApp(c, slug(ctx));
    return appResponse(c, value, etag, 200);
  }));

  router.patch(one, route(async (c, ctx) => {
    const b = await readJson(ctx.req);
    const patch = A.toServicePatch(b);
    const svc = await A.updateApp(c, slug(ctx), patch, A.ifMatch(ctx.req));
    await audit(c, "app.update", slug(ctx), Object.fromEntries(Object.keys(patch).map((k) => [k, true])));
    return appResponse(c, svc, svc.etag, 200);
  }));

  router.delete(one, route(async (c, ctx) => {
    await A.deleteApp(c, slug(ctx));
    await audit(c, "app.delete", slug(ctx), null);
    return noContent();
  }));

  // ---- code and versions ----

  router.get(`${one}/files`, route(async (c, ctx) => {
    const raw = ctx.url.searchParams.get("version");
    let v = 0;
    if (raw !== null && raw !== "") {
      v = Number(raw);
      if (!Number.isInteger(v) || v < 1) throw invalid({ version: "out_of_range" });
    }
    return json(await A.getFiles(c, slug(ctx), v));
  }));

  router.put(`${one}/files`, route(async (c, ctx) => {
    const b = await readBig(ctx.req, MAX_FILES_BODY);
    const out = await A.saveFiles(c, slug(ctx), b.entry, b.files, A.ifMatch(ctx.req));
    await audit(c, "app.deploy", slug(ctx), { version: out.version.version });
    return json(out, 200, etagHeader(out.etag));
  }));

  router.get(`${one}/versions`, route(async (c, ctx) => json({ items: await A.listVersions(c, slug(ctx)) })));

  router.put(`${one}/live`, route(async (c, ctx) => {
    const b = await readJson(ctx.req);
    if (typeof b.version !== "number" || !Number.isInteger(b.version) || b.version < 1) throw invalid({ version: "out_of_range" });
    const out = await A.promote(c, slug(ctx), b.version, A.ifMatch(ctx.req));
    await audit(c, "app.live", slug(ctx), { version: b.version });
    return json(out, 200, etagHeader(out.etag));
  }));

  router.get(`${one}/versions/:v/build-logs`, route(async (c, ctx) => json({ items: await A.buildLogs(c, slug(ctx), versionParam(ctx)) })));

  router.post(`${one}/versions/:v/rebuild`, route(async (c, ctx) => {
    const v = versionParam(ctx);
    const out = await A.rebuild(c, slug(ctx), v);
    await audit(c, "app.rebuild", slug(ctx), { version: v });
    return json({ ...out, build_state: out.build_state === "ready" ? out.build_state : "building" }, 202);
  }));

  // ---- env, secrets ----

  router.get(`${one}/env`, route(async (c, ctx) => {
    const app = await A.appFor(c, slug(ctx), "app.read");
    return json({ env: (await rt(() => c.cli.getEnv(app.id))) ?? {} });
  }));

  router.put(`${one}/env`, route(async (c, ctx) => {
    const b = await readJson(ctx.req);
    const env = b.env;
    if (!env || typeof env !== "object" || Array.isArray(env)) throw invalid({ env: "required" });
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) if (typeof v !== "string") fields[`env.${k}`] = "not_string";
    if (Object.keys(fields).length) throw invalid(fields);
    const app = await A.appFor(c, slug(ctx), "app.env.write");
    const out = await rt(() => c.cli.putEnv(app.id, env as Record<string, string>));
    await audit(c, "app.env", slug(ctx), { keys: Object.keys(env) });
    return json({ env: out ?? {} });
  }));

  router.get(`${one}/secrets`, route(async (c, ctx) => {
    const app = await A.appFor(c, slug(ctx), "app.read");
    return json({ items: (await rt(() => c.cli.listSecrets(app.id))) ?? [] });
  }));

  router.put(`${one}/secrets/:name`, route(async (c, ctx) => {
    const b = await readJson(ctx.req);
    if (typeof b.value !== "string") throw invalid({ value: "required" });
    const app = await A.appFor(c, slug(ctx), "app.secrets.write");
    await rt(() => c.cli.putSecret(app.id, ctx.params.name ?? "", b.value as string));
    await audit(c, "app.secret.set", slug(ctx), { name: ctx.params.name });
    return noContent();
  }));

  router.delete(`${one}/secrets/:name`, route(async (c, ctx) => {
    const app = await A.appFor(c, slug(ctx), "app.secrets.write");
    await rt(() => c.cli.deleteSecret(app.id, ctx.params.name ?? ""));
    await audit(c, "app.secret.delete", slug(ctx), { name: ctx.params.name });
    return noContent();
  }));

  // ---- schedules ----

  router.get(`${one}/schedules`, route(async (c, ctx) => {
    const app = await A.appFor(c, slug(ctx), "app.read");
    return json({ items: (await rt(() => c.cli.listSchedules(app.id))) ?? [] });
  }));

  router.get(`${one}/schedules/once`, route(async (c, ctx) => {
    const app = await A.appFor(c, slug(ctx), "app.read");
    const items: T.OnceSchedule[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await rt(() => c.cli.listOnceSchedules(app.id, cursor));
      items.push(...page.items);
      if (!page.next_cursor || page.next_cursor === cursor) break;
      cursor = page.next_cursor;
    }
    return json({ items });
  }));

  router.post(`${one}/schedules`, route(async (c, ctx) => {
    const b = await readJson(ctx.req);
    const app = await A.appFor(c, slug(ctx), "app.schedules.write");
    const sch = await rt(() => c.cli.createSchedule(app.id, scheduleBody(b, true) as T.ScheduleBody));
    await audit(c, "app.schedule.create", slug(ctx), { id: sch.id, kind: sch.kind });
    return json(sch, 201);
  }));

  router.patch(`${one}/schedules/:id`, route(async (c, ctx) => {
    const b = await readJson(ctx.req);
    const id = ctx.params.id ?? "";
    const app = await A.appFor(c, slug(ctx), "app.schedules.write");
    // The runtime takes a full body: merge the patch into the current schedule.
    const cur = ((await rt(() => c.cli.listSchedules(app.id))) ?? []).find((s) => s.id === id);
    if (!cur) throw new AppError(404, "not_found", "not found");
    const full: T.ScheduleBody = { kind: cur.kind, enabled: cur.enabled, payload: cur.payload };
    if (cur.cron !== null) full.cron = cur.cron;
    if (cur.every_seconds !== null) full.every_seconds = cur.every_seconds;
    if (cur.timezone !== null) full.timezone = cur.timezone;
    const sch = await rt(() => c.cli.updateSchedule(app.id, id, { ...full, ...scheduleBody(b, false) }));
    await audit(c, "app.schedule.update", slug(ctx), { id });
    return json(sch);
  }));

  router.delete(`${one}/schedules/:id`, route(async (c, ctx) => {
    const app = await A.appFor(c, slug(ctx), "app.schedules.write");
    await rt(() => c.cli.deleteSchedule(app.id, ctx.params.id ?? ""));
    await audit(c, "app.schedule.delete", slug(ctx), { id: ctx.params.id });
    return noContent();
  }));

  // ---- queue ----

  router.get(`${one}/queue`, route(async (c, ctx) => {
    const app = await A.appFor(c, slug(ctx), "app.read");
    return json(await rt(() => c.cli.queueStats(app.id)));
  }));

  router.post(`${one}/queue`, route(async (c, ctx) => {
    const b = await readJson(ctx.req);
    const fields: Record<string, string> = {};
    if (!("body" in b)) fields.body = "required";
    if (b.delay_seconds !== undefined && (typeof b.delay_seconds !== "number" || !Number.isInteger(b.delay_seconds) || b.delay_seconds < 0)) fields.delay_seconds = "out_of_range";
    if (b.dedup_id !== undefined && typeof b.dedup_id !== "string") fields.dedup_id = "not_string";
    if (Object.keys(fields).length) throw invalid(fields);
    const app = await A.appFor(c, slug(ctx), "app.queue.write");
    const body: T.EnqueueBody = { body: b.body };
    if (typeof b.delay_seconds === "number") body.delay_seconds = b.delay_seconds;
    if (typeof b.dedup_id === "string") body.dedup_id = b.dedup_id;
    const out = await rt(() => c.cli.enqueue(app.id, body));
    return json({ id: out.id }, 201);
  }));

  router.get(`${one}/dlq`, route(async (c, ctx) => {
    const app = await A.appFor(c, slug(ctx), "app.read");
    return json({ items: (await rt(() => c.cli.listDLQ(app.id))).items ?? [] });
  }));

  router.delete(`${one}/dlq`, route(async (c, ctx) => {
    const app = await A.appFor(c, slug(ctx), "app.queue.write");
    await rt(() => c.cli.purgeDLQ(app.id));
    await audit(c, "app.dlq.purge", slug(ctx), null);
    return noContent();
  }));

  router.post(`${one}/dlq/redrive`, route(async (c, ctx) => {
    const app = await A.appFor(c, slug(ctx), "app.queue.write");
    const out = await rt(() => c.cli.redriveDLQ(app.id));
    await audit(c, "app.dlq.redrive", slug(ctx), { redriven: out.redriven });
    return json({ redriven: out.redriven });
  }));

  // ---- observability ----

  router.get(`${one}/stats`, route(async (c, ctx) => {
    const window = ctx.url.searchParams.get("window") || "5m";
    if (!["5m", "1h", "24h"].includes(window)) throw invalid({ window: "not_one_of" });
    const app = await A.appFor(c, slug(ctx), "app.logs.read");
    return json(await rt(() => c.cli.stats(app.id, window)));
  }));

  router.get(`${one}/events`, route(async (c, ctx) => {
    pageParams(ctx.url.searchParams);
    const app = await A.appFor(c, slug(ctx), "app.logs.read");
    const cursor = ctx.url.searchParams.get("cursor") || undefined;
    const page = await rt(() => c.cli.events(app.id, cursor));
    return json({ items: page.items ?? [], next_cursor: page.next_cursor ?? null });
  }));

  router.get(`${one}/logs`, route(async (c, ctx) => {
    const level = ctx.url.searchParams.get("level") ?? "";
    if (level && LOG_RANK[level] === undefined) throw invalid({ level: "not_one_of" });
    const raw = ctx.req.headers.get("last-event-id") ?? ctx.url.searchParams.get("last_event_id") ?? "";
    const last = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null;
    const app = await A.appFor(c, slug(ctx), "app.logs.read");
    return sseResponse(c, app, deps.storage.kv, deps.now, last, level);
  }));

  router.get(`${one}/export`, route(async (c, ctx) => {
    const name = slug(ctx);
    const { first, rest } = await A.exportData(c, name);
    const it = rest();
    const body = new ReadableStream<Uint8Array>({
      start(ctl) {
        if (first.length) ctl.enqueue(first);
      },
      async pull(ctl) {
        try {
          const n = await it.next();
          if (n.done) ctl.close();
          else ctl.enqueue(n.value);
        } catch (e) {
          ctl.error(e);
        }
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/vnd.sqlite3",
        "content-disposition": `attachment; filename="${name}.sqlite"`,
        "cache-control": "no-store",
      },
    });
  }));
}

// ---- helpers ----

function appResponse(c: A.OrgCtx, svc: T.Service, etag: string, status: number): Response {
  const runtimeUrl = (c.deps.config as { runtimePublicUrl?: string }).runtimePublicUrl ?? "";
  const v = A.appView(svc, etag, runtimeUrl);
  return json(v, status, etagHeader(v.etag));
}

function etagHeader(etag: string): Record<string, string> | undefined {
  const q = A.quoteEtag(etag);
  return q ? { etag: q } : undefined;
}

function versionParam(ctx: RequestContext): number {
  const n = Number(ctx.params.v);
  if (!/^\d+$/.test(ctx.params.v ?? "") || n < 1) throw invalid({ v: "out_of_range" });
  return n;
}

function pageParams(q: URLSearchParams): { offset: number; limit: number } {
  const fields: Record<string, string> = {};
  let limit = 50;
  const l = q.get("limit");
  if (l) {
    limit = Number(l);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) fields.limit = "out_of_range";
  }
  let offset = 0;
  const cur = q.get("cursor");
  if (cur && /^\d+$/.test(cur)) offset = Number(cur);
  if (Object.keys(fields).length) throw invalid(fields);
  return { offset, limit };
}

function scheduleBody(b: Record<string, unknown>, create: boolean): Partial<T.ScheduleBody> {
  const fields: Record<string, string> = {};
  const out: Partial<T.ScheduleBody> = {};
  if (create) {
    if (b.kind !== "interval" && b.kind !== "cron") fields.kind = "not_one_of";
    else out.kind = b.kind;
  } else if (b.kind !== undefined) fields.kind = "invalid_format"; // the kind cannot change
  if (b.every_seconds !== undefined) {
    if (typeof b.every_seconds !== "number" || !Number.isInteger(b.every_seconds) || b.every_seconds < 1) fields.every_seconds = "out_of_range";
    else out.every_seconds = b.every_seconds;
  }
  for (const k of ["cron", "timezone"] as const) {
    if (b[k] !== undefined) {
      if (typeof b[k] !== "string") fields[k] = "not_string";
      else out[k] = b[k];
    }
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") fields.enabled = "not_boolean";
    else out.enabled = b.enabled;
  }
  if ("payload" in b) out.payload = b.payload;
  if (Object.keys(fields).length) throw invalid(fields);
  return out;
}

/** readJson with a larger cap (PUT …/files). */
async function readBig(req: Request, max: number): Promise<Record<string, unknown>> {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().startsWith("application/json")) throw badRequest("bad_request", "expected application/json");
  const text = await req.text();
  if (new TextEncoder().encode(text).length > max) throw new AppError(413, "payload_too_large", "request body too large");
  try {
    const v: unknown = JSON.parse(text);
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch {
    throw badRequest("bad_request", "malformed JSON body");
  }
}

async function audit(c: A.OrgCtx, action: string, target: string, detail: unknown): Promise<void> {
  await writeAudit(c.deps, { actor: c.actor, orgId: c.org.id, action, target, detail });
}
