// Typed control-API client over RtCtl. `Runtime`
// holds no credential; `.op()` is the operator scope (binding rtctl-op),
// `.as(key)` a tenant key scope (binding rtctl-tenant via the relay).
import type * as T from "./types.ts";
import { CHUNK, type CtlReq, type CtlRes, type RtCtl, type WireReq, type WireRes } from "./types.ts";

/** Non-2xx from the control API, or a binding refusal (x-rt-reason). */
export class RuntimeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown = {},
    /** Seconds from Retry-After, if any. */
    readonly retryAfter?: number,
  ) {
    super(`runtime: ${status} ${code}: ${message}`);
    this.name = "RuntimeError";
  }
}

/** Transport failure (SDK unreachable, binding_upstream). */
export class RuntimeUnavailable extends Error {
  constructor(message: string) {
    super(`runtime: unavailable: ${message}`);
    this.name = "RuntimeUnavailable";
  }
}

/** The control API did not answer within the call deadline. */
export class RuntimeTimeout extends RuntimeUnavailable {
  constructor(message: string) {
    super(`timeout: ${message}`);
    this.name = "RuntimeTimeout";
  }
}

/** A hung binding would otherwise hold the request until the task wall limit. */
export const DEFAULT_RUNTIME_TIMEOUT_MS = 10_000;

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict",
  412: "Precondition Failed", 413: "Payload Too Large", 422: "Unprocessable Entity",
  429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable",
};

export function decodeError(res: CtlRes): RuntimeError {
  const ra = res.headers["retry-after"];
  const n = ra !== undefined && /^\d+$/.test(ra) ? Number(ra) : undefined;
  const reason = res.headers["x-rt-reason"];
  const b = res.body as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null;
  if (b && typeof b === "object" && b.error && typeof b.error.code === "string" && b.error.code) {
    return new RuntimeError(res.status, b.error.code, String(b.error.message ?? ""), b.error.details ?? {}, n);
  }
  if (reason) return new RuntimeError(res.status, reason, typeof res.body === "string" ? res.body : reason, {}, n);
  return new RuntimeError(res.status, `http_${res.status}`, STATUS_TEXT[res.status] ?? "error", {}, n);
}

export const isRuntimeError = (e: unknown): e is RuntimeError => e instanceof RuntimeError;
export const isNotFound = (e: unknown) => isRuntimeError(e) && e.status === 404;
export const isBusy = (e: unknown) =>
  isRuntimeError(e) && e.status === 503 && (e.code === "queue_timeout" || e.code === "overloaded");
export const isThrottled = (e: unknown) =>
  isRuntimeError(e) && e.status === 429 && ["rate_limited", "build_quota", "queue_full"].includes(e.code);
export const isDisabled = (e: unknown) => isRuntimeError(e) && e.status === 503 && e.code === "control_disabled";
export const isUnavailable = (e: unknown) => e instanceof RuntimeUnavailable;

const seg = encodeURIComponent;
const svc = (id: string) => `/v1/services/${seg(id)}`;
const ver = (id: string, v: number) => `${svc(id)}/versions/${v}`;
const cur = (cursor?: string) => (cursor ? { cursor } : undefined);

/** Body of a 2xx result plus its ETag. */
export interface WithEtag<V> {
  value: V;
  etag: string;
}

export class Scoped {
  constructor(
    private readonly send: (req: CtlReq) => Promise<CtlRes>,
    private readonly timeoutMs = DEFAULT_RUNTIME_TIMEOUT_MS,
  ) {}

