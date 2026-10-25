// Human formatting for numbers the API reports raw (bytes, milliseconds, counts, times), in the
// current UI language: numbers and dates through Intl, unit symbols from the `common` namespace.
import { i18n, intlLocale } from "./i18n";

const BYTE_UNITS = ["b", "kib", "mib", "gib", "tib"] as const;

function num(value: number, digits = 0, useGrouping = true): string {
  return new Intl.NumberFormat(intlLocale(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping,
  }).format(value);
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
  const unit = BYTE_UNITS[i] ?? "b";
  return i18n.t(`common:units.${unit}`, { value: `${n < 0 ? "-" : ""}${num(v, digits, false)}` });
}

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  return new Intl.NumberFormat(intlLocale()).format(n);
}

type DurationUnit = "ms" | "s" | "min" | "h" | "d";

// durationParts splits milliseconds into the one unit we show (ms, s, min, h or d) and its text.
function durationParts(ms: number): { unit: DurationUnit; value: string } {
  if (ms < 1000) return { unit: "ms", value: num(Math.round(ms)) };
  const s = ms / 1000;
  if (s < 60) return { unit: "s", value: num(s, s < 10 ? 1 : 0) };
  const m = s / 60;
  if (m < 60) return { unit: "min", value: num(Math.round(m)) };
  const h = m / 60;
  if (h < 48) return { unit: "h", value: num(h, 1) };
  return { unit: "d", value: num(Math.round(h / 24)) };
}

// formatDuration renders milliseconds as ms, s, min, h or d.
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "-";
  const { unit, value } = durationParts(ms);
  return i18n.t(`common:units.${unit}`, { value });
}

// formatRelative renders a timestamp as "3 min ago" / "in 2 h" for recent times, else a date.
export function formatRelative(ts: number, now = Date.now()): string {
  const diff = ts - now;
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  let span: { unit: DurationUnit; n: number };
  if (abs < minute) return i18n.t("common:time.justNow");
  else if (abs < hour) span = { unit: "min", n: Math.round(abs / minute) };
  else if (abs < day) span = { unit: "h", n: Math.round(abs / hour) };
  else if (abs < 30 * day) span = { unit: "d", n: Math.round(abs / day) };
  else return new Date(ts).toLocaleDateString(intlLocale());
  const value = i18n.t(`common:units.${span.unit}`, { value: num(span.n) });
  return diff < 0 ? i18n.t("common:time.ago", { value }) : i18n.t("common:time.in", { value });
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(intlLocale(), { dateStyle: "medium", timeStyle: "short" });
}

// formatDate renders the calendar date only, in the current UI language.
export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(intlLocale(), { dateStyle: "medium" });
}

// formatQuantity picks a unit from the metric name: *_bytes → bytes, *_ms → duration, else count.
export function formatQuantity(key: string, value: unknown): string {
  if (typeof value !== "number") return value === null || value === undefined ? "-" : String(value);
  if (/bytes?$/i.test(key)) return formatBytes(value);
  if (/_ms$|millis/i.test(key)) return formatDuration(value);
  if (/_(at|time|ts)$/i.test(key) && value > 1_000_000_000_000) return formatDateTime(value);
  if (/_seconds?$|_secs?$/i.test(key)) return formatDuration(value * 1000);
  return formatCount(value);
}

// labelFor turns a snake_case key into a readable label. The keys come from the runtime, so the label
// stays English in every UI language.
export function labelFor(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// metricLabel is labelFor without the unit suffix that formatQuantity already shows in the value
// (budget_bytes → "Budget", uptime_ms → "Uptime"). A key that is only a unit keeps its name.
export function metricLabel(key: string): string {
  const bare = key.replace(/[_-](bytes?|ms|millis|secs?|seconds?)$/i, "");
  return labelFor(bare || key);
}
