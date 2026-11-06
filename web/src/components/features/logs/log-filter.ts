import type { LogLevel, LogLine } from "./use-log-stream";

export type LogKind = LogLine["kind"];
export type LogMode = "live" | "range";
export type RangeKey = "15m" | "1h" | "24h" | "custom";
export type LogSearch = { mode?: LogMode; range?: RangeKey; since?: string; until?: string; level?: Exclude<LogLevel, "">; kind?: LogKind; q?: string };
export type LineFilter = { level?: Exclude<LogLevel, "">; kind?: LogKind; text?: string };
export type Bounds = { since: number; until: number };

const RANK: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const KINDS: readonly string[] = ["runtime", "build", "system"];
const RANGE_MS: Record<Exclude<RangeKey, "custom">, number> = { "15m": 900_000, "1h": 3_600_000, "24h": 86_400_000 };

export function parseLogSearch(s: Record<string, unknown>): LogSearch {
  const out: LogSearch = {};
  if (s.mode === "live" || s.mode === "range") out.mode = s.mode;
  if (s.range === "custom" || (typeof s.range === "string" && s.range in RANGE_MS)) out.range = s.range as RangeKey;
  if (typeof s.since === "string") out.since = s.since;
  if (typeof s.until === "string") out.until = s.until;
  if (typeof s.level === "string" && s.level in RANK) out.level = s.level as LineFilter["level"] & string;
  if (typeof s.kind === "string" && KINDS.includes(s.kind)) out.kind = s.kind as LogKind;
  if (typeof s.q === "string" && s.q) out.q = s.q;
  return out;
}

/** Splits `@level:` and `@kind:` tokens from the free text. A token with an unknown value stays text. */
export function parseFilterText(input: string): LineFilter {
  const out: LineFilter = {};
  const text: string[] = [];
  for (const word of input.trim().split(/\s+/).filter(Boolean)) {
    const [, name, value] = /^@(level|kind):(.+)$/.exec(word) ?? [];
    if (name === "level" && value && value in RANK) out.level = value as NonNullable<LineFilter["level"]>;
    else if (name === "kind" && value && KINDS.includes(value)) out.kind = value as LogKind;
    else text.push(word);
  }
  if (text.length) out.text = text.join(" ");
  return out;
}

export function matchesLine(l: LogLine, f: LineFilter): boolean {
  if (f.level && (RANK[l.level] ?? 0) < (RANK[f.level] ?? 0)) return false;
  if (f.kind && l.kind !== f.kind) return false;
  return !f.text || l.msg.toLowerCase().includes(f.text.toLowerCase());
}

/** The window to read. Null while a custom range is incomplete or backwards. */
export function rangeBounds(s: Pick<LogSearch, "range" | "since" | "until">, now: number): Bounds | null {
  const range = s.range ?? "1h";
  if (range !== "custom") return { since: now - RANGE_MS[range], until: now };
  const since = s.since ? Date.parse(s.since) : Number.NaN;
  const until = s.until ? Date.parse(s.until) : Number.NaN;
  return Number.isNaN(since) || Number.isNaN(until) || since >= until ? null : { since, until };
}

/** The server filters of a range: the free text is not one, so it is not sent. */
function rangeQuery(start: Record<string, string>, f: Pick<LineFilter, "level" | "kind">, b: Bounds | null): string {
  const q = new URLSearchParams(start);
  if (f.level) q.set("level", f.level);
  if (f.kind) q.set("kind", f.kind);
  if (b) {
    q.set("since", new Date(b.since).toISOString());
    q.set("until", new Date(b.until).toISOString());
  }
  return q.toString();
}

/** Query of a file, which the server audits as an export. */
export const exportQuery = (format: "ndjson" | "txt", f: Pick<LineFilter, "level" | "kind">, b: Bounds | null) => rangeQuery({ format }, f, b);

/** Query of the page's own read of a range, which is not an export. */
export const readQuery = (f: Pick<LineFilter, "level" | "kind">, b: Bounds) => rangeQuery({ view: "range" }, f, b);
