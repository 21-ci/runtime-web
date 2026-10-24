// formatLimit turns one flattened limit (key and value) into a readable label and value. Units come
// from the key: "_bytes" shows KiB/MiB, "_ms" and "_seconds" show a suffix. A null limit means
// no cap, shown as "unlimited".
const UNIT_TOKENS = new Set(["bytes", "ms", "seconds"]);
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

export function formatLimit(key: string, value: unknown): { label: string; value: string } {
  const tokens = key.split("_");
  const unit = tokens.find((t) => UNIT_TOKENS.has(t));
  const words = tokens.filter((t) => !UNIT_TOKENS.has(t)).join(" ");
  const label = words.charAt(0).toUpperCase() + words.slice(1);
  return { label, value: formatValue(value, unit) };
}

function formatValue(value: unknown, unit: string | undefined): string {
  if (value === null || value === undefined) return "unlimited";
  if (typeof value === "number") {
    if (unit === "bytes") return formatBytes(value);
    if (unit === "ms") return `${value} ms`;
    if (unit === "seconds") return `${value} s`;
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
  const shown = Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, "");
  return `${shown} ${BYTE_UNITS[i]}`;
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