  private deadline(req: CtlReq): Promise<CtlRes> {
    if (!(this.timeoutMs > 0)) return this.send(req);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RuntimeTimeout(`${req.method} ${req.path} after ${this.timeoutMs} ms`)), this.timeoutMs);
    });
    return Promise.race([this.send(req), expired]).finally(() => clearTimeout(timer));
  }

  /** Raw call: returns the response on 2xx, throws RuntimeError otherwise. */
  async raw(req: CtlReq): Promise<CtlRes> {
    let res: CtlRes;
    try {
      res = await this.deadline(req);
    } catch (e) {
      if (e instanceof RuntimeError || e instanceof RuntimeUnavailable) throw e;
      throw new RuntimeUnavailable(`${req.method} ${req.path}: ${(e as Error)?.message ?? String(e)}`);
    }
    if (res.status === 502 && res.headers["x-rt-reason"] === "binding_upstream") {
      throw new RuntimeUnavailable(`${req.method} ${req.path}: binding_upstream`);
    }
    if (res.status < 200 || res.status > 299) throw decodeError(res);
    return res;
  }

  async call<V>(req: CtlReq): Promise<V> {
    return (await this.raw(req)).body as V;
  }

  private async tagged<V extends { etag?: string }>(req: CtlReq): Promise<WithEtag<V>> {
    const res = await this.raw(req);
    const value = res.body as V;
    return { value, etag: res.headers["etag"] ?? value?.etag ?? "" };
  }

  // tenants (operator)
  createTenant = (b: T.TenantCreate) => this.call<T.Tenant>({ method: "POST", path: "/v1/tenants", body: b });
  listTenants = (cursor?: string) =>
    this.call<T.Page<T.Tenant>>({ method: "GET", path: "/v1/tenants", query: cur(cursor) });
  getTenant = (t: string) => this.call<T.Tenant>({ method: "GET", path: `/v1/tenants/${seg(t)}` });
  updateTenant = (t: string, b: T.TenantPatch) =>
    this.call<T.Tenant>({ method: "PATCH", path: `/v1/tenants/${seg(t)}`, body: b });
  deleteTenant = (t: string, purge = false) =>
    this.call<null>({ method: "DELETE", path: `/v1/tenants/${seg(t)}`, query: purge ? { purge: 1 } : undefined });
  createTenantKey = (t: string, b: T.KeyCreate) =>
    this.call<T.KeyCreated>({ method: "POST", path: `/v1/tenants/${seg(t)}/keys`, body: keyBody(b) });
  revokeTenantKey = (t: string, k: string) =>
    this.call<null>({ method: "DELETE", path: `/v1/tenants/${seg(t)}/keys/${seg(k)}` });
  tenantUsage = (t: string) => this.call<T.Usage[]>({ method: "GET", path: `/v1/tenants/${seg(t)}/usage` });
  listPlans = () => this.call<T.Plan[]>({ method: "GET", path: "/v1/plans" });
  runtimeVersion = () => this.call<T.VersionInfo>({ method: "GET", path: "/v1/version" });

  // self
  me = () => this.call<T.Me>({ method: "GET", path: "/v1/me" });
  limits = () => this.call<T.Limits>({ method: "GET", path: "/v1/limits" });

  // keys (tenant)
  listKeys = () => this.call<T.Key[]>({ method: "GET", path: "/v1/keys" });
  createKey = (b: T.KeyCreate) => this.call<T.KeyCreated>({ method: "POST", path: "/v1/keys", body: keyBody(b) });
  revokeKey = (k: string) => this.call<null>({ method: "DELETE", path: `/v1/keys/${seg(k)}` });

  // projects
  listProjects = (cursor?: string) =>
    this.call<T.Page<T.Project>>({ method: "GET", path: "/v1/projects", query: cur(cursor) });
  getProject = (p: string) => this.call<T.Project>({ method: "GET", path: `/v1/projects/${seg(p)}` });
  getProjectEnvironments = (p: string) =>
    this.call<T.ProjectEnvironments>({ method: "GET", path: `/v1/projects/${seg(p)}/environments` });
  createProject = (b: T.ProjectCreate) => this.call<T.Project>({ method: "POST", path: "/v1/projects", body: b });
  updateProject = (p: string, b: T.ProjectPatch) =>
    this.call<T.Project>({ method: "PATCH", path: `/v1/projects/${seg(p)}`, body: b });
  deleteProject = (p: string) => this.call<null>({ method: "DELETE", path: `/v1/projects/${seg(p)}` });

  // services
  listServices = (f: T.ServiceFilter = {}) =>
    this.call<T.Page<T.Service>>({ method: "GET", path: "/v1/services", query: { ...f } });
  getService = (s: string) => this.tagged<T.Service>({ method: "GET", path: svc(s) });
  createService = (b: T.ServiceCreate) => this.call<T.Service>({ method: "POST", path: "/v1/services", body: b });
  patchService = (s: string, b: T.ServicePatch, ifMatch: string) =>
    this.call<T.Service>({ method: "PATCH", path: svc(s), body: b, headers: ifMatchH(ifMatch) });
  deleteService = (s: string, keepData = false) =>
    this.call<null>({ method: "DELETE", path: svc(s), query: keepData ? { keep_data: 1 } : undefined });

  // versions
  /** body: source text (or base64 with contentType ending ";base64"). */
  uploadVersion = (s: string, body: string, contentType: string, o: T.UploadOpts = {}) =>
    this.call<T.Version>({
      method: "POST",
      path: `${svc(s)}/versions`,
      query: { activate: o.activate ? 1 : undefined, compile: o.compile },
      body,
      contentType,
    });
  getVersion = (s: string, v: number) => this.call<T.Version>({ method: "GET", path: ver(s, v) });
  listVersions = (s: string) => this.call<T.Version[]>({ method: "GET", path: `${svc(s)}/versions` });
  versionSource = async (s: string, v: number) => {
    const res = await this.raw({ method: "GET", path: `${ver(s, v)}/source` });
    return { body: res.body, encoding: res.encoding, contentType: res.headers["content-type"] ?? "" };
  };
  rebuild = (s: string, v: number) => this.call<T.Version>({ method: "POST", path: `${ver(s, v)}/rebuild` });
  setLive = (s: string, version: number, ifMatch = "") =>
    this.call<T.Service>({ method: "PUT", path: `${svc(s)}/live`, body: { version }, headers: ifMatchH(ifMatch) });

  // logs (polled; SDK results cannot stream)
  logs = (s: string, q: T.LogQuery = {}) =>
    this.call<T.Page<T.LogLine>>({ method: "GET", path: `${svc(s)}/logs`, query: { ...q } });

  // env, secrets
  getEnv = (s: string) => this.call<Record<string, string>>({ method: "GET", path: `${svc(s)}/env` });
  putEnv = (s: string, env: Record<string, string>) =>
    this.call<Record<string, string>>({ method: "PUT", path: `${svc(s)}/env`, body: env });
  listSecrets = (s: string) => this.call<T.SecretName[]>({ method: "GET", path: `${svc(s)}/secrets` });
  putSecret = (s: string, name: string, value: string) =>
    this.call<null>({ method: "PUT", path: `${svc(s)}/secrets/${seg(name)}`, body: { value } });
  deleteSecret = (s: string, name: string) =>
    this.call<null>({ method: "DELETE", path: `${svc(s)}/secrets/${seg(name)}` });

  // schedules
  listSchedules = (s: string) => this.call<T.Schedule[]>({ method: "GET", path: `${svc(s)}/schedules` });
  listOnceSchedules = (s: string, cursor?: string) =>
    this.call<T.Page<T.OnceSchedule>>({
      method: "GET",
      path: `${svc(s)}/schedules/once`,
      query: { limit: 200, cursor },
    });
  createSchedule = (s: string, b: T.ScheduleBody) =>
    this.call<T.Schedule>({ method: "POST", path: `${svc(s)}/schedules`, body: b });
  updateSchedule = (s: string, id: string, b: T.ScheduleBody) =>
    this.call<T.Schedule>({ method: "PATCH", path: `${svc(s)}/schedules/${seg(id)}`, body: b });
  deleteSchedule = (s: string, id: string) =>
    this.call<null>({ method: "DELETE", path: `${svc(s)}/schedules/${seg(id)}` });

  // queue
  queueStats = (s: string) => this.call<T.QueueStats>({ method: "GET", path: `${svc(s)}/queue` });
  enqueue = (s: string, b: T.EnqueueBody) =>
    this.call<{ id: string }>({ method: "POST", path: `${svc(s)}/queue`, body: b });
  listDLQ = (s: string) => this.call<{ items: T.DLQItem[] }>({ method: "GET", path: `${svc(s)}/dlq` });
  purgeDLQ = (s: string) => this.call<null>({ method: "DELETE", path: `${svc(s)}/dlq` });
  redriveDLQ = (s: string) => this.call<{ redriven: number }>({ method: "POST", path: `${svc(s)}/dlq/redrive` });

  // hosts, stats, events
  listHosts = (s: string) => this.call<T.Host[]>({ method: "GET", path: `${svc(s)}/hosts` });
  putHost = (s: string, h: string) => this.call<T.Host>({ method: "PUT", path: `${svc(s)}/hosts/${seg(h)}` });
  deleteHost = (s: string, h: string) => this.call<null>({ method: "DELETE", path: `${svc(s)}/hosts/${seg(h)}` });
  stats = (s: string, window?: string) =>
    this.call<unknown>({ method: "GET", path: `${svc(s)}/stats`, query: { window } });
  events = (s: string, cursor?: string) =>
    this.call<T.Page<T.Event>>({ method: "GET", path: `${svc(s)}/events`, query: cur(cursor) });

  // node (operator)
  nodeStatus = () => this.call<T.NodeStatus>({ method: "GET", path: "/v1/node/status" });
  nodeConfig = () => this.call<unknown>({ method: "GET", path: "/v1/node/config" });
  putNodeConfig = (b: T.NodeConfigUpdate) =>
    this.call<T.NodeConfigApplied>({ method: "PUT", path: "/v1/node/config", body: b });
  nodeCache = () => this.call<unknown>({ method: "GET", path: "/v1/node/cache" });
  nodeScheduler = () => this.call<unknown>({ method: "GET", path: "/v1/node/scheduler" });
  drainNode = () => this.call<null>({ method: "POST", path: "/v1/node/drain" });
}

