import { formatDuration } from "@/lib/format";
import { i18n, intlLocale } from "@/lib/i18n";

// formatLimit turns one flattened limit (key and value) into a readable label and value. Units come
// from the key: "_bytes" shows B/KiB/MiB, "_ms" and "_seconds" show a suffix. A null limit means
// no cap, shown as "unlimited". The label is humanized from the runtime key and stays as it is.
const UNIT_TOKENS = new Set(["bytes", "ms", "seconds"]);
const BYTE_UNITS = ["b", "kib", "mib", "gib", "tib"] as const;

export function formatLimit(key: string, value: unknown): { label: string; value: string } {
  const tokens = key.split("_");
  const unit = tokens.find((t) => UNIT_TOKENS.has(t));
  const words = tokens.filter((t) => !UNIT_TOKENS.has(t)).join(" ");
  const label = words.charAt(0).toUpperCase() + words.slice(1);
  return { label, value: formatValue(value, unit) };
}

/** The limits that get a hand-written label, in the order they show. Everything else stays in Raw. */
const READABLE = ["wall_ms", "cpu_ms", "memory_mb", "max_body_bytes", "min_instances", "max_instances", "max_queued", "queue_timeout", "idle_ttl", "keep_resident", "invocations_per_day"] as const;

export type ReadableLimit = { key: string; label: string; value: string; source: string | null };

/** What the runtime sends for a Duration: a whole second count and the nanoseconds over it. */
function isDuration(v: unknown): v is { secs: number; nanos: number } {
  return typeof v === "object" && v !== null && typeof (v as { secs?: unknown }).secs === "number";
}

function shownValue(key: string, v: unknown): string {
  if (isDuration(v)) return formatDuration(v.secs * 1000 + Math.round(((v as { nanos?: number }).nanos ?? 0) / 1e6));
  if (typeof v === "boolean") return i18n.t(v ? "operator:yes" : "operator:no");
  if (typeof v === "number") {
    if (key.endsWith("_ms")) return formatDuration(v);
    if (key.endsWith("_mb")) return formatBytes(v * 1024 * 1024);
    if (key.endsWith("_bytes")) return formatBytes(v);
    return new Intl.NumberFormat(intlLocale()).format(v);
  }
  return formatLimit(key, v).value;
}

/** Where a value came from, in words: `plan`, `service`, `node`, `profile:balanced`. */
export function sourceLabel(source: string): string {
  if (source.startsWith("profile:")) return i18n.t("operator:source.profile", { name: source.slice("profile:".length) });
  if (source.startsWith("plan")) return i18n.t("operator:source.plan");
  return i18n.t(`operator:source.${source}`, { defaultValue: source });
}

/** One limit as the runtime reports it, either bare or as `{value, source}`. */
export function resolved(entry: unknown): { value: unknown; source: string | null } {
  if (entry && typeof entry === "object" && "value" in entry) {
    const e = entry as { value: unknown; source?: unknown };
    return { value: e.value, source: typeof e.source === "string" ? e.source : null };
  }
  return { value: entry, source: null };
}

export function readableLimits(values: Record<string, unknown>): ReadableLimit[] {
  return READABLE.filter((k) => values[k] !== undefined).map((key) => {
    const { value, source } = resolved(values[key]);
    return { key, label: i18n.t(`operator:limits.${key}`), value: shownValue(key, value), source };
  });
}

function formatValue(value: unknown, unit: string | undefined): string {
  if (value === null || value === undefined) return i18n.t("app-settings:unlimited");
  if (typeof value === "number") {
    if (unit === "bytes") return formatBytes(value);
    if (unit === "ms") return i18n.t("common:units.ms", { value: String(value) });
    if (unit === "seconds") return i18n.t("common:units.s", { value: String(value) });
    return String(value);
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatBytes(n: number): string {
  let v = n;
  let i = 0;
  while (Math.abs(v) >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const shown = new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 1 }).format(v);
  return i18n.t(`common:units.${BYTE_UNITS[i]}`, { value: shown });
}

// flattenLimits turns a nested limits object into flat key/value pairs (quota objects become
// "invocations_limit" style keys), so each row reads as one number with its unit.
export function flattenLimits(obj: Record<string, unknown>, prefix = ""): [string, unknown][] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}_${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      return flattenLimits(v as Record<string, unknown>, key);
    }
    return [[key, v] as [string, unknown]];
  });
}
