// In-memory RtCtl for unit tests.
// Mirrors the two error shapes a real call can produce:
//   - control API: JSON envelope {error:{code,message,details}} (auth, scope, validation, 404, 409, 412)
//   - binding refusal: text/plain body + `x-rt-reason` (path outside the
//     binding's allowed_paths, injected rate_limited/binding_upstream)
// `op` acts as the operator token (no x-rt-tenant: bindings strip it);
// `tenant(key)` authenticates `rtk_<id>_<secret>` keys like the runtime.
import type * as T from "../../src/runtime/types.ts";
import type { CtlReq, CtlRes, RtCtl } from "../../src/runtime/types.ts";

// Keep in sync with sdk/rtctl/mod.ts (OP_PATHS / TENANT_PATHS).
const OP_PATHS = ["/v1/tenants", "/v1/tenants/*", "/v1/plans", "/v1/plans/*", "/v1/node/status", "/v1/node/config", "/v1/node/cache", "/v1/node/scheduler", "/v1/node/drain", "/v1/node/series", "/v1/node/stats", "/v1/node/events", "/v1/node/backups", "/v1/node/backups/status", "/v1/version", "/v1/hosts", "/v1/hosts/*", "/v1/services/*/hosts/*"];
const TENANT_PATHS = ["/v1/scratch", "/v1/services", "/v1/services/*", "/v1/projects", "/v1/projects/*", "/v1/keys", "/v1/keys/*", "/v1/tenants/*/usage", "/v1/me", "/v1/limits"];
const glob = (p: string) => new RegExp("^" + p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
const OP_RE = OP_PATHS.map(glob);
const TENANT_RE = TENANT_PATHS.map(glob);

export const VALID_SCOPES = new Set<string>([
  "services:read", "services:write", "deploy", "invoke", "logs:read", "env:write",
  "secrets:write", "queue:write", "data:admin", "data:read", "keys:write", "sockets:write",
]);
const SLUG_RE = /^[a-z][a-z0-9-]{1,62}$/;
const ENV_RE = /^[a-z][a-z0-9-]{0,31}$/;

class ApiErr {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly message: string,
    readonly details: Record<string, unknown> = {},
    readonly retryAfter?: number,
  ) {}
}
const unauthorized = () => new ApiErr(401, "unauthorized", "missing or invalid credential");
const notFound = () => new ApiErr(404, "not_found", "not found");
const scopeErr = (details: Record<string, unknown> = {}) => new ApiErr(403, "insufficient_scope", "insufficient scope", details);
const escalation = () => scopeErr({ reason: "escalation" });
const invalid = (msg: string, code = "validation_failed") => new ApiErr(422, code, msg);

// The checks of crates/rt-api/src/from_url.rs, in its order.
const REFUSED_HEADERS = new Set(["host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"]);
const bytes = (s: string) => new TextEncoder().encode(s).length;
function checkMetaText(field: string, v: unknown, max: number): string | null {
  if (typeof v !== "string") return `meta: ${field} must be a string`;
  // eslint-disable-next-line no-control-regex
  if (bytes(v) > max || (field !== "message" && /[\u0000-\u001f\u007f-\u009f]/.test(v))) return `meta: ${field} too long or has control characters`;
  return null;
}
function checkFromUrl(b: Record<string, unknown>): string | null {
  let url: URL;
  try {
    url = new URL(String(b.url));
  } catch {
    return "url is not a valid URL";
  }
  // The real route lets the fetcher refuse http (egress_denied); tests treat it as a bad request.
  if (url.protocol !== "https:") return "url must be https";
  for (const n of Object.keys((b.headers ?? {}) as object)) {
    const lower = n.toLowerCase();
    if (REFUSED_HEADERS.has(lower) || lower.startsWith("x-rt-")) return `header ${lower} cannot be set`;
  }
  if (typeof b.strip_components === "number" && b.strip_components > 16) return "strip_components too large";
  if (b.activate !== undefined && b.activate !== null && b.activate !== "after_build") return "activate is after_build or absent";
  if (b.activate === "after_build" && b.compile === "lazy") return "activate after_build implies an eager build";
  if (b.meta === undefined || b.meta === null) return null;
  const meta = b.meta as Record<string, unknown>;
  if (bytes(JSON.stringify(meta)) > 4096) return "meta is limited to 4096 bytes";
  for (const [k, v] of Object.entries(meta)) {
    if (k === "label") {
      const e = checkMetaText("label", v, 256);
      if (e) return e;
    } else if (k !== "git") return `meta: unknown key ${k}`;
  }
  const limits: Record<string, number> = { ref: 256, repo: 512, author: 256, message: 1024 };
  for (const [k, v] of Object.entries((meta.git ?? {}) as Record<string, unknown>)) {
    if (k === "sha") {
      if (typeof v !== "string" || !/^[0-9a-fA-F]{7,64}$/.test(v)) return "meta: git.sha";
      continue;
    }
    const max = limits[k];
    if (max === undefined) return `meta: unknown key git.${k}`;
    const e = checkMetaText(k, v, max);
    if (e) return e;
    if (k === "repo" && String(v).includes("://") && String(v).includes("@")) return "meta: git.repo must not carry credentials";
  }
  return null;
}
/** Query and header values stay out: they are credentials. */
function fromUrlFingerprint(b: Record<string, unknown>): string {
  const u = new URL(String(b.url));
  return JSON.stringify([u.origin + u.pathname, Object.keys((b.headers ?? {}) as object).sort(), b.sha256 ?? "", b.strip_components ?? 0, b.subdir ?? "", b.entry ?? "", b.meta ?? "", b.compile ?? "", b.activate ?? ""]);
}
const conflict = (code: string, msg: string) => new ApiErr(409, code, msg);

interface FTenant { id: string; name: string; plan: string; overrides?: unknown; created_at: number; disabled: boolean }
interface FKey {
  id: string; tenant: string; name: string | null; secret: string; scopes: string[];
  project_ids: string[] | null; environments: string[] | null; created_at: number;
  expires_at: number | null; revoked: boolean; selfService: boolean;
}
interface FVersion { version: number; source: string; contentType: string; build_state: string; failure: T.VersionFailure | null; created_at: number }
interface FService {
  view: Omit<T.Service, "etag" | "status" | "live_version">;
  etag: number; live: number | null; versions: FVersion[];
  env: Record<string, string>; secrets: Map<string, number>;
  schedules: T.Schedule[]; once: T.OnceSchedule[];
  queue: { id: string; body: unknown }[]; dlq: T.DLQItem[]; dedup: Map<string, string>;
  logs: T.LogLine[]; logSeq: number; events: T.Event[];
}
export interface FSwitch {
  id: string; service: string; kind: string; state: string; from_version?: number; to_version: number;
  inflight_old: number; interrupted: boolean; error?: string; drain_deadline?: number;
  warnings: { code: string; names?: string[] }[]; created_at: number; updated_at: number;
}
const branchOf = (s: FService) => (s.view as unknown as { scratch?: { of: string } }).scratch;
interface Principal { operator: boolean; tenant: string; key: FKey | null }

export interface FakePlan { maxServices?: number; maxSchedules?: number; allowed_triggers?: string[] }
export interface Recorded { scope: "op" | "tenant"; key?: string; method: string; path: string; query: Record<string, string>; body: unknown; headers: Record<string, string> }
export interface Injected { status: number; code?: string; reason?: string; retryAfter?: number; match?: (r: Recorded) => boolean }

