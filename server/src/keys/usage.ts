// Quota view and per-day usage of an org's runtime tenant. Limits are read with
// the org's default key (relay); usage is read with the operator route and
// mapped to app slugs through the tenant's service list.

import type { Deps } from "../app.ts";
import { invalid } from "../http/errors.ts";
import type { Limits, Usage } from "../runtime/types.ts";
import type { Org as OrgRow } from "../orgs/orgs.ts";
import { defaultKeySecret, rtOf } from "./keys.ts";

/** Runtime quota view without the plan name, plus the plan's trigger kinds (null when unknown). */
export type LimitsJson = Omit<Limits, "plan"> & {
  allowed_triggers: string[] | null;
  /** Branches and previews counted in `services`, which the App lists hide; null on a node that does not report them. */
  hidden_services: number | null;
};

export interface UsageJson {
  app: string | null;
  day: string;
  invocations: number;
  cpu_ms: number;
  egress_bytes: number;
  storage_bytes: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Parses optional YYYY-MM-DD bounds. Throws 422 invalid. */
export function parseRange(q: URLSearchParams): { from?: string; to?: string } {
  const out: { from?: string; to?: string } = {};
  const from = q.get("from") ?? undefined;
  const to = q.get("to") ?? undefined;
  const errs: Record<string, string> = {};
  if (from !== undefined && !DAY.test(from)) errs.from = "YYYY-MM-DD";
  if (to !== undefined && !DAY.test(to)) errs.to = "YYYY-MM-DD";
  if (Object.keys(errs).length) throw invalid(errs);
  if (from !== undefined) out.from = from;
  if (to !== undefined) out.to = to;
  return out;
}

export async function orgLimits(deps: Deps, org: OrgRow): Promise<LimitsJson> {
  const secret = await defaultKeySecret(deps, org);
  const cli = rtOf(deps).as(secret);
  const [l, me, usage] = await Promise.all([cli.limits(), cli.me(), cli.planUsage().catch(() => null)]);
  const out: Partial<Limits> = { ...l };
  delete out.plan;
  return { ...(out as Omit<Limits, "plan">), allowed_triggers: allowedTriggers(me.plan?.settings), hidden_services: hiddenServices(usage?.quotas) };
}

function hiddenServices(quotas: unknown): number | null {
  const q = (quotas && typeof quotas === "object" ? quotas : {}) as Record<string, { used?: unknown } | undefined>;
  const branches = q.branches?.used;
  const previews = q.previews?.used;
  if (typeof branches !== "number" && typeof previews !== "number") return null;
  return (typeof branches === "number" ? branches : 0) + (typeof previews === "number" ? previews : 0);
}

export interface PlanUsageJson {
  plan: string | null;
  resets_at: number | string | null;
  metrics: { key: string; used: number; limit: number | null; period: string }[];
}

/** The rows of the usage panel, in this order. */
const QUOTA_ORDER = ["invocations", "cpu_ms", "egress_bytes", "storage_bytes", "services", "projects", "branches", "previews", "custom_hosts", "schedules", "secrets"];

/** Usage against the plan's limits, from GET /v1/usage. Rows that do not have the expected shape are dropped. */
export async function orgPlanUsage(deps: Deps, org: OrgRow): Promise<PlanUsageJson> {
  const u = await rtOf(deps).as(await defaultKeySecret(deps, org)).planUsage();
  const quotas: Record<string, unknown> = u?.quotas && typeof u.quotas === "object" ? u.quotas : {};
  const metrics: PlanUsageJson["metrics"] = [];
  for (const key of QUOTA_ORDER) {
    const q = quotas[key] as { used?: unknown; limit?: unknown; period?: unknown } | undefined;
    if (typeof q?.used !== "number" || !(q.limit === null || typeof q.limit === "number")) continue;
    metrics.push({ key, used: q.used, limit: q.limit, period: typeof q.period === "string" ? q.period : "" });
  }
  return { plan: typeof u?.plan === "string" ? u.plan : null, resets_at: u?.resets_at ?? null, metrics };
}

/** `plan.settings.allowed_triggers` of GET /v1/me (the tenant's effective plan), when it is a string list. */
export function allowedTriggers(settings: unknown): string[] | null {
  const v = settings && typeof settings === "object" ? (settings as Record<string, unknown>).allowed_triggers : undefined;
  return Array.isArray(v) && v.every((k) => typeof k === "string") ? v : null;
}

export async function orgUsage(deps: Deps, org: OrgRow, range: { from?: string; to?: string }): Promise<UsageJson[]> {
  const rt = rtOf(deps);
  const rows: Usage[] = await rt.op().tenantUsage(org.tenantId);
  const cli = rt.as(await defaultKeySecret(deps, org));
  const slugs = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const page = await cli.listServices(cursor ? { cursor } : {});
    for (const s of page.items) slugs.set(s.id, s.slug);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return rows
    .filter((r) => (!range.from || r.day >= range.from) && (!range.to || r.day <= range.to))
    .map((r) => ({
      app: slugs.get(r.service_id) ?? null,
      day: r.day,
      invocations: r.invocations,
      cpu_ms: r.cpu_ms,
      egress_bytes: r.egress_bytes,
      storage_bytes: r.storage_bytes,
    }));
}
