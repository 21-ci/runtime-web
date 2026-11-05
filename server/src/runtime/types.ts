// RtCtl: the only path from rtweb to the runtime control API (design D3-D5).
// `op` goes through binding rtctl-op (operator token injected by the node);
// `tenant` goes through binding rtctl-tenant to the relay, which turns the
// per-org key into `Authorization: Bearer rtk_…`. Both resolve with the
// control API's own status/headers/body; refusals by the binding carry
// `x-rt-reason` (binding_denied, rate_limited, binding_upstream, …).

export type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface CtlReq {
  method: Method;
  /** Absolute control-API path, e.g. `/v1/services/svc_1/env`. */
  path: string;
  query?: Record<string, string | number | boolean | undefined> | undefined;
  /** JSON value, or a string sent verbatim with `contentType`. */
  body?: unknown | undefined;
  contentType?: string | undefined;
  /** Extra request headers (If-Match, Accept, Last-Event-ID, Range, If-Range). */
  headers?: Record<string, string> | undefined;
}

export interface CtlRes {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /** Parsed JSON, text, or base64 text when `encoding` is "base64"; null on 204. */
  body: unknown;
  encoding?: "base64" | undefined;
}

/**
 * Wire format of the rtctl SDK (sdk/rtctl/mod.ts). Bodies travel as strings so
 * the SDK and client can chunk them under the 256 KiB SDK arg/result limit.
 */
export const CHUNK = 150 * 1024;
export interface WireReq {
  method: Method;
  path: string;
  query?: Record<string, string> | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  contentType?: string | undefined;
  /** Body uploaded earlier with `put` parts 0..parts-1. */
  bodyRef?: { id: string; parts: number } | undefined;
  /** tenant() only: the org's hidden default key (rtk_…). */
  key?: string | undefined;
}
export interface WireRes {
  status: number;
  headers: Record<string, string>;
  body?: string | undefined;
  encoding?: "base64" | undefined;
  /** Body too large for one result: fetch with `get` parts 0..parts-1. */
  chunked?: { id: string; parts: number } | undefined;
}

export interface RtCtl {
  op(req: CtlReq): Promise<CtlRes>;
  tenant(key: string, req: CtlReq): Promise<CtlRes>;
  /** Per-call deadline in ms for `Runtime`; unset means DEFAULT_RUNTIME_TIMEOUT_MS, 0 disables it. */
  timeoutMs?: number;
}

// ---- control API views (runtime v0.1.1 openapi; timestamps are unix ms) ----

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export interface Tenant {
  id: string;
  name: string;
  plan: string;
  overrides?: unknown;
  created_at: number;
  disabled: boolean;
}
export interface TenantCreate {
  name: string;
  plan: string;
  overrides?: unknown;
}
export interface TenantPatch {
  name?: string;
  plan?: string;
  overrides?: unknown;
  disabled?: boolean;
}

/** Key scopes (v0.1.1 adds sockets:write). */
export type Scope =
  | "services:read"
  | "services:write"
  | "deploy"
  | "invoke"
  | "logs:read"
  | "env:write"
  | "secrets:write"
  | "queue:write"
  | "data:admin"
  | "data:read"
  | "keys:write"
  | "sockets:write";

/** Empty/absent project_ids or environments = no restriction (never send []). */
export interface KeyCreate {
  name?: string;
  scopes: Scope[];
  project_ids?: string[];
  environments?: string[];
  /** RFC 3339. */
  expires_at?: string;
}
export interface Key {
  id: string;
  name: string | null;
  scopes: Scope[];
  project_ids: string[] | null;
  environments: string[] | null;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
}
export interface KeyCreated extends Key {
  secret: string;
}

export interface Usage {
  service_id: string;
  day: string;
  invocations: number;
  cpu_ms: number;
  egress_bytes: number;
  storage_bytes: number;
}
export interface Quota {
  limit: number | null;
  used: number;
  remaining: number | null;
  period: string;
}
export interface Limits {
  plan: string;
  day: string;
  resets_at: number;
  invocations: Quota;
  egress_bytes: Quota;
  storage_bytes: Quota;
  services: Quota;
  schedules: Quota;
}
export interface Plan {
  name: string;
  settings: unknown;
}
export interface Me {
  principal: string;
  tenant_id: string | null;
  key_id: string | null;
  scopes: Scope[];
  project_ids: string[] | null;
  environments: string[] | null;
  plan: Plan | null;
  version: string;
}
export interface VersionInfo {
  version: string;
  [k: string]: unknown;
}

