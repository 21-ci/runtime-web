// /api/orgs/{org}/apps… (api-web §8.1–8.4, §8.6).
// Domains (§8.5) live in routes/domains.ts.

import type { Deps } from "../app.ts";
import { authOf, requireSession, withRetryAfter } from "../auth/middleware.ts";
import { AppError, badRequest, invalid } from "../http/errors.ts";
import { csvLine, exportFileName, exportFormat, exportResponse, rangeBound, isoTime } from "../http/export.ts";
import { json, noContent, readJson } from "../http/json.ts";
import type { Handler, RequestContext, Router } from "../http/router.ts";
import { orgAccess } from "../orgs/members.ts";
import { audit as writeAudit } from "../audit/audit.ts";
import { rt } from "../runtime/errors.ts";
import * as A from "../apps/service.ts";
import * as S from "../apps/switches.ts";
import * as B from "../apps/bundles.ts";
import * as D from "../apps/data.ts";
import * as E from "../apps/data_events.ts";
import { readCapped } from "../git/provider.ts";
import { pauseGitAutomation, pauseIfBehindGit } from "../git/links.ts";
import { LOG_RANK, sseResponse } from "../apps/logs.ts";
import { NEEDS_KEY, readPreview } from "../apps/preview.ts";
import { SLUG_RE } from "../apps/slug.ts";
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
    if (input.slug && !SLUG_RE.test(input.slug)) fields.slug = "pattern";
    if (b.name !== undefined && b.name !== null && typeof b.name !== "string") fields.name = "not_string";
    if (Object.keys(fields).length) throw invalid(fields);
    const { value, etag } = await A.createApp(c, { ...input, ...(typeof b.name === "string" && b.name ? { name: b.name } : {}) });
    await audit(c, "app.create", input.slug, { project: input.project, environment: input.environment, template: input.template });
    return appResponse(c, value, etag, 201);
  }));

  // A raw body, with the rest in the query: components are binary and can be megabytes.
  router.post(`${base}/wasm`, route(async (c, ctx) => {
    const q = ctx.url.searchParams;
    const fields: Record<string, string> = {};
    const s = (k: string) => {
      const v = q.get(k) ?? "";
      if (!v) fields[k] = "required";
      return v;
    };
    const input = { project: s("project"), environment: s("environment"), slug: s("slug") };
    if (input.slug && !SLUG_RE.test(input.slug)) fields.slug = "pattern";
    if (Object.keys(fields).length) throw invalid(fields);
    const bytes = ctx.req.body ? await readCapped(ctx.req.body, MAX_FILES_BODY) : new Uint8Array();
    if (bytes === null) throw invalid({ file: "too_large" });
    const name = q.get("name");
    const { value, etag } = await A.createWasmApp(c, { ...input, ...(name ? { name } : {}) }, bytes);
    await audit(c, "app.create", input.slug, { project: input.project, environment: input.environment, template: "wasm" });
    return appResponse(c, value, etag, 201);
  }));

  router.get(one, route(async (c, ctx) => {
    const { value, etag } = await A.getApp(c, slug(ctx));
    return appResponse(c, value, etag, 200);
  }));

  // A POST because it runs the app's handler. Only ever called from a click, never on page view.
  router.post(`${one}/preview`, route(async (c, ctx) => {
    const { value } = await A.getApp(c, slug(ctx));
    if (value.access !== "public") return json(NEEDS_KEY);
    return json(await readPreview(deps.fetch ?? globalThis.fetch, A.appUrl(deps.config.runtimePublicUrl, value.slug)));
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
    let v: number | "latest" = 0;
    if (raw === "latest") v = "latest";
    else if (raw !== null && raw !== "") {
      v = Number(raw);
      if (!Number.isInteger(v) || v < 1) throw invalid({ version: "out_of_range" });
    }
    return json(await A.getFiles(c, slug(ctx), v));
  }));

  router.put(`${one}/files`, route(async (c, ctx) => {
    const b = await readBig(ctx.req, MAX_FILES_BODY);
    const out = await A.saveFiles(c, slug(ctx), b.entry, b.files, A.ifMatch(ctx.req));
    await audit(c, "app.save", slug(ctx), { version: out.version.version });
    return json(out, 200, etagHeader(out.etag));
  }));

  router.get(`${one}/versions`, route(async (c, ctx) => {
    const format = exportFormat(ctx.url.searchParams, ["csv"] as const);
    const items = await A.listVersions(c, slug(ctx));
    if (!format) return json({ items });
    const res = await exportResponse({
      fileName: exportFileName([c.org.slug, slug(ctx)], "versions", null, c.deps.now(), format),
      format,
      header: csvLine(["version", "state", "live", "source_digest", "author", "created_at", "failure", "meta"]),
      rows: items,
      line: (v) => csvLine([v.version, v.build_state, v.live, v.source_digest, v.author?.name ?? "", isoTime(v.created_at), v.failure?.reason ?? "", v.meta]),
    });
    await audit(c, "app.versions.export", slug(ctx), { format, rows: items.length });
    return res;
  }));

  router.put(`${one}/live`, route(async (c, ctx) => {
    const b = await readJson(ctx.req);
    if (typeof b.version !== "number" || !Number.isInteger(b.version) || b.version < 1) throw invalid({ version: "out_of_range" });
    if (ctx.url.searchParams.get("async") === "1") {
      for (const k of ["close_sockets", "migrate"]) if (b[k] !== undefined && typeof b[k] !== "boolean") throw invalid({ [k]: "not_boolean" });
      const out = await S.promoteAsync(c, slug(ctx), { version: b.version, close_sockets: b.close_sockets as boolean | undefined, migrate: b.migrate as boolean | undefined }, A.ifMatch(ctx.req));
      await audit(c, "app.live", slug(ctx), { version: b.version, switch: out.id, ...(b.migrate === false ? { migrate: false } : {}) });
      const target = await A.resolve(c, slug(ctx));
      await pauseIfBehindGit(deps, c.org.id, target.id, b.version);
      return json(out, 202);
    }
    const out = await A.promote(c, slug(ctx), b.version, A.ifMatch(ctx.req));
    await audit(c, "app.live", slug(ctx), { version: b.version });
    const target = await A.resolve(c, slug(ctx));
    await pauseIfBehindGit(deps, c.org.id, target.id, b.version);
    return json(out, 200, etagHeader(out.etag));
  }));

  router.post(`${one}/live/dry-run`, route(async (c, ctx) => {
    const b = await readJson(ctx.req);
    if (typeof b.version !== "number" || !Number.isInteger(b.version) || b.version < 1) throw invalid({ version: "out_of_range" });
    return json(await A.promoteDryRun(c, slug(ctx), b.version));
  }));

  router.get(`${one}/migrations`, route(async (c, ctx) => json(await A.migrations(c, slug(ctx)))));

  router.get(`${one}/versions/:v/build-logs`, route(async (c, ctx) => json({ items: await A.buildLogs(c, slug(ctx), versionParam(ctx)) })));

  router.post(`${one}/versions/:v/rebuild`, route(async (c, ctx) => {
    const v = versionParam(ctx);
    const out = await A.rebuild(c, slug(ctx), v);
    await audit(c, "app.rebuild", slug(ctx), { version: v });
    return json({ ...out, build_state: out.build_state === "ready" ? out.build_state : "building" }, 202);
  }));

  // ---- branches and switches ----

  router.get(`${one}/branches`, route(async (c, ctx) => json({ items: await S.listBranches(c, slug(ctx)) })));

  router.post(`${one}/branches`, route(async (c, ctx) => {
    const input = S.parseBranch(await readJson(ctx.req));
    const out = await S.createBranch(c, slug(ctx), input);
    await audit(c, "app.branch.create", slug(ctx), { branch: input.name, copy_data: input.copy_data, expires_in_days: input.expires_in_days ?? null });
    return json(out, 201);
  }));

  router.post(`${one}/switch`, route(async (c, ctx) => {
    const input = S.parseSwitch(await readJson(ctx.req));
    const out = await S.switchTo(c, slug(ctx), input, A.ifMatch(ctx.req));
    if (input.dry_run) return json(out);
    await audit(c, "app.switch", slug(ctx), { branch: input.branch, switch: out.id, from: out.from_version, to: out.to_version, digest: out.source?.digest ?? null });
    return json(out, 202);
  }));

  router.get(`${one}/switches`, route(async (c, ctx) => json(await S.listSwitches(c, slug(ctx), ctx.url.searchParams))));

  router.get(`${one}/switches/:id`, route(async (c, ctx) => json(await S.getSwitch(c, slug(ctx), ctx.params.id ?? ""))));

  router.post(`${one}/switches/:id/rollback`, route(async (c, ctx) => {
    const id = ctx.params.id ?? "";
    const out = await S.rollback(c, slug(ctx), id, A.ifMatch(ctx.req));
    await audit(c, "app.rollback", slug(ctx), { switch: id, rollback: out.id, from: out.from_version, to: out.to_version });
    // Otherwise the next push would undo the rollback.
    await pauseGitAutomation(deps, c.org.id, (await A.resolve(c, slug(ctx))).id);
    return json(out, 202);
  }));

  // ---- env, secrets ----

  router.get(`${one}/env`, route(async (c, ctx) => {
    // Env often holds third-party API keys: developers and up only, like the writes.
    const app = await A.appFor(c, slug(ctx), "app.env.read");
    const env = (await rt(() => c.cli.getEnv(app.id))) ?? {};
    return json({ env }, 200, { etag: await envEtag(env) });
  }));

  // Full replace. If-Match (the ETag of GET …/env) is required, so two editors never silently drop keys.
  router.put(`${one}/env`, route(async (c, ctx) => {
    const b = await readJson(ctx.req);
    const env = b.env;
    if (!env || typeof env !== "object" || Array.isArray(env)) throw invalid({ env: "required" });
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) if (typeof v !== "string") fields[`env.${k}`] = "not_string";
    if (Object.keys(fields).length) throw invalid(fields);
    const app = await A.appFor(c, slug(ctx), "app.env.write");
    const tag = A.ifMatch(ctx.req);
    if (!tag) throw new AppError(428, "precondition_required", "If-Match header required");
    await checkEnvEtag(c, app.id, tag);
    const out = (await rt(() => c.cli.putEnv(app.id, env as Record<string, string>))) ?? {};
    await audit(c, "app.env", slug(ctx), { keys: Object.keys(env) });
    return json({ env: out }, 200, { etag: await envEtag(out) });
  }));

  // Row edits: set and unset single keys on the current map. If-Match is optional here.
  router.patch(`${one}/env`, route(async (c, ctx) => {
    const b = await readJson(ctx.req);
    const fields: Record<string, string> = {};
    const set = b.set ?? {};
    const unset = b.unset ?? [];
    if (!set || typeof set !== "object" || Array.isArray(set)) fields.set = "invalid_format";
    else for (const [k, v] of Object.entries(set)) if (typeof v !== "string") fields[`set.${k}`] = "not_string";
    if (!Array.isArray(unset) || unset.some((k) => typeof k !== "string")) fields.unset = "invalid_format";
    if (Object.keys(fields).length) throw invalid(fields);
    const app = await A.appFor(c, slug(ctx), "app.env.write");
    const tag = A.ifMatch(ctx.req);
    const cur = (await rt(() => c.cli.getEnv(app.id))) ?? {};
    if (tag && tag !== (await envEtag(cur))) throw envStale();
    const drop = new Set(unset as string[]);
    const next = Object.fromEntries(Object.entries({ ...cur, ...(set as Record<string, string>) }).filter(([k]) => !drop.has(k)));
    const out = (await rt(() => c.cli.putEnv(app.id, next))) ?? {};
    await audit(c, "app.env", slug(ctx), { set: Object.keys(set as object), unset });
    return json({ env: out }, 200, { etag: await envEtag(out) });
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

  router.put(`${one}/secrets/:name/ref`, route(async (c, ctx) => {
    const b = await readJson(ctx.req);
    const fields: Record<string, string> = {};
    if (typeof b.path !== "string" || !b.path) fields.path = "required";
    if (typeof b.field !== "string" || !b.field) fields.field = "required";
    if (Object.keys(fields).length) throw invalid(fields);
    const app = await A.appFor(c, slug(ctx), "app.secrets.write");
    const out = await rt(() => c.cli.putSecretRef(app.id, ctx.params.name ?? "", { path: b.path as string, field: b.field as string }));
    await audit(c, "app.secret.ref_set", slug(ctx), { name: ctx.params.name, path: b.path, field: b.field });
    return json(out);
  }));

  router.delete(`${one}/secrets/:name/ref`, route(async (c, ctx) => {
    const app = await A.appFor(c, slug(ctx), "app.secrets.write");
    await rt(() => c.cli.deleteSecretRef(app.id, ctx.params.name ?? ""));
    await audit(c, "app.secret.ref_delete", slug(ctx), { name: ctx.params.name });
    return noContent();
  }));

  router.post(`${one}/secrets/sync`, route(async (c, ctx) => {
    const app = await A.appFor(c, slug(ctx), "app.secrets.write");
    await rt(() => c.cli.syncSecrets(app.id));
    await audit(c, "app.secret.sync", slug(ctx), {});
    return json({}, 202);
  }));

  // ---- data-change events ----
  router.get(`${one}/data-events`, route(async (c, ctx) => {
    const app = await A.appFor(c, slug(ctx), "app.read");
    return json(await rt(() => c.cli.getDataEvents(app.id)));
  }));

  router.put(`${one}/data-events`, route(async (c, ctx) => {
    const out = await E.enable(c, slug(ctx), E.parseConfig(await readJson(ctx.req)));
    return json(out);
  }));

  router.delete(`${one}/data-events`, route(async (c, ctx) => {
    const app = await A.appFor(c, slug(ctx), "app.update");
    await rt(() => c.cli.deleteDataEvents(app.id));
    await audit(c, "app.data_events.delete", slug(ctx), {});
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
    await audit(c, "app.queue.send", slug(ctx), { id: out.id });
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
    const format = exportFormat(ctx.url.searchParams, ["csv"] as const);
    const window = ctx.url.searchParams.get("window") || "5m";
    if (window === "7d") {
      const week = await A.weekStats(c, slug(ctx));
      return format ? statsExport(c, slug(ctx), week, window) : json(week);
    }
    if (!["5m", "1h", "24h"].includes(window)) throw invalid({ window: "not_one_of" });
    const step = ctx.url.searchParams.get("step") ?? undefined;
    if (step !== undefined && !["1m", "5m", "1h"].includes(step)) throw invalid({ step: "not_one_of" });
    const app = await A.appFor(c, slug(ctx), "app.logs.read");
    const view = statsView(await rt(() => c.cli.stats(app.id, window, step)), window);
    return format ? statsExport(c, slug(ctx), view, window) : json(view);
  }));

  router.get(`${one}/events`, route(async (c, ctx) => {
    pageParams(ctx.url.searchParams);
    const app = await A.appFor(c, slug(ctx), "app.logs.read");
    const cursor = ctx.url.searchParams.get("cursor") || undefined;
    const page = await rt(() => c.cli.events(app.id, cursor));
    return json({ items: page.items ?? [], next_cursor: page.next_cursor ?? null });
  }));

  router.get(`${one}/logs`, route(async (c, ctx) => {
    const format = exportFormat(ctx.url.searchParams, ["ndjson", "txt"] as const);
    const level = ctx.url.searchParams.get("level") ?? "";
    if (level && LOG_RANK[level] === undefined) throw invalid({ level: "not_one_of" });
    const view = ctx.url.searchParams.get("view");
    if (view !== null && (view !== "range" || format)) throw invalid({ view: "not_one_of" });
    if (view) return logsRead(c, slug(ctx), ctx.url.searchParams, level);
    if (format) return logsExport(c, slug(ctx), ctx.url.searchParams, format, level);
    const raw = ctx.req.headers.get("last-event-id") ?? ctx.url.searchParams.get("last_event_id") ?? "";
    const last = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null;
    const app = await A.appFor(c, slug(ctx), "app.logs.read");
    return sseResponse(c, app, deps.storage.kv, deps.now, last, level);
  }));

  router.get(`${one}/data/tables`, route(async (c, ctx) => json(await D.tables(c, slug(ctx)))));
  router.post(`${one}/data/query`, route(async (c, ctx) => json(await D.query(c, slug(ctx), await readJson(ctx.req)))));
  router.get(`${one}/data/kv`, route(async (c, ctx) => json(await D.kvList(c, slug(ctx), ctx.url.searchParams))));
  router.get(`${one}/data/kv/:key`, route(async (c, ctx) => json(await D.kvGet(c, slug(ctx), ctx.params.key ?? ""))));
  router.get(`${one}/data/blobs`, route(async (c, ctx) => json(await D.blobs(c, slug(ctx), ctx.url.searchParams))));

  router.post(`${base}/import`, route(async (c, ctx) => {
    const input = B.parseImport(ctx.url.searchParams);
    const stream = ctx.req.body;
    const bytes = stream ? await readCapped(stream, B.MAX_IMPORT_BYTES) : new Uint8Array();
    if (!bytes) throw new AppError(413, "too_large", "this bundle is too large to import here", { cli: "21ci app import" });
    const out = await B.importApp(c, input, bytes);
    await audit(c, "app.import", input.slug, { project: input.project, environment: input.environment, from: input.from ?? null, activate: input.activate, missing_secrets: out.missing_secrets });
    return json(out, 202);
  }));

  router.post(`${one}/bundle`, route(async (c, ctx) => {
    const out = await B.startBundle(c, slug(ctx));
    await audit(c, "app.bundle", slug(ctx), { id: out.id });
    return json(out, 202);
  }));
  router.get(`${one}/bundle/:id`, route(async (c, ctx) => json(await B.bundleState(c, slug(ctx), ctx.params.id ?? ""))));
  router.get(`${one}/bundle/:id/download`, route(async (c, ctx) => {
    const bytes = await B.bundleBytes(c, slug(ctx), ctx.params.id ?? "");
    await audit(c, "app.bundle.download", slug(ctx), { id: ctx.params.id ?? "", bytes: bytes.length });
    return new Response(bytes as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: { "content-type": "application/zstd", "content-disposition": `attachment; filename="app-${slug(ctx)}.tar.zst"`, "cache-control": "no-store" },
    });
  }));

  router.get(`${one}/export`, route(async (c, ctx) => {
    const name = slug(ctx);
    const { first, total, rest } = await A.exportData(c, name);
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
        // A download cut midway must look cut, also to a proxy.
        ...(total === null ? {} : { "content-length": String(total) }),
        "cache-control": "no-store",
      },
    });
  }));
}

