import type { ReactNode } from "react";

import { LeaderboardBar } from "@/components/dashboardblocks/leaderboard";
import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";

import type { Segment } from "./analytics-lib";

const share = (value: number, total: number) => `${total > 0 ? Math.round((value / total) * 100) : 0}%`;

// ShareBar: the library's breakdown-01 layout, one 100% bar with each part listed below, ranked.
export function ShareBar({ segments, label }: { segments: readonly Segment[]; label: string }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  return (
    <div className="flex flex-col gap-3">
      <div
        role="img"
        aria-label={`${label}: ${segments.map((s) => `${s.label} ${share(s.value, total)}`).join(", ")}`}
        className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full"
      >
        {segments.map((s) => (
          <span key={s.key} className="h-full min-w-0" style={{ backgroundColor: s.color, flex: `${s.value} 0 0` }} />
        ))}
      </div>
      <ul className="flex w-full min-w-0 flex-col divide-y divide-line text-sm">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center gap-2 py-2">
            <span aria-hidden="true" className="size-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: s.color }} />
            <span className="min-w-0 flex-1 break-all">{s.label}</span>
            <span className="tabular-nums">{formatCount(s.value)}</span>
            <span className="w-10 text-right tabular-nums text-muted">{share(s.value, total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// RankedList: the library's leaderboard-01. Rows flow into as many columns as the width allows, the
// bar runs relative to the leader, and the card grows with the rows.
export function RankedList({ segments, label, extra }: { segments: readonly Segment[]; label: string; extra?: (s: Segment) => ReactNode }) {
  const max = Math.max(1, ...segments.map((s) => s.value));
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  return (
    <ul aria-label={label} className="grid gap-x-6 gap-y-1.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,20rem),1fr))]">
      {segments.map((s, i) => (
        <li key={s.key} className="relative isolate flex min-h-10 items-center gap-3 rounded-md px-3 text-sm">
          <LeaderboardBar value={(s.value / max) * 100} delay={i * 60} />
          <span className="min-w-0 flex-1 truncate font-medium" title={s.label}>
            {s.label}
            {extra?.(s)}
          </span>
          <span className="shrink-0 font-medium tabular-nums">{formatCount(s.value)}</span>
          <span className="w-10 shrink-0 text-right tabular-nums text-muted">{share(s.value, total)}</span>
        </li>
      ))}
    </ul>
  );
}

export type DumbbellRow = { key: string; label: string; before: number; after: number };

// DumbbellList: comparison-04. Each row runs from one figure to another on a shared scale.
export function DumbbellList({
  rows,
  beforeLabel,
  afterLabel,
  format,
}: {
  rows: readonly DumbbellRow[];
  beforeLabel: string;
  afterLabel: string;
  format: (v: number) => string;
}) {
  const max = Math.max(0, ...rows.flatMap((r) => [r.before, r.after])) * 1.1 || 1;
  const at = (v: number) => `${(v / max) * 100}%`;
  return (
    <div className="flex flex-col">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2.5 rounded-full border-2 border-accent" />
          {beforeLabel}
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2.5 rounded-full bg-accent" />
          {afterLabel}
        </li>
      </ul>
      <ul className="mt-1 flex flex-col divide-y divide-line">
        {rows.map((r) => (
          <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 py-2.5 md:grid-cols-[6rem_minmax(0,1fr)_10rem]">
            <span className="truncate text-sm font-medium">{r.label}</span>
            <span className="flex items-center justify-end gap-2 whitespace-nowrap text-sm tabular-nums md:order-last">
              <span className="text-muted">
                <span className="sr-only">{beforeLabel}: </span>
                {format(r.before)}
              </span>
              <span aria-hidden="true" className="text-muted">→</span>
              <span className="font-medium">
                <span className="sr-only">{afterLabel}: </span>
                {format(r.after)}
              </span>
            </span>
            <div aria-hidden="true" className="relative col-span-2 h-4 md:col-span-1">
              <span className="absolute top-1/2 h-px w-full -translate-y-1/2 bg-line-strong" />
              <span
                className="absolute top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-accent"
                style={{ left: at(Math.min(r.before, r.after)), width: at(Math.abs(r.after - r.before)) }}
              />
              <span className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-surface" style={{ left: at(r.before) }} />
              <span className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-surface" style={{ left: at(r.after) }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// IntervalBar: from comparison-02. The dot is the estimate, the band its interval, the centre line zero.
export function IntervalBar({ estimate, low, high, extent }: { estimate: number; low: number; high: number; extent: number }) {
  const at = (v: number) => Math.min(100, Math.max(0, ((v + extent) / (2 * extent)) * 100));
  return (
    <div aria-hidden="true" className="relative h-6 w-full">
      <span className="absolute top-1/2 h-px w-full -translate-y-1/2 bg-line-strong" />
      <span className="absolute inset-y-0 left-1/2 w-px bg-muted" />
      <span className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-accent opacity-30" style={{ left: `${at(low)}%`, width: `${at(high) - at(low)}%` }} />
      <span className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-surface" style={{ left: `${at(estimate)}%` }} />
    </div>
  );
}

// HourHeatmap: heatmap-04, as a CSS grid. Rows are weekdays, columns hours.
export function HourHeatmap({ grid, weekdays, label }: { grid: readonly (readonly number[])[]; weekdays: readonly string[]; label: string }) {
  const max = Math.max(1, ...grid.flat());
  return (
    <div className="overflow-x-auto">
      <div role="img" aria-label={label} className="grid w-max grid-cols-[2.5rem_repeat(24,14px)] items-center gap-[2px] text-[11px] text-muted">
        {grid.map((row, d) => [
          <span key={`d${d}`} className="truncate">{weekdays[d]}</span>,
          ...row.map((n, h) => (
            <span
              key={`${d}-${h}`}
              title={`${weekdays[d]} ${String(h).padStart(2, "0")}:00: ${formatCount(n)}`}
              className={cn("h-3.5 rounded-[2px]", n === 0 ? "bg-panel-2" : "bg-accent")}
              style={n === 0 ? undefined : { opacity: 0.2 + 0.8 * (n / max) }}
            />
          )),
        ])}
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="text-center text-[10px] tabular-nums">{h % 6 === 0 ? h : ""}</span>
        ))}
      </div>
    </div>
  );
}
