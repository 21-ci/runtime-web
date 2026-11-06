import { isActive, type Switch } from "@/components/features/branches/use-branches";

import type { Version } from "./use-versions";

// One Deployments history (guidelines rule 9): the runtime keeps versions and switches apart, and has no single feed,
// so they are merged here by time.
export type HistoryRow =
  | { type: "version"; key: string; at: number; version: Version }
  | { type: "switch"; key: string; at: number; item: Switch };

export type StateFilter = "ready" | "building" | "failed";
export type SourceFilter = "git" | "console" | "api";
export type PeriodFilter = "24h" | "7d" | "30d";
export type DeploymentFilters = { state?: StateFilter; source?: SourceFilter; period?: PeriodFilter };

const STATES: readonly string[] = ["ready", "building", "failed"];
const SOURCES: readonly string[] = ["git", "console", "api"];
const PERIOD_MS: Record<PeriodFilter, number> = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };

export function parseFilters(search: Record<string, unknown>): DeploymentFilters {
  const out: DeploymentFilters = {};
  if (typeof search.state === "string" && STATES.includes(search.state)) out.state = search.state as StateFilter;
  if (typeof search.source === "string" && SOURCES.includes(search.source)) out.source = search.source as SourceFilter;
  if (typeof search.period === "string" && search.period in PERIOD_MS) out.period = search.period as PeriodFilter;
  return out;
}

export function mergeHistory(versions: readonly Version[], switches: readonly Switch[]): HistoryRow[] {
  const rows: HistoryRow[] = [
    ...versions.map((version): HistoryRow => ({ type: "version", key: `version:${version.version}`, at: version.created_at, version })),
    ...switches
      .filter((s) => !s.dry_run)
      .map((item): HistoryRow => ({ type: "switch", key: `switch:${item.id ?? item.created_at}`, at: item.created_at, item })),
  ];
  return rows.sort((a, b) => b.at - a.at);
}

export type VersionSource = { kind: "git"; sha: string; ref?: string } | { kind: "console" } | { kind: "api" };

// What the record says and no more: a commit from a git deploy, an author from a save in the console, otherwise neither.
export function versionSource(v: Version): VersionSource {
  const git = (v.meta as { git?: { sha?: unknown; ref?: unknown } } | null | undefined)?.git;
  if (typeof git?.sha === "string") return { kind: "git", sha: git.sha, ...(typeof git.ref === "string" ? { ref: git.ref } : {}) };
  return v.author ? { kind: "console" } : { kind: "api" };
}

/** Only a finished switch has a duration. The runtime records none for builds. */
export function switchDuration(s: Switch): number | null {
  return isActive(s.state) ? null : s.updated_at - s.created_at;
}

function matchesState(row: HistoryRow, state: StateFilter): boolean {
  if (row.type === "switch") return state === "failed" && row.item.state === "failed";
  const b = row.version.build_state;
  if (state === "building") return b === "fetching" || b === "pending" || b === "building";
  return b === state;
}

export function filterHistory(rows: readonly HistoryRow[], f: DeploymentFilters, now: number): HistoryRow[] {
  return rows.filter((row) => {
    if (f.period && row.at < now - PERIOD_MS[f.period]) return false;
    if (f.state && !matchesState(row, f.state)) return false;
    if (f.source && (row.type === "switch" || versionSource(row.version).kind !== f.source)) return false;
    return true;
  });
}
