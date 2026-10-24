// Apps on the runtime (port of internal/apps). Every call acts with the org's
// hidden default key (sealed in orgs.default_key_sealed, design §6) through
// `Runtime.as(key)`. A slug held by another tenant is invisible to that key and so
// 404. No resolve cache: each request is its own task.

import type { Deps } from "../app.ts";
import { AppError, conflict, invalid, notFound } from "../http/errors.ts";
import { Runtime, type Scoped } from "../runtime/client.ts";
import type * as T from "../runtime/types.ts";
import { can, type Action, type Subject } from "../authz/policy.ts";
import { authorize } from "../orgs/members.ts";
import { defaultKey, type Org } from "../orgs/orgs.ts";
import type { Actor } from "../orgs/common.ts";
import { rt } from "../runtime/errors.ts";
import { checkBundle, MAX_FILE_BYTES, unpack } from "./source.ts";
import { renderTemplate } from "./templates.ts";

/** Clock seams (tests replace sleep with a fake-clock tick). */
export const timing = {
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  buildPollMs: 500,
  /** Max build polls per save (fetch budget is 50 per task). */
  buildPolls: 36,
};

export const SLUG_TAKEN_MESSAGE = "This app name is taken on this runtime";

export interface Resolved {
  id: string;
  slug: string;
  project: string;
  environment: string;
}

export interface OrgCtx {
  deps: Deps;
  org: Org;
  sub: Subject;
  actor: Actor;
  cli: Scoped;
}

export async function orgClient(deps: Deps, org: Org): Promise<Scoped> {
  const unavailable = () => new AppError(502, "runtime_unavailable", "runtime unavailable");
  if (!deps.rtctl) throw unavailable();
  const key = await defaultKey(deps, org.id).catch(() => {
    throw unavailable();
  });
  return new Runtime(deps.rtctl).as(key);
}

export async function resolve(c: OrgCtx, slug: string): Promise<Resolved> {
  const page = await rt(() => c.cli.listServices({ slug }));
  const s = page.items.find((x) => x.slug === slug);
  if (!s) throw notFound();
  return { id: s.id, slug: s.slug, project: s.project, environment: s.environment };
}

/** Resolves slug and checks `a` on its project. */
export async function appFor(c: OrgCtx, slug: string, a: Action): Promise<Resolved> {
  const app = await resolve(c, slug);
  authorize(c.sub, a, app.project);
  return app;
}

// ---- views ----