const subset = (child: string[] | null, parent: string[] | null) =>
  parent === null || (child !== null && child.every((c) => parent.includes(c)));

export class FakeRtCtl implements RtCtl {
  /** Call deadline read by Runtime; tests shorten it to exercise runtime_timeout. */
  timeoutMs?: number;
  now: () => number = () => Date.now();
  readonly calls: Recorded[] = [];
  readonly plans = new Map<string, FakePlan>([["free", {}], ["pro", {}], ["rtweb", {}]]);
  readonly tenants = new Map<string, FTenant>();
  readonly keys = new Map<string, FKey>();
  readonly projects = new Map<string, T.Project>();
  readonly services = new Map<string, FService>();
  readonly hosts = new Map<string, T.Host & { service: string }>();
  nodeConfig: Record<string, unknown> = { default_profile: "standard", degradation_mode: "normal" };
  drained = false;
  /** Switch rows per service id. */
  readonly switches = new Map<string, FSwitch[]>();
  inflightOld = 0;
  /** Extra fields of a dry-run answer, to prove the console forwards only what it names. */
  dryRunExtra: Record<string, unknown> = {};
  private failures: Injected[] = [];
  private n = 0;

  private id(prefix: string) {
    return `${prefix}${(++this.n).toString(36).padStart(10, "0")}`;
  }
  private hex(n: number) {
    return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  // ---- test helpers ----

  /** Fail the next matching call. With `reason`, answers as a binding refusal (text + x-rt-reason). */
  failNext(f: Injected): void {
    this.failures.push(f);
  }
  /** Create a tenant with a default project and a full-scope key; returns its secret. */
  seedTenant(name: string, plan = "free"): { tenant: T.Tenant; key: string; keyId: string } {
    const t = this.makeTenant(name, plan);
    const k = this.issueKey(t.id, { scopes: [...VALID_SCOPES] as T.Scope[] }, null, false);
    if (k instanceof ApiErr) throw new Error(k.message);
    return { tenant: { ...t }, key: secretOf(k), keyId: k.id };
  }
  emitLog(svcId: string, msg: string, fields?: Record<string, unknown>, level = "info"): void {
    const s = this.services.get(svcId);
    if (!s) return;
    const line: T.LogLine = { seq: ++s.logSeq, ts: this.now(), level, service_id: svcId, kind: "runtime", msg };
    if (fields) line.fields = fields;
    s.logs.push(line);
  }
  addOnceSchedule(svcId: string, runAt: number): string {
    const id = this.id("sch_");
    this.services.get(svcId)?.once.push({ id, kind: "once", run_at: runAt });
    return id;
  }
  deadLetter(svcId: string, body: unknown): void {
    this.services.get(svcId)?.dlq.push({ id: this.id("msg_"), body, attempts: 3, failed_at: this.now() });
  }
  failBuild(svcId: string, diagnostics: unknown = []): void {
    const v = this.services.get(svcId)?.versions.at(-1);
    if (v) {
      v.build_state = "failed";
      v.failure = { reason: "build_failed", message: "build failed", diagnostics };
    }
  }
  /** Every `versions/from-url` call, credentials included: the runtime's route is mocked here to its documented shape. */
  readonly fromUrlCalls: { service: string; body: Record<string, unknown>; idempotencyKey: string }[] = [];
  fromUrlError: { status: number; code: string; message: string } | null = null;
  /** How long the route holds its response: the real one answers after the download. */
  private readonly fromUrlIdem = new Map<string, { fp: string; res: CtlRes }>();
  nodeSeries: T.NodeSeriesPoint[] = [];
  nodeStats: T.NodeStatsItem[] = [];
  readonly nodeStatsQueries: Record<string, string | undefined>[] = [];
  nodeEvents: T.NodeEvent[] = [];
  nodeHost: T.NodeStatus["host"] | undefined;
  backupStatusOver: Partial<T.BackupStatus> = {};
  backups: T.Backup[] = [];
  readonly migrations = new Map<string, T.Migrations>();
  liveError: { status: number; code: string; message: string; details?: Record<string, unknown> } | null = null;
  liveApplied: string[] | null = null;
  nextBuildState: "ready" | "failed" = "ready";
  /** The code the next from-url's fetch ends in, on the version: the POST itself still answers 202. */
  fromUrlFailure: string | null = null;
  /** Keeps from-url versions in "fetching" until releaseFetches. */
  fromUrlHold = false;
  private fromUrlHeld: (() => void)[] = [];
  releaseFetches() {
    this.fromUrlHold = false;
    for (const f of this.fromUrlHeld.splice(0)) f();
  }
  /** Where an async promote is after its 202. */
  asyncLiveState = "draining";
  readonly bundles = new Map<string, string>();
  bundleBytes = "AAAA";
  readonly imports: { query: Record<string, string>; body: unknown; idempotencyKey: string }[] = [];
  readonly scratchCalls: Record<string, unknown>[] = [];
  scratchError: { status: number; code: string; message: string } | null = null;
  readonly dataReads: { service: string; path: string; body: unknown }[] = [];
  dataRefusal: { status: number; code: string; message: string } | null = null;

  branchOf(parentId: string, name: string): FService | undefined {
    return [...this.services.values()].find((x) => branchOf(x)?.of === parentId && (x.view as unknown as { scratch: { name: string } }).scratch.name === name);
  }

  /** A branch of parent as the runtime stores it: its own service, env label and data, one live version. */
  seedBranch(parentId: string, name: string, o: { expires_at?: number; live?: boolean; env?: Record<string, string>; project?: string } = {}): FService {
    const parent = this.services.get(parentId);
    if (!parent) throw new Error("no parent");
    const id = this.id("svc_");
    const view = {
      ...parent.view, id, slug: `${parent.view.slug}-br-${name}`, environment: `br-${name}`,
      ...(o.project ? { project: o.project } : {}),
      scratch: { of: parentId, kind: "branch", name, expires_at: o.expires_at ?? null },
    };
    const s: FService = {
      view, etag: 1, live: o.live === false ? null : 1, env: o.env ?? {}, secrets: new Map(), schedules: [], once: [],
      versions: [{ version: 1, source: "x", contentType: "application/typescript", build_state: "ready", failure: null, created_at: this.now() }],
      queue: [], dlq: [], dedup: new Map(), logs: [], logSeq: 0, events: [],
    };
    this.services.set(id, s);
    return s;
  }
  service(svcId: string): FService | undefined {
    return this.services.get(svcId);
  }

  // ---- RtCtl ----

  async op(req: CtlReq): Promise<CtlRes> {
    return this.dispatch("op", req);
  }
  async tenant(key: string, req: CtlReq): Promise<CtlRes> {
    return this.dispatch("tenant", req, key);
  }

  private async dispatch(scope: "op" | "tenant", req: CtlReq, key?: string): Promise<CtlRes> {
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v === undefined || v === "" || v === false) continue;
      query[k] = v === true ? "1" : String(v);
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v;
    // Round-trip JSON like the wire does, so tests cannot pass shared references.
    const body = req.body === undefined || typeof req.body === "string" ? req.body : JSON.parse(JSON.stringify(req.body));
    const rec: Recorded = { scope, method: req.method, path: req.path, query, body, headers };
    if (key !== undefined) rec.key = key;
    this.calls.push(rec);

    if (!(scope === "op" ? OP_RE : TENANT_RE).some((re) => re.test(req.path)) || /\/\.\.?(\/|$)|%2e|\/\//i.test(req.path)) {
      return refusal(403, "binding_denied");
    }
    const fi = this.failures.findIndex((f) => !f.match || f.match(rec));
    if (fi >= 0) {
      const f = this.failures.splice(fi, 1)[0] as Injected;
      if (f.reason) return refusal(f.status, f.reason, f.retryAfter);
      return errRes(new ApiErr(f.status, f.code ?? `http_${f.status}`, "injected failure", {}, f.retryAfter));
    }
    const p = this.authenticate(scope, key);
    if (p instanceof ApiErr) return errRes(p);
    try {
      const out = this.route(p, req.method, req.path, query, body, headers);
      return out instanceof ApiErr ? errRes(out) : out;
    } catch (e) {
      if (e instanceof ApiErr) return errRes(e);
      throw e;
    }
  }

