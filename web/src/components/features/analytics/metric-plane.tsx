import { useState } from "react";

import { LineChart, type LineChartLabels } from "@/components/ui/line-chart";
import { Sparkline } from "@/components/ui/stat-tile";
import type { ChartPoint } from "@/lib/chart";
import { cn } from "@/lib/utils";

export type PlaneMetric = {
  key: string;
  label: string;
  value: string;
  points: readonly ChartPoint[];
  format?: (v: number) => string;
  max?: number | undefined;
  tone?: "neutral" | "warning" | "danger";
};

const TONE = { neutral: "text-text", warning: "text-tag-orange-text", danger: "text-danger-text" };

// MetricPlane: one list of metrics and one chart of the picked metric, so load, traffic and latency read in
// one place. Adapted from the library's metric-list-04, drawn with the console's own LineChart: it keeps the
// keyboard readout and data table, and the first route stays free of a chart library.
export function MetricPlane({ metrics, labels, label }: { metrics: readonly PlaneMetric[]; labels: LineChartLabels; label: string }) {
  const [picked, setPicked] = useState<string | null>(null);
  const active = metrics.find((m) => m.key === picked) ?? metrics[0];
  if (!active) return null;
  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
      <ul aria-label={label} className="flex min-w-0 flex-col divide-y divide-line">
        {metrics.map((m) => (
          <li key={m.key}>
            <button
              type="button"
              aria-pressed={m.key === active.key}
              onClick={() => setPicked(m.key)}
              className={cn(
                "grid w-full grid-cols-[minmax(0,1fr)_3.5rem] items-center gap-x-3 rounded-md px-2 py-2 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus",
                m.key === active.key && "bg-panel-2",
              )}
            >
              <span className="min-w-0">
                <span className="block truncate text-[13px] text-muted">{m.label}</span>
                <span className={cn("block truncate text-sm font-medium tabular-nums", TONE[m.tone ?? "neutral"])}>{m.value}</span>
              </span>
              <Sparkline values={m.points.map((p) => p.value)} />
            </button>
          </li>
        ))}
      </ul>
      {/* On a phone the chart comes first, or a long metric list pushes it off the screen. */}
      <div className="order-first min-w-0 lg:order-none">
        <LineChart title={active.label} labels={labels} points={active.points} max={active.max} {...(active.format ? { format: active.format } : {})} />
      </div>
    </div>
  );
}