export interface Project {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  environments: string[];
  created_at: number;
  updated_at: number;
}
export interface ProjectCreate {
  slug: string;
  name?: string;
  environments?: string[];
}
export interface ProjectPatch {
  name?: string;
  /** Complete new list. */
  environments?: string[];
}
export interface ProjectEnvironments {
  environments: string[];
  [k: string]: unknown;
}

export interface Admission {
  kind: string;
  limit: number;
  min: number;
  max: number;
  running: number;
  queued: number;
  [k: string]: unknown;
}
export interface ServiceStatus {
  build_state: string;
  tier: string;
  inflight: number;
  last_error: string | null;
  admission: Admission | null;
}
export interface Service {
  id: string;
  tenant_id: string;
  slug: string;
  runtime: string;
  name: string | null;
  profile: string | null;
  project_id: string;
  project: string;
  environment: string;
  live_version: number | null;
  durable: boolean;
  etag: string;
  access: string;
  status: ServiceStatus;
  ws?: unknown;
  limits?: unknown;
  scaling?: unknown;
  triggers?: unknown;
  ingress?: unknown;
  egress?: unknown;
  call?: unknown;
  deno?: unknown;
  wasm?: unknown;
  effective?: unknown;
}
interface ServiceBlocks {
  name?: string;
  profile?: string;
  project?: string;
  environment?: string;
  access?: string;
  limits?: unknown;
  scaling?: unknown;
  triggers?: unknown;
  ingress?: unknown;
  egress?: unknown;
  call?: unknown;
  deno?: unknown;
  wasm?: unknown;
}
export interface ServiceCreate extends ServiceBlocks {
  slug: string;
  runtime: string;
}
/** Each provided block replaces that block. */
export type ServicePatch = ServiceBlocks;
export interface ServiceFilter {
  slug?: string;
  project?: string;
  environment?: string;
  cursor?: string;
}

export interface VersionFailure {
  /** fetch_failed, egress_denied, egress_quota, too_large, validation_failed, invalid_artifact, internal; absent on an older build failure. */
  code?: string;
  reason: string;
  message: string;
  diagnostics?: unknown;
}
/** A preview service; absent `kind` on older branches. */
export interface ScratchCreate {
  of: string;
  name: string;
  ttl_seconds?: number;
  allowed_hosts?: string[];
}
export interface DataTables {
  items: { name: string; type: string; columns: { name: string; type: string; pk: number | boolean }[]; rows_estimate: number | null }[];
}
export interface DataQuery {
  sql: string;
  args?: unknown[];
  limit?: number;
}
export interface DataResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  elapsed_ms: number;
}
export interface DataListQuery {
  prefix?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}
export interface BundleState {
  id: string;
  state: string;
  bytes: number | null;
  sha256: string | null;
  expires_at: number | null;
  failure: unknown;
}
export interface ImportQuery {
  slug: string;
  project: string;
  environment: string;
  activate?: boolean | undefined;
  from?: string | undefined;
}
export interface ImportResult {
  id: string;
  service_id: string;
  warnings?: unknown[];
  missing_secrets?: string[];
  versions?: unknown;
}
export interface Version {
  version: number;
  source_digest: string;
  lock_digest: string | null;
  build_state: string;
  failure: VersionFailure | null;
  created_at: number;
}
export interface UploadOpts {
  activate?: boolean;
  compile?: "lazy" | "eager";
}

export interface SwitchWarning {
  code: string;
  names?: string[];
}
export interface SwitchBody {
  from: { branch: string };
  close_sockets: boolean;
  dry_run: boolean;
}
export interface Switch {
  /** Absent on a dry run. */
  id?: string;
  service: string;
  kind: string;
  state: string;
  from_version?: number;
  to_version?: number;
  source?: { service: string; version: number; digest?: string };
  inflight_old: number;
  drain_deadline?: number;
  interrupted: boolean;
  error?: string;
  warnings?: SwitchWarning[];
  dry_run?: boolean;
  /** Not answered by runtimes without schema migrations. */
  pending_migrations?: string[];
  created_at: number;
  updated_at: number;
}
/** A branch: its own service, with its branch identity in `scratch`. */
export type Branch = Service & { scratch?: { name?: string; expires_at?: number | null } };