export const quoteEtag = (e: string) => (!e || e.startsWith('"') ? e : `"${e}"`);
export const ifMatch = (req: Request) => quoteEtag((req.headers.get("if-match") ?? "").trim().replace(/^W\//, ""));

export function summary(s: T.Service) {
  return {
    slug: s.slug, name: s.name, project: s.project, environment: s.environment, live_version: s.live_version,
    status: { build_state: s.status.build_state, tier: s.status.tier, last_error: s.status.last_error },
  };
}

function limitSource(requested: unknown, effective: unknown): "plan" | "service" | "profile" {
  let service = false;
  if (effective && typeof effective === "object") {
    for (const v of Object.values(effective as Record<string, { source?: unknown }>)) {
      const src = v && typeof v === "object" ? String(v.source ?? "") : "";
      if (src === "plan" || src.startsWith("plan:")) return "plan";
      if (src === "service") service = true;
    }
  }
  const req = requested && typeof requested === "object" && Object.keys(requested).length > 0;
  return service || req ? "service" : "profile";
}

export function appView(s: T.Service, etag: string, runtimeUrl: string) {
  const requested = s.limits === undefined || s.limits === null ? null : s.limits;
  const e = etag || s.etag;
  return {
    ...summary(s),
    etag: e,
    runtime: s.runtime, profile: s.profile, access: s.access,
    url: `${runtimeUrl.replace(/\/$/, "")}/s/${s.slug}/`,
    scaling: s.scaling ?? null, ingress: s.ingress ?? null, egress: s.egress ?? null,
    call: s.call ?? null, triggers: s.triggers ?? null,
    status: { ...summary(s).status, inflight: s.status.inflight, admission: s.status.admission },
    limits: { requested, effective: s.effective ?? {}, source: limitSource(requested, s.effective) },
  };
}

// ---- CRUD ----

export async function listApps(c: OrgCtx, project: string, environment: string) {
  if (project) authorize(c.sub, "app.read", project);
  const out: ReturnType<typeof summary>[] = [];
  const f: T.ServiceFilter = {};
  if (project) f.project = project;
  if (environment) f.environment = environment;
  for (let i = 0; i < 50; i++) {
    const page = await rt(() => c.cli.listServices(f));
    for (const s of page.items) if (can(c.sub, "app.read", s.project)) out.push(summary(s));
    if (!page.next_cursor) break;
    f.cursor = page.next_cursor;
  }
  return out;
}

export async function getApp(c: OrgCtx, slug: string) {
  const app = await appFor(c, slug, "app.read");
  return rt(() => c.cli.getService(app.id));
}

export async function createApp(c: OrgCtx, b: { project: string; environment: string; slug: string; template: string; name?: string }) {
  authorize(c.sub, "app.create", b.project);
  const src = renderTemplate(b.template, b.slug);
  if (src === undefined) throw invalid({ template: "not_one_of" });
  const envs = await rt(() => c.cli.getProjectEnvironments(b.project));
  // Items are `{name, services}` objects (runtime v0.1.1); accept bare strings too.
  const names = (envs.environments as unknown[]).map((e) => (typeof e === "string" ? e : String((e as { name?: unknown })?.name ?? "")));
  if (!names.includes(b.environment)) throw invalid({ environment: "not_one_of" });
  let svc: T.Service;
  try {
    svc = await rt(() => c.cli.createService({ slug: b.slug, runtime: "deno", project: b.project, environment: b.environment, ...(b.name ? { name: b.name } : {}) }));
  } catch (e) {
    if (e instanceof AppError && e.code === "slug_taken") throw conflict("slug_taken", SLUG_TAKEN_MESSAGE);
    throw e;
  }
  try {
    await rt(() => c.cli.uploadVersion(svc.id, src, "application/typescript", { activate: true, compile: "eager" }));
  } catch (e) {
    // Best effort: do not leave an empty app holding the slug.
    await c.cli.deleteService(svc.id).catch((d: unknown) => console.error("apps: cleanup after failed upload", String(d)));
    throw e;
  }
  return rt(() => c.cli.getService(svc.id));
}

const ACCESS = ["public", "key", "internal"];

/** Validates and maps an AppPatch body to a runtime ServicePatch. */
export function toServicePatch(b: Record<string, unknown>): T.ServicePatch {
  const fields: Record<string, string> = {};
  const out: Record<string, unknown> = {};
  if ("name" in b) out.name = b.name;
  if ("profile" in b) out.profile = b.profile;
  if (b.access !== undefined) {
    if (!ACCESS.includes(String(b.access))) fields.access = "not_one_of";
    out.access = b.access;
  }
  for (const k of ["egress", "limits"] as const) if (b[k] !== undefined) out[k] = b[k];
  if (b.scaling !== undefined) {
    const sc = b.scaling as { min_instances?: unknown; max_instances?: unknown };
    if (!sc || typeof sc !== "object" || Array.isArray(sc)) fields.scaling = "invalid_format";
    else {
      const min = typeof sc.min_instances === "number" ? sc.min_instances : undefined;
      const max = typeof sc.max_instances === "number" ? sc.max_instances : undefined;
      if (min !== undefined && min < 0) fields["scaling.min_instances"] = "out_of_range";
      if (max !== undefined && max < 1) fields["scaling.max_instances"] = "out_of_range";
      if (min !== undefined && max !== undefined && min >= 0 && max >= 1 && min > max) fields["scaling.min_instances"] = "out_of_range";
    }
    out.scaling = b.scaling;
  }
  if (b.ingress !== undefined) {
    const ig = (b.ingress ?? {}) as { methods?: unknown; path_prefixes?: unknown; ip_allow?: unknown; rate_limit?: unknown };
    const ip = Array.isArray(ig.ip_allow) ? ig.ip_allow : [];
    ip.forEach((v, i) => {
      if (typeof v !== "string" || !isCidr(v)) fields[`ingress.ip_allow[${i}]`] = "invalid_format";
    });
    const ing: Record<string, unknown> = {};
    if (Array.isArray(ig.methods) && ig.methods.length) ing.allowed_methods = ig.methods;
    if (Array.isArray(ig.path_prefixes) && ig.path_prefixes.length) ing.allow_paths = ig.path_prefixes;
    if (ip.length) ing.ip_allow = ip;
    if (ig.rate_limit !== undefined && ig.rate_limit !== null) ing.rate_limit = ig.rate_limit;
    out.ingress = ing;
  }
  if (b.call !== undefined) {
    const cl = (b.call ?? {}) as { allowed_callers?: unknown };
    out.call = { allowed_callers: Array.isArray(cl.allowed_callers) ? cl.allowed_callers : [] };
  }
  if (Object.keys(fields).length) throw invalid(fields);
  return out as T.ServicePatch;
}

export function isCidr(v: string): boolean {
  const m = /^(.+)\/(\d{1,3})$/.exec(v);
  if (!m) return false;
  const addr = m[1] as string;
  const bits = Number(m[2]);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) return addr.split(".").every((o) => Number(o) <= 255 && String(Number(o)) === o) && bits <= 32;
  if (addr.includes(":") && /^[0-9a-fA-F:.]+$/.test(addr)) {
    const dbl = addr.split("::").length - 1;
    if (dbl > 1) return false;
    const groups = addr.split(":").filter((g) => g !== "");
    if (groups.some((g) => g.length > 4 && !g.includes("."))) return false;
    return (dbl === 1 ? groups.length < 8 : groups.length === 8) && bits <= 128;
  }
  return false;
}

export async function updateApp(c: OrgCtx, slug: string, patch: T.ServicePatch, etag: string) {
  const app = await appFor(c, slug, "app.update");
  if (!etag) throw new AppError(428, "precondition_required", "If-Match header required");
  const svc = await rt(() => c.cli.patchService(app.id, patch, etag));
  return svc;
}

export async function deleteApp(c: OrgCtx, slug: string) {
  const app = await appFor(c, slug, "app.delete");
  await rt(() => c.cli.deleteService(app.id));
  return app;
}

// ---- code and versions ----

export async function getFiles(c: OrgCtx, slug: string, version: number) {
  const app = await appFor(c, slug, "app.read");
  if (version === 0) {
    const { value } = await rt(() => c.cli.getService(app.id));
    if (value.live_version === null) throw notFound();
    version = value.live_version;
  }
  const src = await rt(() => c.cli.versionSource(app.id, version));
  const body = typeof src.body === "string" ? src.body : JSON.stringify(src.body ?? "");
  return { version, ...unpack(body, src.contentType, src.encoding === "base64") };
}

interface Author { user_id: string; name: string }

function versionView(v: T.Version, live: number | null, author: Author | null) {
  return {
    version: v.version, build_state: v.build_state, live: live !== null && v.version === live,
    source_digest: v.source_digest, failure: v.failure, author, created_at: v.created_at,
  };
}

async function awaitBuild(c: OrgCtx, svcId: string, v: T.Version): Promise<T.Version> {
  for (let i = 0; (v.build_state === "pending" || v.build_state === "building"); i++) {
    if (i >= timing.buildPolls) throw conflict("build_timeout", "the build did not finish yet");
    await timing.sleep(timing.buildPollMs);
    v = await rt(() => c.cli.getVersion(svcId, v.version));
  }
  return v;
}

function buildFailed(v: T.Version): AppError {
  const f = v.failure;
  const details: Record<string, unknown> = { reason: f?.reason ?? "build_failed", message: f?.message ?? "build failed", version: v.version };
  if (f?.diagnostics !== undefined) details.diagnostics = f.diagnostics;
  return new AppError(422, "build_failed", f?.message || "build failed", details);
}

/** Uploads files as a new version (eager build, not activated), then sets it live under etag. */
export async function saveFiles(c: OrgCtx, slug: string, entry: unknown, files: unknown, etag: string) {
  const app = await appFor(c, slug, "app.deploy");
  if (!etag) throw new AppError(428, "precondition_required", "If-Match header required");
  if (!files || typeof files !== "object" || Array.isArray(files)) throw invalid({ files: "required" });
  const f = checkBundle(typeof entry === "string" ? entry : "", files as Record<string, unknown>, MAX_FILE_BYTES);
  const body = JSON.stringify({ entry: f.entry, files: f.files });
  let up = await rt(() => c.cli.uploadVersion(app.id, body, "application/json", { compile: "eager" }));
  up = await awaitBuild(c, app.id, up);
  if (up.build_state === "failed") throw buildFailed(up);
  await c.deps.storage.db.run(
    "INSERT INTO version_authors (org_id, app_slug, version, user_id) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, app_slug, version) DO UPDATE SET user_id = excluded.user_id",
    [c.org.id, app.id, String(up.version), c.sub.userId],
  );
  const svc = await rt(() => c.cli.setLive(app.id, up.version, etag));
  const name = await userName(c, c.sub.userId);
  return { version: { ...versionView(up, up.version, { user_id: c.sub.userId, name }) }, etag: svc.etag };
}

async function userName(c: OrgCtx, id: string): Promise<string> {
  const u = await c.deps.storage.db.first<{ name: string }>("SELECT name FROM users WHERE id = ?", [id]);
  return u?.name ?? "";
}

export async function listVersions(c: OrgCtx, slug: string) {
  const app = await appFor(c, slug, "app.read");
  const { value: svc } = await rt(() => c.cli.getService(app.id));
  const list = await rt(() => c.cli.listVersions(app.id));
  // version_authors.app_slug holds the runtime service id (stable across slug reuse).
  const rows = await c.deps.storage.db.all<{ version: string; user_id: string; name: string | null }>(
    "SELECT va.version, va.user_id, u.name FROM version_authors va LEFT JOIN users u ON u.id = va.user_id WHERE va.org_id = ? AND va.app_slug = ?",
    [c.org.id, app.id],
  );
  const authors = new Map(rows.map((r) => [Number(r.version), { user_id: r.user_id, name: r.name ?? "" }]));
  return [...list].sort((a, b) => b.version - a.version).map((v) => versionView(v, svc.live_version, authors.get(v.version) ?? null));
}

export async function promote(c: OrgCtx, slug: string, version: number, etag: string) {
  const app = await appFor(c, slug, "app.deploy");
  if (!etag) throw new AppError(428, "precondition_required", "If-Match header required");
  const svc = await rt(() => c.cli.setLive(app.id, version, etag));
  return { live_version: version, etag: svc.etag };
}

export async function rebuild(c: OrgCtx, slug: string, v: number) {
  const app = await appFor(c, slug, "app.deploy");
  const rv = await rt(() => c.cli.rebuild(app.id, v));
  return versionView(rv, null, null);
}

export function logLine(l: T.LogLine) {
  const out: Record<string, unknown> = {
    seq: l.seq, ts: l.ts, level: l.level, version: l.version ?? null, task_id: l.task_id ?? null,
    trigger: l.trigger ?? null, kind: l.kind, msg: l.msg, truncated: l.truncated ?? false,
  };
  if (l.fields !== undefined) out.fields = l.fields;
  return out;
}

export async function buildLogs(c: OrgCtx, slug: string, v: number) {
  const app = await appFor(c, slug, "app.read");
  await rt(() => c.cli.getVersion(app.id, v)); // 404 for an unknown version
  const out: ReturnType<typeof logLine>[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const q: T.LogQuery = { kind: "build", limit: 1000 };
    if (cursor) q.cursor = cursor;
    const page = await rt(() => c.cli.logs(app.id, q));
    for (const l of page.items) if (l.version === undefined || l.version === v) out.push(logLine(l));
    if (!page.next_cursor || page.next_cursor === cursor || page.items.length === 0) break;
    cursor = page.next_cursor;
  }
  return out;
}

// ---- export ----

/** Bytes per export hop (design §4: ≤ 192 KiB per SDK hop). */
export const EXPORT_CHUNK = 192 * 1024;
const EXPORT_HOPS = 40;

function bytesOf(res: T.CtlRes): Uint8Array {
  if (res.body === null || res.body === undefined) return new Uint8Array();
  const s = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
  if (res.encoding === "base64") return Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
  return new TextEncoder().encode(s);
}

/**
 * Reads the data snapshot in Range hops. If the control API ignores Range and
 * the whole snapshot exceeds one hop, answers 413 export_too_large.
 */
export async function exportData(c: OrgCtx, slug: string): Promise<{ first: Uint8Array; rest: () => AsyncGenerator<Uint8Array> }> {
  const app = await appFor(c, slug, "app.data.export");
  const path = `/v1/services/${encodeURIComponent(app.id)}/data/export`;
  const hop = (off: number) =>
    rt(() => c.cli.raw({ method: "GET", path, headers: { accept: "application/vnd.sqlite3", range: `bytes=${off}-${off + EXPORT_CHUNK - 1}` } }));
  const tooLarge = () => new AppError(413, "export_too_large", "the data snapshot is too large to download here", { cli: "21ci data export" });
  const res = await hop(0);
  const first = bytesOf(res);
  if (res.status !== 206) {
    if (first.length > EXPORT_CHUNK) throw tooLarge();
    return { first, rest: async function* () {} };
  }
  const total = totalOf(res.headers["content-range"]);
  if (total === null || Math.ceil(total / EXPORT_CHUNK) > EXPORT_HOPS) throw tooLarge();
  return {
    first,
    rest: async function* () {
      let off = first.length;
      while (off < total && first.length > 0) {
        const r = await hop(off);
        const b = bytesOf(r);
        if (b.length === 0) return;
        yield b;
        off += b.length;
      }
    },
  };
}

function totalOf(cr: string | undefined): number | null {
  const m = cr ? /\/(\d+)\s*$/.exec(cr) : null;
  return m ? Number(m[1]) : null;
}
