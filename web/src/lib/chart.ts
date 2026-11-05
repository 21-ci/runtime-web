// Geometry for the hand-written SVG charts: no chart library is worth its bytes for one line and an axis.

export type ChartPoint = { ts: number; value: number | null };

/** The most points a chart draws. */
export const MAX_POINTS = 300;

/** Averages neighbours down to the cap. A bucket with no numbers stays a gap rather than turning into zero. */
export function capPoints(points: readonly ChartPoint[], max = MAX_POINTS): ChartPoint[] {
  if (points.length <= max) return [...points];
  const out: ChartPoint[] = [];
  const size = points.length / max;
  for (let i = 0; i < max; i++) {
    const bucket = points.slice(Math.floor(i * size), Math.floor((i + 1) * size));
    const vals = bucket.map((p) => p.value).filter((v): v is number => v !== null);
    out.push({
      ts: bucket[bucket.length - 1]?.ts ?? 0,
      value: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
    });
  }
  return out;
}

/** A round upper bound for the axis, so the top label reads as a plain number. */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(max));
  const n = max / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

export type Box = { width: number; height: number; left: number; right: number; top: number; bottom: number };

/** An SVG path. A gap in the data lifts the pen, so a missing hour never looks like a real slope. */
export function linePath(points: readonly ChartPoint[], box: Box, yMax: number): string {
  if (points.length === 0) return "";
  const first = points[0]?.ts ?? 0;
  const span = (points[points.length - 1]?.ts ?? first) - first || 1;
  const w = box.width - box.left - box.right;
  const h = box.height - box.top - box.bottom;
  let d = "";
  let pen = false;
  for (const p of points) {
    if (p.value === null) {
      pen = false;
      continue;
    }
    const x = box.left + ((p.ts - first) / span) * w;
    const y = box.top + h - (Math.min(p.value, yMax) / yMax) * h;
    d += `${pen ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    pen = true;
  }
  return d;
}

/** The index of the point nearest a horizontal fraction of the plot. */
export function nearestIndex(points: readonly ChartPoint[], fraction: number): number {
  if (points.length === 0) return -1;
  const first = points[0]?.ts ?? 0;
  const span = (points[points.length - 1]?.ts ?? first) - first;
  const target = first + Math.max(0, Math.min(1, fraction)) * span;
  let best = 0;
  points.forEach((p, i) => {
    if (Math.abs(p.ts - target) < Math.abs((points[best]?.ts ?? 0) - target)) best = i;
  });
  return best;
}

export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}