  private authenticate(scope: "op" | "tenant", key?: string): Principal | ApiErr {
    if (scope === "op") return { operator: true, tenant: "", key: null };
    const m = /^rtk_(.+)_([0-9a-f]+)$/.exec(key ?? "");
    const k = m ? this.keys.get(m[1] ?? "") : undefined;
    if (!k || k.secret !== m?.[2] || k.revoked || (k.expires_at !== null && k.expires_at <= this.now())) return unauthorized();
    return { operator: false, tenant: k.tenant, key: k };
  }

  private route(p: Principal, method: string, path: string, q: Record<string, string>, body: unknown, h: Record<string, string>): CtlRes | ApiErr {
    const segs = path.split("/").slice(1).map(decodeURIComponent); // ["v1", ...]
    const r = segs.slice(1);
    const need = (scope: string) => {
      if (scope === "operator" ? !p.operator : !p.operator && !p.key?.scopes.includes(scope)) throw scopeErr();
    };
    const is = (m: string, ...pat: string[]) => method === m && r.length === pat.length && pat.every((x, i) => x === "*" || x === r[i]);

    // tenants, plans, node, version (operator)
    if (is("GET", "version")) return ok({ version: "rtctl-fake" });
    if (is("GET", "plans")) return need("operator"), ok([...this.plans.keys()].map((n) => ({ name: n, settings: this.plans.get(n) })));
    if (is("GET", "tenants")) return need("operator"), ok(page([...this.tenants.values()]));
    if (is("POST", "tenants")) {
      need("operator");
      const b = obj(body);
      if (typeof b.name !== "string" || !b.name) return invalid("name is required");
      const plan = typeof b.plan === "string" ? b.plan : "free";
      if (!this.plans.has(plan)) return invalid(`unknown plan ${plan}`);
      const t = this.makeTenant(b.name, plan);
      if (b.overrides !== undefined) t.overrides = b.overrides;
      return ok(t, 201);
    }
    if (r[0] === "tenants" && r.length >= 2) {
      const t = this.tenants.get((r[1] ?? ""));
      if (is("GET", "tenants", "*", "usage")) {
        need("logs:read");
        if (!t || (!p.operator && p.tenant !== t.id)) return notFound();
        return ok([]);
      }
      need("operator");
      if (!t) return notFound();
      if (is("GET", "tenants", "*")) return ok(t);
      if (is("PATCH", "tenants", "*")) {
        const b = obj(body);
        if (typeof b.plan === "string") {
          if (!this.plans.has(b.plan)) return invalid(`unknown plan ${b.plan}`);
          t.plan = b.plan;
        }
        if (typeof b.name === "string") t.name = b.name;
        if (typeof b.disabled === "boolean") t.disabled = b.disabled;
        if (b.overrides !== undefined) t.overrides = b.overrides;
        return ok(t);
      }
      if (is("DELETE", "tenants", "*")) {
        const svcs = [...this.services.values()].filter((s) => s.view.tenant_id === t.id);
        if (svcs.length && q.purge !== "1") return conflict("tenant_not_empty", "tenant still owns services");
        for (const s of svcs) this.dropService(s.view.id);
        for (const k of this.keys.values()) if (k.tenant === t.id) k.revoked = true;
        for (const [id, pr] of this.projects) if (pr.tenant_id === t.id) this.projects.delete(id);
        this.tenants.delete(t.id);
        return noContent();
      }
      if (is("POST", "tenants", "*", "keys")) {
        const k = this.issueKey(t.id, obj(body) as unknown as T.KeyCreate, null, false);
        return k instanceof ApiErr ? k : ok(created(k), 201);
      }
      if (is("DELETE", "tenants", "*", "keys", "*")) {
        const k = this.keys.get((r[3] ?? ""));
        if (!k || k.tenant !== t.id || k.revoked) return notFound();
        k.revoked = true;
        return noContent();
      }
    }
    if (r[0] === "node") {
      need("operator");
      if (is("GET", "node", "status")) {
        return ok({
          version: "rtctl-fake", mode: this.drained ? "draining" : "normal", default_profile: String(this.nodeConfig.default_profile),
          v8_sandbox: true, processors: 4, kinds: {}, memory: {}, inflight: 0, sockets: { open: 0, objects: 0, pending: 0, max: 0 }, ...(this.nodeHost ? { host: this.nodeHost } : {}),
        });
      }
      if (is("GET", "node", "config")) return ok(this.nodeConfig);
      if (is("PUT", "node", "config")) {
        const b = obj(body);
        const applied: string[] = [];
        for (const k of ["default_profile", "degradation_mode", "rate_limit"]) {
          if (b[k] !== undefined) {
            this.nodeConfig[k] = b[k];
            applied.push(k);
          }
        }
        return ok({ applied, pending_restart: [] });
      }
      if (is("GET", "node", "cache")) return ok({ entries: 0 });
      if (is("GET", "node", "scheduler")) return ok({ kinds: {} });
      if (is("POST", "node", "drain")) return (this.drained = true), noContent();
      if (is("GET", "node", "series")) return ok({ range: q.range ?? "1h", step_s: q.range === "1h" ? 60 : 300, points: this.nodeSeries });
      if (is("GET", "node", "stats")) {
        this.nodeStatsQueries.push({ ...q });
        const limit = Math.min(Number(q.limit ?? 100), 200);
        const start = Number(q.cursor ?? 0);
        const end = start + limit;
        return ok({ items: this.nodeStats.slice(start, end), next_cursor: end < this.nodeStats.length ? String(end) : null });
      }
      if (is("GET", "node", "events")) {
        const after = Number(q.after ?? 0);
        return ok({ items: this.nodeEvents.filter((e) => Number(e.id) > after), next_cursor: null });
      }
      if (is("GET", "node", "backups")) return ok({ items: this.backups, next_cursor: null });
      if (is("GET", "node", "backups", "status")) {
        return ok({ enabled: true, schedule: "0 3 * * *", last_ok_at: null, last_ok_id: null, last_failure: null, next_at: null, running_id: this.backups.find((b) => b.state === "running")?.id ?? null, last_restored_at: null, destination: { kind: "local" }, ...this.backupStatusOver });
      }
      if (is("POST", "node", "backups")) {
        if (this.backups.some((b) => b.state === "running")) return conflict("backup_running", "a backup is running");
        const id = `bkp_${this.backups.length + 1}`;
        this.backups.unshift({ id, state: "running", trigger: "api", started_at: this.now(), finished_at: null, bytes: null, sha256: null, encrypted: false, verified_at: null, rt_version: "rtctl-fake", failure: null });
        return ok({ id, state: "running" }, 202);
      }
    }

    // self
    if (is("GET", "me")) {
      const t = p.tenant ? this.tenants.get(p.tenant) : undefined;
      return ok({
        principal: p.operator ? "operator" : "key", tenant_id: p.tenant || null, key_id: p.key?.id ?? null,
        scopes: p.key?.scopes ?? [], project_ids: p.key?.project_ids ?? null, environments: p.key?.environments ?? null,
        plan: t ? { name: t.plan, settings: this.plans.get(t.plan) } : null, version: "rtctl-fake",
      });
    }
    if (is("GET", "limits")) {
      if (!p.tenant) return invalid("x-rt-tenant is required");
      const t = (this.tenants.get(p.tenant) as FTenant);
      const pl = this.plans.get(t.plan) ?? {};
      const used = [...this.services.values()].filter((s) => s.view.tenant_id === t.id).length;
      const quota = (limit: number | undefined, u: number, period: string) =>
        ({ limit: limit ?? null, used: u, remaining: limit === undefined ? null : Math.max(0, limit - u), period });
      return ok({
        plan: t.plan, day: new Date(this.now()).toISOString().slice(0, 10), resets_at: 0,
        invocations: quota(undefined, 0, "day"), egress_bytes: quota(undefined, 0, "day"), storage_bytes: quota(undefined, 0, "total"),
        services: quota(pl.maxServices, used, "total"), schedules: quota(pl.maxSchedules, 0, "per_service"),
      });
    }

    // keys (self-service)
    if (r[0] === "keys") {
      need("keys:write");
      if (!p.tenant) return invalid("x-rt-tenant is required");
      if (is("GET", "keys")) {
        return ok([...this.keys.values()].filter((k) => k.tenant === p.tenant && !k.revoked && canManage(p, k)).map(keyView));
      }
      if (is("POST", "keys")) {
        const n = [...this.keys.values()].filter((k) => k.tenant === p.tenant && k.selfService && !k.revoked).length;
        if (n >= 200) return new ApiErr(403, "quota_exceeded", "self-service key limit reached", { quota: "keys" });
        const k = this.issueKey(p.tenant, obj(body) as unknown as T.KeyCreate, p.key, true);
        return k instanceof ApiErr ? k : ok(created(k), 201);
      }
      if (is("DELETE", "keys", "*")) {
        const k = this.keys.get((r[1] ?? ""));
        if (!k || k.tenant !== p.tenant || k.revoked || !canManage(p, k)) return notFound();
        k.revoked = true;
        return noContent();
      }
    }

    // projects
    if (r[0] === "projects") return this.projectRoutes(p, method, r, body, need, is);

    // services
    if (is("POST", "scratch")) {
      need("services:write");
      if (this.scratchError) return new ApiErr(this.scratchError.status, this.scratchError.code, this.scratchError.message);
      const b = obj(body);
      const parent = this.serviceFor(p, String(b.of ?? ""));
      if (!parent) return notFound();
      const made = this.seedBranch(parent.view.id, String(b.name));
      const hex8 = made.view.id.replace(/[^a-z0-9]/g, "").slice(-8).padStart(8, "0");
      const mv = made.view as unknown as { slug: string; environment: string; scratch: Record<string, unknown> };
      mv.slug = `${parent.view.slug}-${String(b.name)}-${hex8}`;
      mv.environment = `preview-${hex8}`;
      mv.scratch = { of: parent.view.id, kind: "preview", name: String(b.name), expires_at: this.now() + Number(b.ttl_seconds ?? 0) * 1000 };
      made.live = null;
      made.versions = [];
      this.scratchCalls.push(b);
      return ok(svcView(made), 201);
    }
    if (r[0] === "services") return this.serviceRoutes(p, method, r, q, body, h, need, is);
    return notFound();
  }

