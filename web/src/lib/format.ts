// Human formatting for numbers the API reports raw (bytes, milliseconds, counts, times).

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${n < 0 ? "-" : ""}${v.toFixed(digits)} ${UNITS[i]}`;
}

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  return new Intl.NumberFormat("en-US").format(n);
}

// formatDuration renders milliseconds as ms, s, m or h.
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = s / 60;
  if (m < 60) return `${Math.round(m)} min`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${Math.round(h / 24)} d`;
}

// formatRelative renders a timestamp as "3 min ago" / "in 2 h" for recent times, else a date.
export function formatRelative(ts: number, now = Date.now()): string {
  const diff = ts - now;
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  let text: string;
  if (abs < minute) text = "just now";
  else if (abs < hour) text = `${Math.round(abs / minute)} min`;
  else if (abs < day) text = `${Math.round(abs / hour)} h`;
  else if (abs < 30 * day) text = `${Math.round(abs / day)} d`;
  else return new Date(ts).toLocaleDateString();
  if (text === "just now") return text;
  return diff < 0 ? `${text} ago` : `in ${text}`;
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
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

// labelFor turns a snake_case key into a readable label.
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