// ---- helpers ----

/** ETag of an env map: a SHA-256 over its entries sorted by key (the runtime keeps no version for env). */
export async function envEtag(env: Record<string, string>): Promise<string> {
  const canon = JSON.stringify(Object.keys(env).sort().map((k) => [k, env[k]]));
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon)));
  return `"${Array.from(d.subarray(0, 16), (x) => x.toString(16).padStart(2, "0")).join("")}"`;
}

const envStale = () => new AppError(412, "precondition_failed", "env changed elsewhere, reload");

async function checkEnvEtag(c: A.OrgCtx, id: string, tag: string): Promise<void> {
  const cur = (await rt(() => c.cli.getEnv(id))) ?? {};
  if (tag !== (await envEtag(cur))) throw envStale();
}

function appResponse(c: A.OrgCtx, svc: T.Service, etag: string, status: number): Response {
  const runtimeUrl = c.deps.config.runtimePublicUrl;
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

/**
 * Runtime stats (rt-obs ServiceStats: `count`, `errors`, `error_rate`, phase percentiles
 * under `total`/`exec`/…, plus `admission`) pass through, with the window echoed and the
 * console's flat keys added: `requests` = `count`, `p50_ms`/`p95_ms`/`p99_ms` = `total.*`.
 */
export function statsView(raw: unknown, window: string): Record<string, unknown> {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const total = o.total && typeof o.total === "object" ? (o.total as Record<string, unknown>) : {};
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  return {
    ...o,
    window,
    requests: num(o.count),
    errors: num(o.errors),
    error_rate: num(o.error_rate),
    p50_ms: num(total.p50_ms),
    p95_ms: num(total.p95_ms),
    p99_ms: num(total.p99_ms),
  };
}

/** Runtime pages one log export may read: bounds the scan when a level filter drops most lines. */
const MAX_LOG_EXPORT_PAGES = 2000;

/** Lines in one page of the Logs page's range read. */
const LOG_READ_ROWS = 1000;

async function* logRows(c: A.OrgCtx, appId: string, base: T.LogQuery, minRank: number) {
  let cursor: string | undefined;
  for (let i = 0; i < MAX_LOG_EXPORT_PAGES; i++) {
    const q: T.LogQuery = { ...base, limit: 1000, ...(cursor ? { cursor } : {}) };
    const page = await rt(() => c.cli.logs(appId, q));
    for (const l of page.items ?? []) if ((LOG_RANK[l.level] ?? 0) >= minRank) yield A.logLine(l);
    const next = page.next_cursor ?? undefined;
    if (!next || next === cursor || !page.items?.length) return;
    cursor = next;
  }
}

/** A message stays on its one line, so log text cannot forge entries in the file. */
const logText = (l: ReturnType<typeof A.logLine>) =>
  `${isoTime(l.ts)} ${String(l.level).toUpperCase()} ${String(l.kind)} ${String(l.msg).replace(/\r/g, "\\r").replace(/\n/g, "\\n")}`;

/** The filters a past range is read by, shared by the page's read and the file. */
function logRange(q: URLSearchParams) {
  const kind = q.get("kind") ?? "";
  if (kind && !["runtime", "build", "system"].includes(kind)) throw invalid({ kind: "not_one_of" });
  const since = rangeBound(q, "since");
  const until = rangeBound(q, "until");
  const taskId = q.get("task_id") ?? "";
  const base: T.LogQuery = {
    ...(since.text ? { since: since.text } : {}),
    ...(until.text ? { until: until.text } : {}),
    ...(kind ? { kind: kind as NonNullable<T.LogQuery["kind"]> } : {}),
    ...(taskId ? { task_id: taskId } : {}),
  };
  return { kind, since, until, base };
}

/** One page of a past range for the Logs page. It is a view like the live tail: no file, no audit entry. */
async function logsRead(c: A.OrgCtx, slug: string, q: URLSearchParams, level: string): Promise<Response> {
  const { base } = logRange(q);
  const app = await A.appFor(c, slug, "app.logs.read");
  return exportResponse({
    fileName: "",
    format: "ndjson",
    inline: true,
    maxRows: LOG_READ_ROWS,
    rows: logRows(c, app.id, base, level ? (LOG_RANK[level] ?? 0) : 0),
    line: (l) => JSON.stringify(l),
  });
}

async function logsExport(c: A.OrgCtx, slug: string, q: URLSearchParams, format: "ndjson" | "txt", level: string): Promise<Response> {
  const { kind, since, until, base } = logRange(q);
  const app = await A.appFor(c, slug, "app.logs.read");
  // The level is applied here as a minimum, as the live view does; the runtime's filter is an exact match.
  const res = await exportResponse({
    fileName: exportFileName([c.org.slug, slug], "logs", since.ms, until.ms ?? c.deps.now(), format),
    format,
    rows: logRows(c, app.id, base, level ? (LOG_RANK[level] ?? 0) : 0),
    line: format === "ndjson" ? (l) => JSON.stringify(l) : logText,
  });
  await audit(c, "app.logs.export", slug, { format, level: level || null, kind: kind || null, since: since.text ?? null, until: until.text ?? null });
  return res;
}

/** The chart's series when it has one, otherwise the window's summary as one row. */
async function statsExport(c: A.OrgCtx, slug: string, view: Record<string, unknown>, window: string): Promise<Response> {
  const series = Array.isArray(view.series) ? (view.series as Record<string, unknown>[]) : null;
  const columns = series
    ? [...new Set(series.flatMap((p) => Object.keys(p)))]
    : ["requests", "errors", "error_rate", "p50_ms", "p95_ms", "p99_ms"];
  if (series && columns.length === 0) columns.push("ts", "count", "errors");
  const res = await exportResponse({
    fileName: exportFileName([c.org.slug, slug], `stats-${window}`, null, c.deps.now(), "csv"),
    format: "csv",
    header: csvLine(["window", ...columns]),
    rows: series ?? [view],
    line: (row) => csvLine([window, ...columns.map((k) => row[k])]),
  });
  await audit(c, "app.stats.export", slug, { format: "csv", window });
  return res;
}

async function audit(c: A.OrgCtx, action: string, target: string, detail: unknown): Promise<void> {
  await writeAudit(c.deps, { actor: c.actor, orgId: c.org.id, action, target, detail });
}