function ifMatchH(v: string): Record<string, string> | undefined {
  return v ? { "if-match": v } : undefined;
}

/** Drop empty project_ids/environments: absent = unrestricted, [] = nothing. */
function keyBody(b: T.KeyCreate): T.KeyCreate {
  const out: T.KeyCreate = { ...b };
  if (!out.project_ids?.length) delete out.project_ids;
  if (!out.environments?.length) delete out.environments;
  return out;
}

export class Runtime {
  private readonly timeoutMs: number;
  constructor(
    private readonly ctl: RtCtl,
    opts: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? ctl.timeoutMs ?? DEFAULT_RUNTIME_TIMEOUT_MS;
  }
  op(): Scoped {
    return new Scoped((r) => this.ctl.op(r), this.timeoutMs);
  }
  as(key: string): Scoped {
    return new Scoped((r) => this.ctl.tenant(key, r), this.timeoutMs);
  }
}

// ---- real RtCtl over the rtctl operator SDK ----

type SdkFn = (arg?: unknown) => Promise<unknown>;
export type SdkHandle = Record<string, SdkFn>;

function fn(h: SdkHandle, name: string): SdkFn {
  const f = h[name];
  if (!f) throw new RuntimeUnavailable(`rtctl.${name} missing`);
  return f;
}