  private projectRoutes(
    p: Principal, method: string, r: string[], body: unknown,
    need: (s: string) => void, is: (m: string, ...pat: string[]) => boolean,
  ): CtlRes | ApiErr {
    need(method === "GET" ? "services:read" : "services:write");
    if (!p.tenant) return invalid("x-rt-tenant is required");
    if (is("GET", "projects")) {
      return ok(page([...this.projects.values()].filter((x) => x.tenant_id === p.tenant && (!p.key || p.key.project_ids === null || p.key.project_ids.includes(x.id)))));
    }
    if (is("POST", "projects")) {
      if (p.key && (p.key.project_ids !== null || p.key.environments !== null)) return scopeErr();
      const b = obj(body);
      if (typeof b.slug !== "string" || !SLUG_RE.test(b.slug)) return invalid(`slug ${String(b.slug)} is not valid`);
      if ([...this.projects.values()].some((x) => x.tenant_id === p.tenant && x.slug === b.slug)) {
        return conflict("project_slug_taken", "project slug already in use");
      }
      const envs = (b.environments as string[] | undefined) ?? ["production"];
      const e = validEnvs(envs);
      if (e) return e;
      const now = this.now();
      const pr: T.Project = { id: this.id("prj_"), tenant_id: p.tenant, slug: b.slug, name: typeof b.name === "string" ? b.name : b.slug, environments: envs, created_at: now, updated_at: now };
      this.projects.set(pr.id, pr);
      return ok(pr, 201);
    }
    const pr = this.projectFor(p.tenant, (r[1] ?? ""));
    if (!pr || (p.key && p.key.project_ids !== null && !p.key.project_ids.includes(pr.id))) return notFound();
    if (is("GET", "projects", "*")) return ok(pr);
    if (is("GET", "projects", "*", "environments")) {
      return ok({ environments: pr.environments.map((e) => ({ name: e, services: this.svcsIn(pr.id, e) })) });
    }
    if (is("PATCH", "projects", "*")) {
      if (p.key && p.key.environments !== null) return scopeErr();
      const b = obj(body);
      if (Array.isArray(b.environments)) {
        const envs = b.environments as string[];
        const e = validEnvs(envs);
        if (e) return e;
        const gone = pr.environments.filter((x) => !envs.includes(x) && this.svcsIn(pr.id, x) > 0);
        if (gone.length) return conflict("environment_not_empty", `environment ${gone[0]} still has services`);
        pr.environments = envs;
      }
      if (typeof b.name === "string") pr.name = b.name;
      pr.updated_at = this.now();
      return ok(pr);
    }
    if (is("DELETE", "projects", "*")) {
      if (p.key && p.key.project_ids !== null) return scopeErr();
      if (pr.slug === "default") return conflict("project_default", "the default project cannot be deleted");
      if (this.svcsIn(pr.id) > 0) return conflict("project_not_empty", "project still has services");
      this.projects.delete(pr.id);
      return noContent();
    }
    return notFound();
  }

