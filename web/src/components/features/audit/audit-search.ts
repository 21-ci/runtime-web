// The audit filters as URL search params (guidelines rule 5), so a filtered view can be shared. The period is kept by
// name, not as a bound: a shared link means "the last 7 days" for whoever opens it.
export type AuditPeriod = "all" | "24h" | "7d" | "30d";
export const AUDIT_PERIODS: readonly AuditPeriod[] = ["all", "24h", "7d", "30d"];

export type AuditSearch = { org?: string; actor?: string; action?: string; period?: AuditPeriod };

const PERIOD_MS: Record<Exclude<AuditPeriod, "all">, number> = { "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 };

const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

export function parseAuditSearch(search: Record<string, unknown>): AuditSearch {
  const out: AuditSearch = {};
  const org = text(search.org);
  const actor = text(search.actor);
  const action = text(search.action);
  if (org) out.org = org;
  if (actor) out.actor = actor;
  if (action) out.action = action;
  if (AUDIT_PERIODS.includes(search.period as AuditPeriod) && search.period !== "all") out.period = search.period as AuditPeriod;
  return out;
}

// patchAuditSearch merges a change and drops what became empty, so the URL only holds the active filters.
export function patchAuditSearch(search: AuditSearch, patch: AuditSearch): AuditSearch {
  return parseAuditSearch({ ...search, ...patch });
}

// sinceFor turns a period into the lower bound of the window, read once per picked period so the list, its pages and
// the export share one window.
export function sinceFor(period: AuditPeriod | undefined): string {
  if (!period || period === "all") return "";
  return new Date(Date.now() - PERIOD_MS[period]).toISOString();
}
