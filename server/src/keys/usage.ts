// Quota view and per-day usage of an org's runtime tenant. Limits are read with
// the org's default key (relay); usage is read with the operator route and
// mapped to app slugs through the tenant's service list.

import type { Deps } from "../app.ts";
import { invalid } from "../http/errors.ts";
import type { Limits, Usage } from "../runtime/types.ts";
import type { Org as OrgRow } from "../orgs/orgs.ts";
import { defaultKeySecret, rtOf } from "./keys.ts";

/** Runtime quota view without the plan name, plus the plan's trigger kinds (null when unknown). */
export type LimitsJson = Omit<Limits, "plan"> & { allowed_triggers: string[] | null };

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
  const [l, me] = await Promise.all([cli.limits(), cli.me()]);
  const out: Partial<Limits> = { ...l };
  delete out.plan;
  return { ...(out as Omit<Limits, "plan">), allowed_triggers: allowedTriggers(me.plan?.settings) };
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