  private serviceRoutes(
    p: Principal, method: string, r: string[], q: Record<string, string>, body: unknown, h: Record<string, string>,
    need: (s: string) => void, is: (m: string, ...pat: string[]) => boolean,
  ): CtlRes | ApiErr {
    if (is("POST", "services", "import")) {
      need("services:write");
      need("deploy");
      need("data:admin");
      this.imports.push({ query: q, body, idempotencyKey: h["idempotency-key"] ?? "" });
      if (q.from && !this.serviceFor(p, q.from)) return notFound();
      if (!q.from && !body) return invalid("a bundle or from is required");
      const made = this.createService(p, { slug: q.slug, runtime: "deno", project: q.project, environment: q.environment });
      if (made instanceof ApiErr) return made;
      return ok({ id: this.id("imp_"), service_id: (made.body as { id: string }).id, warnings: [], missing_secrets: ["API_KEY"], versions: [] }, 202);
    }
    if (is("POST", "services")) {
      need("services:write");
      return this.createService(p, obj(body));
    }
    if (is("GET", "services")) {
      need("services:read");
      const items = [...this.services.values()]
        .filter((s) => this.sees(p, s))
        .filter((s) => (!q.slug || s.view.slug === q.slug) && (!q.project || s.view.project === q.project || s.view.project_id === q.project) && (!q.environment || s.view.environment === q.environment))
        .map(svcView);
      return ok(page(items));
    }
    // Operator host routes come through rtctl-op; everything else needs a tenant key.
    const s = this.serviceFor(p, (r[1] ?? ""));
    const sub = r.slice(2);
    const at = (m: string, ...pat: string[]) => is(m, "services", "*", ...pat);
    if (!s) {
      need(method === "GET" ? "services:read" : "services:write");
      return notFound();
    }
    if (sub[0] === "hosts") return this.hostRoutes(s, method, sub, need);
    if (!p.operator && p.tenant === "") return notFound();

    if (at("GET")) return need("services:read"), ok(svcView(s), 200, { etag: etagOf(s) });
    if (at("PATCH")) {
      need("services:write");
      if (h["if-match"] && h["if-match"] !== etagOf(s)) return new ApiErr(412, "precondition_failed", "If-Match does not match the current etag");
      const b = obj(body);
      if (b.project !== undefined && b.project !== s.view.project && b.project !== s.view.project_id) return invalid("project cannot change");
      if (typeof b.environment === "string") {
        const pr = (this.projects.get(s.view.project_id) as T.Project);
        if (!pr.environments.includes(b.environment)) return invalid(`environment ${b.environment} is not in project ${pr.slug}`);
        s.view.environment = b.environment;
      }
      if (b.access !== undefined && !["public", "key", "internal"].includes(String(b.access))) return invalid("access must be public, key or internal");
      for (const k of ["name", "profile", "access", "limits", "scaling", "triggers", "ingress", "egress", "call", "deno", "wasm"] as const) {
        if (b[k] !== undefined) (s.view as Record<string, unknown>)[k] = b[k];
      }
      s.etag++;
      event(s, this.now(), "service.updated");
      return ok(svcView(s), 200, { etag: etagOf(s) });
    }
    if (at("DELETE")) return need("services:write"), this.dropService(s.view.id), noContent();
    if (at("GET", "events")) return need("services:read"), ok(page(s.events));

    // versions
    if (at("POST", "versions", "from-url")) {
      need("deploy");
      const b = obj(body);
      this.fromUrlCalls.push({ service: s.view.id, body: b, idempotencyKey: h["idempotency-key"] ?? "" });
      const refused = checkFromUrl(b);
      if (refused) return invalid(refused);
      const idemKey = h["idempotency-key"] ? `${s.view.id}|${h["idempotency-key"]}` : "";
      const fp = fromUrlFingerprint(b);
      const seen = idemKey ? this.fromUrlIdem.get(idemKey) : undefined;
      if (seen && seen.fp !== fp) return invalid("the Idempotency-Key was used with a different request", "idempotency_mismatch");
      if (seen) return seen.res;
      if (this.fromUrlError) return new ApiErr(this.fromUrlError.status, this.fromUrlError.code, this.fromUrlError.message);
      const v: FVersion = { version: s.versions.length + 1, source: String(b.url), contentType: "application/gzip", build_state: "fetching", failure: null, created_at: this.now() };
      s.versions.push(v);
      // Answered before the fetch: no digest yet, whatever the fetch comes to.
      const res = ok({ ...versionView(v), source_digest: null }, 202);
      const fail = this.fromUrlFailure;
      const finish = () => {
        v.build_state = fail ? "failed" : this.nextBuildState;
        if (fail) v.failure = { code: fail, reason: fail, message: `fetch: ${fail}` };
        if (b.activate === "after_build" && v.build_state === "ready") this.makeLive(s, v.version);
      };
      if (this.fromUrlHold) this.fromUrlHeld.push(finish);
      else finish();
      if (idemKey) this.fromUrlIdem.set(idemKey, { fp, res });
      return res;
    }
    if (at("POST", "bundle")) {
      need("data:admin");
      const b = { id: this.id("bdl_"), state: "running", bytes: null, sha256: null, expires_at: this.now() + 3_600_000, failure: null };
      this.bundles.set(b.id, s.view.id);
      return ok(b, 202);
    }
    if (sub[0] === "bundle" && method === "GET") {
      need("data:admin");
      if (this.bundles.get(String(sub[1])) !== s.view.id) return notFound();
      return { status: 206, headers: { "content-type": "application/zstd", "content-range": `bytes 0-3/${this.bundleBytes.length}`, etag: '"b1"' }, body: this.bundleBytes, encoding: "base64" };
    }
    if (sub[0] === "data" && sub[1] !== "export") {
      const reserved = this.dataRefusal;
      need("data:read");
      if (reserved) return new ApiErr(reserved.status, reserved.code, reserved.message);
      this.dataReads.push({ service: s.view.id, path: sub.slice(1).join("/"), body });
      if (at("GET", "data", "tables")) return ok({ items: [{ name: `t_${s.view.slug.replaceAll("-", "_")}`, type: "table", columns: [{ name: "id", type: "INTEGER", pk: 1 }], rows_estimate: 2 }] });
      if (at("POST", "data", "query")) return ok({ columns: ["id"], rows: [[1], [2]], truncated: false, elapsed_ms: 1 });
      if (at("GET", "data", "kv")) return ok({ items: [{ key: "k", key_b64: "aw", type: "text", size: 1, expires_at: null, preview: "v" }], next_cursor: null });
      if (at("GET", "data", "kv", "*")) return ok({ key: "k", key_b64: sub[2], type: "text", size: 1, expires_at: null, value: "v", truncated: false });
      if (at("GET", "data", "blobs")) return ok({ items: [{ key: "b", size: 1, content_type: "text/plain" }], next_cursor: null });
    }
    if (at("GET", "migrations")) return need("services:read"), ok(this.migrations.get(s.view.id) ?? { applied: [], pending_for_latest: [] });
    if (at("POST", "branches")) {
      need("services:write");
      return ok(svcView(this.seedBranch(s.view.id, String(obj(body).name))), 201);
    }
    if (at("POST", "versions")) {
      need("deploy");
      if (typeof body !== "string" || body === "") return invalid("source body is required");
      const v: FVersion = { version: s.versions.length + 1, source: body, contentType: h["content-type"] ?? "", build_state: "ready", failure: null, created_at: this.now() };
      s.versions.push(v);
      if (q.activate === "1") this.makeLive(s, v.version);
      return ok(versionView(v), 201);
    }
    if (at("GET", "versions")) return need("services:read"), ok(s.versions.map(versionView));
    if (sub[0] === "versions" && sub.length >= 2) {
      const v = s.versions[Number(sub[1]) - 1];
      if (!v || !/^\d+$/.test((sub[1] ?? ""))) return need("services:read"), notFound();
      if (at("GET", "versions", "*")) return need("services:read"), ok(versionView(v));
      if (at("GET", "versions", "*", "source")) return need("services:read"), { status: 200, headers: { "content-type": v.contentType || "application/typescript" }, body: v.source };
      if (at("POST", "versions", "*", "rebuild")) {
        need("deploy");
        v.build_state = "ready";
        v.failure = null;
        return ok(versionView(v));
      }
    }
    if (at("GET", "branches")) {
      need("services:read");
      return ok({ items: [...this.services.values()].filter((x) => branchOf(x)?.of === s.view.id).map(svcView) });
    }
    if (at("POST", "switch")) return this.switchRoute(s, p, body, h, need);
    if (at("GET", "switches")) {
      need("services:read");
      const limit = Number(q.limit ?? 50) || 50;
      const items = [...(this.switches.get(s.view.id) ?? [])].reverse();
      const start = q.cursor ? Number(q.cursor) : 0;
      const end = start + limit;
      return ok({ items: items.slice(start, end), next_cursor: end < items.length ? String(end) : null });
    }
    if (sub[0] === "switches" && sub.length >= 2) {
      // Rows are looked up within this service: an id of another app answers 404.
      const row = this.switches.get(s.view.id)?.find((x) => x.id === sub[1]);
      if (at("GET", "switches", "*")) return need("services:read"), row ? ok(row) : notFound();
      if (at("POST", "switches", "*", "rollback")) {
        need("deploy");
        if (h["if-match"] && h["if-match"] !== etagOf(s)) return new ApiErr(412, "precondition_failed", "If-Match does not match the current etag");
        if (!row) return notFound();
        if (row.from_version === undefined) return conflict("rollback_target_gone", "the version before this switch is gone");
        return ok(this.flip(s, "rollback", row.from_version), 202);
      }
    }
    if (at("PUT", "live")) {
      need("deploy");
      if (h["if-match"] && h["if-match"] !== etagOf(s)) return new ApiErr(412, "precondition_failed", "If-Match does not match the current etag");
      const n = Number(obj(body).version);
      const v = s.versions[n - 1];
      if (!v) return notFound();
      if (v.build_state === "failed") return conflict("version_not_ready", "version failed to build");
      if (q.async === "1") {
        if (obj(body).dry_run === true) return invalid("dry_run is not async");
        if (obj(body).migrate === false) need("data:admin");
        const busy = this.switches.get(s.view.id)?.some((x) => x.state === "preparing" || x.state === "migrating");
        if (busy) return conflict("switch_in_progress", "another switch is running");
        const row = this.flip(s, "promote", n);
        const first = { ...row, state: "preparing" };
        // The first read moves it on, unless a test holds it there.
        row.state = this.asyncLiveState;
        if (row.state === "failed") row.error = "migration_failed";
        else if (row.state === "preparing") s.live = row.from_version ?? null;
        return ok(first, 202);
      }
      if (obj(body).dry_run === true) {
        return ok({ dry_run: true, pending_migrations: (this.migrations.get(s.view.id)?.pending_for_latest ?? []).map((m) => m.name) });
      }
      if (this.liveError) return new ApiErr(this.liveError.status, this.liveError.code, this.liveError.message, this.liveError.details ?? {});
      this.makeLive(s, n);
      return ok({ ...svcView(s), ...(this.liveApplied ? { migrations_applied: this.liveApplied } : {}) }, 200, { etag: etagOf(s) });
    }

    // logs: cursor = last seq seen
    if (at("GET", "logs")) {
      need("logs:read");
      const after = q.cursor ? Number(q.cursor) : 0;
      const limit = Math.min(Number(q.limit ?? 100) || 100, 1000);
      const items = s.logs.filter((l) => l.seq > after && (!q.level || l.level === q.level) && (!q.kind || l.kind === q.kind)).slice(0, limit);
      const last = items.at(-1);
      return ok({ items, next_cursor: last ? String(last.seq) : q.cursor ?? null });
    }

    // env, secrets
    if (at("GET", "env")) return need("services:read"), ok(s.env);
    if (at("PUT", "env")) {
      need("env:write");
      const b = obj(body);
      for (const [k, v] of Object.entries(b)) {
        if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(k) || typeof v !== "string") return invalid(`env ${k} is not valid`);
      }
      if (Object.keys(b).length > 100) return invalid("at most 100 env vars");
      s.env = b as Record<string, string>;
      return ok(s.env);
    }
    if (at("GET", "secrets")) return need("services:read"), ok([...s.secrets].map(([name, updated_at]) => ({ name, updated_at })));
    if (at("PUT", "secrets", "*")) {
      need("secrets:write");
      if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test((sub[1] ?? ""))) return invalid("secret name is not valid");
      if (typeof obj(body).value !== "string") return invalid("value is required");
      s.secrets.set((sub[1] ?? ""), this.now());
      return noContent();
    }
    if (at("DELETE", "secrets", "*")) {
      need("secrets:write");
      return s.secrets.delete((sub[1] ?? "")) ? noContent() : notFound();
    }

    // schedules
    if (at("GET", "schedules")) return need("services:read"), ok(s.schedules);
    if (at("GET", "schedules", "once")) return need("services:read"), ok(page(s.once));
    if (at("POST", "schedules")) {
      need("services:write");
      const max = this.plans.get(this.tenants.get(s.view.tenant_id)?.plan ?? "")?.maxSchedules;
      if (max !== undefined && s.schedules.length >= max) return new ApiErr(403, "quota_exceeded", "plan schedule limit reached", { quota: "schedules" });
      const sc = buildSchedule(this.id("sch_"), obj(body));
      if (sc instanceof ApiErr) return sc;
      s.schedules.push(sc);
      return ok(sc, 201);
    }
    if (sub[0] === "schedules" && sub.length === 2) {
      const i = s.schedules.findIndex((x) => x.id === sub[1]);
      need("services:write");
      if (at("DELETE", "schedules", "*")) {
        const oi = s.once.findIndex((x) => x.id === sub[1]);
        if (i < 0 && oi < 0) return notFound();
        if (i >= 0) s.schedules.splice(i, 1);
        else s.once.splice(oi, 1);
        return noContent();
      }
      if (at("PATCH", "schedules", "*")) {
        if (i < 0) return notFound();
        const sc = buildSchedule((sub[1] ?? ""), obj(body));
        if (sc instanceof ApiErr) return sc;
        s.schedules[i] = sc;
        return ok(sc);
      }
    }

    // queue
    if (at("GET", "queue")) return need("services:read"), ok({ depth: s.queue.length, in_flight: 0, oldest_age_ms: 0, dlq: s.dlq.length });
    if (at("POST", "queue")) {
      need("queue:write");
      const b = obj(body);
      if (!("body" in b)) return invalid("body is required");
      const d = typeof b.dedup_id === "string" ? b.dedup_id : undefined;
      if (d && s.dedup.has(d)) return ok({ id: s.dedup.get(d) }, 200);
      const id = this.id("msg_");
      if (d) s.dedup.set(d, id);
      s.queue.push({ id, body: b.body });
      return ok({ id }, 202);
    }
    if (at("GET", "dlq")) return need("services:read"), ok({ items: s.dlq });
    if (at("DELETE", "dlq")) return need("queue:write"), (s.dlq = []), noContent();
    if (at("POST", "dlq", "redrive")) {
      need("queue:write");
      const n = s.dlq.length;
      for (const d of s.dlq) s.queue.push({ id: d.id, body: d.body });
      s.dlq = [];
      return ok({ redriven: n });
    }
    if (at("GET", "stats")) return need("logs:read"), ok(fakeStats(q.window ?? "5m"));
    return notFound();
  }

  private hostRoutes(s: FService, method: string, sub: string[], need: (x: string) => void): CtlRes | ApiErr {
    const host = sub[1]?.toLowerCase().replace(/\.$/, "");
    if (method === "GET" && sub.length === 1) {
      need("services:read");
      return ok([...this.hosts.values()].filter((x) => x.service === s.view.id).map(hostView));
    }
    if (!host || sub.length !== 2) return notFound();
    need("services:write");
    if (method === "PUT") {
      const cur = this.hosts.get(host);
      if (cur && cur.service !== s.view.id) return conflict("host_taken", "host is held by another service");
      const hv = { host, status: "active", verify_token: null, created_at: cur?.created_at ?? this.now(), expires_at: null, service: s.view.id };
      this.hosts.set(host, hv);
      return ok(hostView(hv), cur ? 200 : 201);
    }
    if (method === "DELETE") {
      const cur = this.hosts.get(host);
      if (!cur || cur.service !== s.view.id) return notFound();
      this.hosts.delete(host);
      return noContent();
    }
    return notFound();
  }

  // ---- state ----

  private makeTenant(name: string, plan: string): FTenant {
    const t: FTenant = { id: this.id("ten_"), name, plan, created_at: this.now(), disabled: false };
    this.tenants.set(t.id, t);
    const now = this.now();
    const pr: T.Project = { id: this.id("prj_"), tenant_id: t.id, slug: "default", name: "default", environments: ["production"], created_at: now, updated_at: now };
    this.projects.set(pr.id, pr);
    return t;
  }

  private issueKey(tenant: string, b: T.KeyCreate, creator: FKey | null, selfService: boolean): FKey | ApiErr {
    if (!Array.isArray(b?.scopes) || b.scopes.length === 0) return invalid("scopes must not be empty");
    for (const s of b.scopes) {
      if (!VALID_SCOPES.has(s)) return invalid(`unknown scope "${s}"`);
      if (creator && !creator.scopes.includes(s)) return escalation();
    }
    for (const id of b.project_ids ?? []) {
      const pr = this.projects.get(id);
      if (!pr || pr.tenant_id !== tenant) return invalid(`project ${id} is not in this tenant`);
    }
    const narrow = (asked: string[] | undefined, parent: string[] | null): string[] | null | ApiErr => {
      if (!asked?.length) return parent ? [...parent] : null;
      return subset(asked, parent) ? [...asked] : escalation();
    };
    const projects = narrow(b.project_ids, creator?.project_ids ?? null);
    if (projects instanceof ApiErr) return projects;
    const envs = narrow(b.environments, creator?.environments ?? null);
    if (envs instanceof ApiErr) return envs;
    let exp: number | null = null;
    if (b.expires_at) {
      exp = Date.parse(b.expires_at);
      if (Number.isNaN(exp)) return invalid("expires_at must be RFC 3339");
      if (exp <= this.now()) return invalid("expires_at is in the past");
    }
    if (creator?.expires_at != null) {
      if (exp === null) exp = creator.expires_at;
      else if (exp > creator.expires_at) return escalation();
    }
    const k: FKey = {
      id: this.id("key_"), tenant, name: b.name ?? null, secret: this.hex(16), scopes: [...b.scopes],
      project_ids: projects, environments: envs, created_at: this.now(), expires_at: exp, revoked: false, selfService,
    };
    this.keys.set(k.id, k);
    return k;
  }

  private createService(p: Principal, b: Record<string, unknown>): CtlRes | ApiErr {
    if (!p.tenant) return invalid("x-rt-tenant is required to create a service");
    if (typeof b.slug !== "string" || !SLUG_RE.test(b.slug)) return invalid(`slug "${String(b.slug)}" is not valid`);
    if (b.runtime !== "deno" && b.runtime !== "wasm") return invalid("runtime must be deno or wasm");
    const access = typeof b.access === "string" ? b.access : "public";
    if (!["public", "key", "internal"].includes(access)) return invalid("access must be public, key or internal");
    const env = typeof b.environment === "string" ? b.environment : "production";
    if (!ENV_RE.test(env)) return invalid(`environment "${env}" is not valid`);
    const pr = this.projectFor(p.tenant, typeof b.project === "string" ? b.project : "default");
    if (!pr) return invalid(`project "${String(b.project ?? "default")}" does not exist`);
    if (!pr.environments.includes(env)) return invalid(`environment "${env}" is not in project ${pr.slug} (${pr.environments.join(", ")})`);
    if ([...this.services.values()].some((s) => s.view.slug === b.slug)) return conflict("slug_taken", "service slug is already in use on this node");
    if (p.key && !keyAllows(p.key, pr.id, env)) return scopeErr();
    const max = this.plans.get((this.tenants.get(p.tenant) as FTenant).plan)?.maxServices;
    if (max !== undefined && [...this.services.values()].filter((s) => s.view.tenant_id === p.tenant).length >= max) {
      return new ApiErr(403, "quota_exceeded", "plan service limit reached", { quota: "services" });
    }
    const view: FService["view"] = {
      id: this.id("svc_"), tenant_id: p.tenant, slug: b.slug, runtime: b.runtime,
      name: typeof b.name === "string" ? b.name : null, profile: typeof b.profile === "string" ? b.profile : null,
      project_id: pr.id, project: pr.slug, environment: env, durable: false, access,
    };
    for (const k of ["limits", "scaling", "triggers", "ingress", "egress", "call", "deno", "wasm"] as const) {
      if (b[k] !== undefined) (view as Record<string, unknown>)[k] = b[k];
    }
    const s: FService = {
      view, etag: 1, live: null, versions: [], env: {}, secrets: new Map(), schedules: [], once: [],
      queue: [], dlq: [], dedup: new Map(), logs: [], logSeq: 0, events: [],
    };
    this.services.set(view.id, s);
    event(s, this.now(), "service.created", { slug: view.slug });
    return ok(svcView(s), 201, { etag: etagOf(s) });
  }

  private switchRoute(s: FService, p: Principal, body: unknown, h: Record<string, string>, need: (scope: string) => void): CtlRes | ApiErr {
    need("deploy");
    if (h["if-match"] && h["if-match"] !== etagOf(s)) return new ApiErr(412, "precondition_failed", "If-Match does not match the current etag");
    const b = obj(body);
    const name = String(obj(b.from).branch ?? "");
    const source = this.serviceFor(p, `${s.view.slug}-br-${name}`);
    if (!source) return notFound();
    if (source.live === null) return conflict("version_not_ready", "the source has no live version");
    const names = [...Object.keys(source.env), ...source.secrets.keys()].filter((n) => !(n in s.env) && !s.secrets.has(n));
    const warnings = names.length ? [{ code: "env_missing_on_parent", names }] : [];
    if (b.dry_run === true) {
      const now = this.now();
      return ok({
        service: s.view.id, kind: "switch", state: "preparing", from_version: s.live ?? undefined,
        source: { service: source.view.id, version: source.live, digest: `sha256:${source.live}` },
        inflight_old: this.inflightOld, interrupted: false, warnings, dry_run: true, created_at: now, updated_at: now,
        ...this.dryRunExtra,
      });
    }
    const from = source.versions[source.live - 1] as FVersion;
    s.versions.push({ ...from, version: s.versions.length + 1 });
    return ok({
      ...this.flip(s, "switch", s.versions.length),
      source: { service: source.view.id, version: source.live, digest: `sha256:${source.live}` },
      warnings,
    }, 202);
  }
  private flip(s: FService, kind: string, to: number): FSwitch {
    const row: FSwitch = {
      id: this.id("swt_"), service: s.view.id, kind, state: "draining", to_version: to,
      ...(s.live !== null ? { from_version: s.live } : {}),
      inflight_old: this.inflightOld, interrupted: false, warnings: [], created_at: this.now(), updated_at: this.now(),
    };
    this.makeLive(s, to);
    this.switches.set(s.view.id, [...(this.switches.get(s.view.id) ?? []), row]);
    return row;
  }
  private makeLive(s: FService, n: number) {
    s.live = n;
    s.etag++;
    event(s, this.now(), "version.live", { version: n });
  }
  private dropService(id: string) {
    this.services.delete(id);
    for (const [h, x] of this.hosts) if (x.service === id) this.hosts.delete(h);
  }
  private projectFor(tenant: string, ref: string): T.Project | undefined {
    return [...this.projects.values()].find((x) => x.tenant_id === tenant && (x.id === ref || x.slug === ref));
  }
  private svcsIn(projectId: string, env?: string): number {
    return [...this.services.values()].filter((s) => s.view.project_id === projectId && (!env || s.view.environment === env)).length;
  }
  private sees(p: Principal, s: FService): boolean {
    if (p.tenant && s.view.tenant_id !== p.tenant) return false;
    return !p.key || keyAllows(p.key, s.view.project_id, s.view.environment);
  }
  private serviceFor(p: Principal, ref: string): FService | undefined {
    const s = this.services.get(ref) ?? [...this.services.values()].find((x) => x.view.slug === ref);
    return s && this.sees(p, s) ? s : undefined;
  }
}