export interface SecretName {
  name: string;
  updated_at: number;
}
export interface Schedule {
  id: string;
  kind: string;
  cron: string | null;
  every_seconds: number | null;
  timezone: string | null;
  payload: unknown;
  enabled: boolean;
  next_due: number | null;
}
export interface ScheduleBody {
  kind: string;
  cron?: string;
  every_seconds?: number;
  timezone?: string;
  payload?: unknown;
  enabled?: boolean;
}
/** Pending one-off std:schedule task (GET …/schedules/once). */
export interface OnceSchedule {
  id: string;
  kind: string;
  run_at: number;
}

export interface QueueStats {
  depth: number;
  in_flight: number;
  oldest_age_ms: number;
  dlq: number;
}
export interface EnqueueBody {
  body: unknown;
  delay_seconds?: number;
  dedup_id?: string;
}
export interface DLQItem {
  id: string;
  body: unknown;
  attempts: number;
  failed_at: number;
}

export interface Host {
  host: string;
  status: string;
  verify_token: string | null;
  created_at: number;
  expires_at: number | null;
}
export interface Event {
  id: string;
  ts: number;
  kind: string;
  data: unknown;
}

/** One log line (GET …/logs). `fields` carries std:log structured data (v0.1.1). */
export interface LogLine {
  seq: number;
  ts: number;
  level: string;
  service_id: string;
  version?: number;
  task_id?: string;
  trigger?: string;
  kind: string;
  msg: string;
  truncated?: boolean;
  fields?: Record<string, unknown>;
}
export interface LogQuery {
  /** RFC 3339. */
  since?: string;
  until?: string;
  level?: "debug" | "info" | "warn" | "error";
  kind?: "runtime" | "build" | "system";
  task_id?: string;
  limit?: number;
  cursor?: string;
}

export interface Migrations {
  applied: { name: string; sha256: string; applied_at: number; version: number }[];
  pending_for_latest: { name: string; sha256: string }[];
}
export interface NodeSeriesPoint {
  ts: number;
  cpu_pct: number | null;
  load1: number | null;
  mem_committed: number | null;
  disk_free: number | null;
  rx: number | null;
  tx: number | null;
}
export interface NodeSeries {
  range: string;
  step_s: number;
  points: NodeSeriesPoint[];
}
export interface NodeStatsQuery {
  from?: number | undefined;
  to?: number | undefined;
  fields?: "counts" | "all" | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}
export interface NodeStatsItem {
  service: string;
  tenant: string;
  slug: string | null;
  count: number;
  errors: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  dlq: number;
  depth: number;
}
export interface NodeEvent {
  id: string | number;
  ts: number;
  tenant: string | null;
  service: string | null;
  kind: string;
  data: unknown;
}
export interface Backup {
  id: string;
  state: string;
  trigger: string;
  started_at: number;
  finished_at: number | null;
  bytes: number | null;
  sha256: string | null;
  encrypted: boolean;
  verified_at: number | null;
  rt_version: string;
  failure: { code: string; message: string } | null;
}
export interface BackupStatus {
  enabled: boolean;
  schedule: string;
  last_ok_at: number | null;
  last_ok_id: string | null;
  last_failure: unknown;
  next_at: number | null;
  running_id: string | null;
  last_restored_at: number | null;
  destination: { kind: string; endpoint_host?: string | null; bucket?: string | null } | null;
}

export interface NodeStatus {
  version: string;
  mode: string;
  default_profile: string;
  v8_sandbox: boolean;
  processors: number;
  kinds: unknown;
  memory: unknown;
  inflight: number;
  /** {open, objects, pending, max} */
  sockets?: unknown;
  host?: { disk?: { free_bytes: number; total_bytes: number } | null };
}
export interface NodeConfigUpdate {
  default_profile?: string;
  degradation_mode?: string;
  rate_limit?: unknown;
}
export interface NodeConfigApplied {
  applied: string[];
  pending_restart: string[];
}
