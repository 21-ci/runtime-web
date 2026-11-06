import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type StatTone = "neutral" | "warning" | "danger";

const VALUE_TONE: Record<StatTone, string> = {
  neutral: "text-text",
  warning: "text-tag-orange-text",
  danger: "text-danger-text",
};

// Sparkline: the shape of a series beside its current value. Decorative, because the full chart with
// its table sits on the same page, and null gaps are skipped rather than drawn as zero.
export function Sparkline({ values, className }: { values: readonly (number | null | undefined)[]; className?: string }) {
  const known = values.filter((v): v is number => v != null);
  if (known.length < 2) return null;
  const min = Math.min(...known);
  const span = Math.max(...known) - min || 1;
  const last = values.length - 1 || 1;
  const d = values
    .flatMap((v, i) => (v == null ? [] : [`${((i / last) * 100).toFixed(1)} ${(22 - ((v - min) / span) * 20).toFixed(1)}`]))
    .map((p, i) => `${i === 0 ? "M" : "L"}${p}`)
    .join(" ");
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true" className={cn("h-6 w-full text-accent", className)}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// StatTile is one figure in a stat row; render it inside a <dl>.
export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
  children,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: StatTone;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-surface p-3">
      <dt className="truncate text-xs text-muted">{label}</dt>
      <dd className={cn("text-lg font-semibold tabular-nums", VALUE_TONE[tone])}>{value}</dd>
      {hint ? <p className="truncate text-xs text-muted">{hint}</p> : null}
      {children}
    </div>
  );
}