// ---- helpers ----

function keyAllows(k: FKey, projectId: string, env: string) {
  return (k.project_ids === null || k.project_ids.includes(projectId)) && (k.environments === null || k.environments.includes(env));
}
function canManage(p: Principal, k: FKey) {
  return !p.key || (subset(k.project_ids, p.key.project_ids) && subset(k.environments, p.key.environments));
}
function secretOf(k: FKey) {
  return `rtk_${k.id}_${k.secret}`;
}
function keyView(k: FKey): T.Key {
  return { id: k.id, name: k.name, scopes: k.scopes as T.Scope[], project_ids: k.project_ids, environments: k.environments, created_at: k.created_at, expires_at: k.expires_at, last_used_at: null };
}
function created(k: FKey): T.KeyCreated {
  return { ...keyView(k), secret: secretOf(k) };
}
function etagOf(s: FService) {
  return `"${s.etag}"`;
}
function svcView(s: FService): T.Service {
  return {
    ...s.view, etag: etagOf(s), live_version: s.live,
    status: { build_state: s.versions.at(-1)?.build_state ?? "none", tier: "cold", inflight: 0, last_error: null, admission: null },
  } as T.Service;
}
function versionView(v: FVersion): T.Version {
  return { version: v.version, source_digest: `sha256:${v.version}`, lock_digest: null, build_state: v.build_state, failure: v.failure, created_at: v.created_at };
}
function hostView(h: T.Host & { service: string }): T.Host {
  return { host: h.host, status: h.status, verify_token: h.verify_token, created_at: h.created_at, expires_at: h.expires_at };
}
function event(s: FService, ts: number, kind: string, data: unknown = {}) {
  s.events.push({ id: `evt_${s.events.length + 1}`, ts, kind, data });
}
function validEnvs(envs: unknown): ApiErr | null {
  if (!Array.isArray(envs) || envs.length === 0) return invalid("environments must not be empty");
  for (const e of envs) if (typeof e !== "string" || !ENV_RE.test(e)) return invalid(`environment "${String(e)}" is not valid`);
  return new Set(envs).size === envs.length ? null : invalid("environments must be unique");
}
function buildSchedule(id: string, b: Record<string, unknown>): T.Schedule | ApiErr {
  if (b.kind !== "cron" && b.kind !== "interval") return invalid("kind must be cron or interval");
  if (b.kind === "cron" && (typeof b.cron !== "string" || b.cron.trim().split(/\s+/).length < 5)) return invalid("cron is not valid");
  if (b.kind === "interval" && (typeof b.every_seconds !== "number" || b.every_seconds < 1)) return invalid("every_seconds must be >= 1");
  return {
    id, kind: b.kind, cron: b.kind === "cron" ? (b.cron as string) : null, every_seconds: b.kind === "interval" ? (b.every_seconds as number) : null,
    timezone: typeof b.timezone === "string" ? b.timezone : null, payload: b.payload ?? null, enabled: b.enabled !== false, next_due: null,
  };
}
function obj(b: unknown): Record<string, unknown> {
  if (typeof b === "string") {
    try {
      b = JSON.parse(b);
    } catch {
      throw invalid("body must be JSON");
    }
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) throw invalid("body must be a JSON object");
  return b as Record<string, unknown>;
}
function page<V>(items: V[]): T.Page<V> {
  return { items: [...items], next_cursor: null };
}
function ok(body: unknown, status = 200, extra: Record<string, string> = {}): CtlRes {
  return { status, headers: { "content-type": "application/json", ...extra }, body: JSON.parse(JSON.stringify(body)) };
}
function noContent(): CtlRes {
  return { status: 204, headers: {}, body: null };
}
function errRes(e: ApiErr): CtlRes {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (e.retryAfter !== undefined) headers["retry-after"] = String(e.retryAfter);
  return { status: e.status, headers, body: { error: { code: e.code, message: e.message, details: e.details } } };
}
/** A binding refusal as platform.fetch resolves it: text body + x-rt-reason. */
function refusal(status: number, reason: string, retryAfter?: number): CtlRes {
  const headers: Record<string, string> = { "content-type": "text/plain", "x-rt-reason": reason };
  if (retryAfter !== undefined) headers["retry-after"] = String(retryAfter);
  return { status, headers, body: reason };
}

/** Shape of rt-obs ServiceStats plus `admission` (runtime docs/api.md, GET /v1/services/{s}/stats). */
export function fakeStats(window: string) {
  const n = window === "24h" ? 30 : window === "1h" ? 7 : 3;
  const pct = { p50_ms: 10, p95_ms: 20, p99_ms: 30 };
  return { count: n, errors: 1, error_rate: 1 / n, outcomes: { ok: n - 1, guest_error: 1 }, queue: pct, init: pct, exec: pct, total: { p50_ms: 12, p95_ms: 40, p99_ms: 90 }, admission: {} };
}
