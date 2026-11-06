import type { AppSummary } from "@/hooks/orgs";

export type AppFilters = { q?: string; project?: string; environment?: string; state?: string };

const FIELDS = ["q", "project", "environment", "state"] as const;

/** Reads the filters from a URL search object: only non-empty strings count. */
export function parseAppFilters(search: Record<string, unknown>): AppFilters {
  const out: AppFilters = {};
  for (const f of FIELDS) {
    const v = search[f];
    if (typeof v === "string" && v !== "") out[f] = v;
  }
  return out;
}

export function filterApps(apps: readonly AppSummary[], f: AppFilters): AppSummary[] {
  const q = f.q?.trim().toLowerCase();
  return apps.filter(
    (a) =>
      (!f.project || a.project === f.project) &&
      (!f.environment || a.environment === f.environment) &&
      (!f.state || a.status.build_state === f.state) &&
      (!q || a.slug.toLowerCase().includes(q) || (a.name ?? "").toLowerCase().includes(q)),
  );
}
