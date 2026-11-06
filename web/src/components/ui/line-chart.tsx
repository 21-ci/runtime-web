import { useId, useState, type PointerEvent } from "react";

import { NoData } from "@/components/ui/no-data";
import { capPoints, linePath, nearestIndex, niceMax, type Box, type ChartPoint } from "@/lib/chart";
import { formatDateTime } from "@/lib/format";

const BOX: Box = { width: 600, height: 140, left: 44, right: 8, top: 8, bottom: 18 };

export type LineChartLabels = { noData: string; table: string; time: string; value: string };

// LineChart: one series, one axis, hand-written SVG. The title names the series, so no legend is needed. Hover
// and keyboard focus show a crosshair and the value; the same points are in a table for anyone who cannot see
// the line. Colors are the theme's tokens, so dark mode comes with them.
export function LineChart({
  title,
  points,
  format = (v) => String(Math.round(v * 100) / 100),
  labels,
  max,
}: {
  title: string;
  points: readonly ChartPoint[];
  format?: (v: number) => string;
  labels: LineChartLabels;
  /** The axis's top when the quantity has a real ceiling, such as a disk's size. */
  max?: number | undefined;
}) {
  const data = capPoints(points);
  const [hover, setHover] = useState<number | null>(null);
  const titleId = useId();
  const values = data.map((p) => p.value).filter((v): v is number => v !== null);
  const plotW = BOX.width - BOX.left - BOX.right;
  const plotH = BOX.height - BOX.top - BOX.bottom;
  const yMax = max && max > 0 ? max : niceMax(values.length ? Math.max(...values) : 0);
  const first = data[0]?.ts ?? 0;
  const span = (data[data.length - 1]?.ts ?? first) - first || 1;
  const xOf = (ts: number) => (data.length === 1 ? BOX.left + plotW / 2 : BOX.left + ((ts - first) / span) * plotW);
  // A known value with no known neighbour draws no line, so it gets a dot: 10 requests must not look like none.
  const lone = data.filter((p, i) => p.value !== null && (data[i - 1]?.value ?? null) === null && (data[i + 1]?.value ?? null) === null);
  const yOf = (v: number) => BOX.top + plotH - (Math.min(v, yMax) / yMax) * plotH;

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width === 0) return;
    const x = ((e.clientX - r.left) / r.width) * BOX.width;
    setHover(nearestIndex(data, (x - BOX.left) / plotW));
  };
  const active = hover === null ? undefined : data[hover];

  return (
    <figure className="flex min-w-0 flex-col gap-1">
      <figcaption id={titleId} className="flex items-baseline justify-between gap-2 text-sm font-medium">
        <span>{title}</span>
        {active ? (
          <span className="text-xs font-normal tabular-nums text-muted" data-testid="chart-readout">
            {formatDateTime(active.ts)}: {active.value === null ? "–" : format(active.value)}
          </span>
        ) : null}
      </figcaption>
      {values.length === 0 ? (
        <NoData />
      ) : (
        <>
          <div className="relative">
          {/* HTML, not SVG: the plot stretches on a phone and would squash a circle. */}
          {lone.map((p) => (
            <span
              key={p.ts}
              data-testid="chart-dot"
              className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent"
              style={{ left: `${(xOf(p.ts) / BOX.width) * 100}%`, top: `${(yOf(p.value ?? 0) / BOX.height) * 100}%` }}
            />
          ))}
          <span className="pointer-events-none absolute left-0 top-0 text-[11px] tabular-nums text-muted">{format(yMax)}</span>
          <span className="pointer-events-none absolute bottom-[12%] left-0 text-[11px] tabular-nums text-muted">{format(0)}</span>
          <svg
            viewBox={`0 0 ${BOX.width} ${BOX.height}`}
            preserveAspectRatio="none"
            className="block h-40 w-full touch-none text-accent lg:h-auto"
            role="img"
            aria-labelledby={titleId}
            tabIndex={0}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
            onBlur={() => setHover(null)}
            onKeyDown={(e) => {
              const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
              if (step === 0) return;
              e.preventDefault();
              setHover((h) => Math.max(0, Math.min(data.length - 1, (h ?? data.length) + step)));
            }}
          >
            <line x1={BOX.left} x2={BOX.width - BOX.right} y1={BOX.top} y2={BOX.top} className="stroke-line" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <line x1={BOX.left} x2={BOX.width - BOX.right} y1={BOX.top + plotH} y2={BOX.top + plotH} className="stroke-line" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <path d={linePath(data, BOX, yMax)} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" data-testid="chart-line" />
            {active ? (
              <g>
                <line x1={xOf(active.ts)} x2={xOf(active.ts)} y1={BOX.top} y2={BOX.top + plotH} className="stroke-muted" strokeWidth={1} />
                {active.value !== null ? <circle cx={xOf(active.ts)} cy={yOf(active.value)} r={4} fill="currentColor" className="stroke-surface" strokeWidth={2} /> : null}
              </g>
            ) : null}
          </svg>
          </div>
          <details className="text-xs text-muted">
            <summary className="cursor-pointer">{labels.table}</summary>
            <div className="max-h-48 overflow-auto">
              <table className="w-full tabular-nums">
                <thead>
                  <tr>
                    <th className="text-left font-medium">{labels.time}</th>
                    <th className="text-right font-medium">{labels.value}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((p) => (
                    <tr key={p.ts}>
                      <td>{formatDateTime(p.ts)}</td>
                      <td className="text-right">{p.value === null ? "–" : format(p.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </figure>
  );
}