function toWire(req: CtlReq): WireReq {
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v === undefined || v === "" || v === false) continue;
    query[k] = v === true ? "1" : String(v);
  }
  const w: WireReq = { method: req.method, path: req.path };
  if (Object.keys(query).length) w.query = query;
  if (req.headers) w.headers = req.headers;
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") {
      w.body = req.body;
      w.contentType = req.contentType ?? "text/plain";
    } else {
      w.body = JSON.stringify(req.body);
      w.contentType = req.contentType ?? "application/json";
    }
  }
  return w;
}

/** Parse a wire body: JSON when the content type says so, text otherwise. */
export function fromWire(w: WireRes, body: string | undefined): CtlRes {
  const ct = w.headers["content-type"] ?? "";
  let parsed: unknown = body ?? null;
  if (body !== undefined && body !== "" && w.encoding !== "base64" && /\bjson\b/.test(ct)) {
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = body;
    }
  }
  if (body === "" || w.status === 204) parsed = null;
  const res: CtlRes = { status: w.status, headers: w.headers, body: parsed };
  if (w.encoding) res.encoding = w.encoding;
  return res;
}

let seq = 0;
function chunkId(random: (n: number) => Uint8Array): string {
  const b = random(12);
  return `c${(seq++).toString(36)}_${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** RtCtl over `sdk("rtctl")`. Splits request bodies and joins response bodies over CHUNK. */
export function sdkRtCtl(h: SdkHandle, random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): RtCtl {
  const run = async (name: "op" | "tenant", req: CtlReq, key?: string): Promise<CtlRes> => {
    const w = toWire(req);
    if (key !== undefined) w.key = key;
    if (w.body !== undefined && w.body.length > CHUNK) {
      const id = chunkId(random);
      const parts = Math.ceil(w.body.length / CHUNK);
      for (let i = 0; i < parts; i++) {
        await fn(h, "put")({ id, index: i, data: w.body.slice(i * CHUNK, (i + 1) * CHUNK) });
      }
      delete w.body;
      w.bodyRef = { id, parts };
    }
    const res = (await fn(h, name)(w)) as WireRes;
    let body = res.body;
    if (res.chunked) {
      const out: string[] = [];
      for (let i = 0; i < res.chunked.parts; i++) {
        out.push(((await fn(h, "get")({ id: res.chunked.id, index: i })) as { data: string }).data);
      }
      body = out.join("");
    }
    return fromWire(res, body);
  };
  return {
    op: (req) => run("op", req),
    tenant: (key, req) => run("tenant", req, key),
  };
}
