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
