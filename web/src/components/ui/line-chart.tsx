import { useId, useState, type PointerEvent } from "react";

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
}: {
  title: string;
  points: readonly ChartPoint[];
  format?: (v: number) => string;
  labels: LineChartLabels;
}) {
  const data = capPoints(points);
  const [hover, setHover] = useState<number | null>(null);
  const titleId = useId();
  const values = data.map((p) => p.value).filter((v): v is number => v !== null);
  const plotW = BOX.width - BOX.left - BOX.right;
  const plotH = BOX.height - BOX.top - BOX.bottom;
  const yMax = niceMax(values.length ? Math.max(...values) : 0);
  const first = data[0]?.ts ?? 0;
  const span = (data[data.length - 1]?.ts ?? first) - first || 1;
  const xOf = (ts: number) => BOX.left + ((ts - first) / span) * plotW;
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
        <p className="py-8 text-center text-sm text-muted">{labels.noData}</p>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${BOX.width} ${BOX.height}`}
            className="h-auto w-full touch-none text-accent"
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
            <line x1={BOX.left} x2={BOX.width - BOX.right} y1={BOX.top} y2={BOX.top} className="stroke-line" strokeWidth={1} />
            <line x1={BOX.left} x2={BOX.width - BOX.right} y1={BOX.top + plotH} y2={BOX.top + plotH} className="stroke-line" strokeWidth={1} />
            <text x={BOX.left - 6} y={BOX.top + 4} textAnchor="end" className="fill-muted text-[10px] tabular-nums">
              {format(yMax)}
            </text>
            <text x={BOX.left - 6} y={BOX.top + plotH} textAnchor="end" className="fill-muted text-[10px] tabular-nums">
              {format(0)}
            </text>
            <path d={linePath(data, BOX, yMax)} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" data-testid="chart-line" />
            {active ? (
              <g>
                <line x1={xOf(active.ts)} x2={xOf(active.ts)} y1={BOX.top} y2={BOX.top + plotH} className="stroke-muted" strokeWidth={1} />
                {active.value !== null ? <circle cx={xOf(active.ts)} cy={yOf(active.value)} r={4} fill="currentColor" className="stroke-surface" strokeWidth={2} /> : null}
              </g>
            ) : null}
          </svg>
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
