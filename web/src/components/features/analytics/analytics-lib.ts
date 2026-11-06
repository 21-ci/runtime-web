export type Segment = { key: string; label: string; value: number; color: string };

export const OTHER_COLOR = "var(--color-tag-gray-solid)";
const PALETTE = [
  "var(--color-accent)",
  "var(--color-tag-orange-solid)",
  "var(--color-tag-purple-solid)",
  "var(--color-tag-teal-solid)",
  "var(--color-tag-pink-solid)",
];

export function outcomeSegments(outcomes: Readonly<Record<string, number>> | undefined): Omit<Segment, "label">[] {
  const known = Object.entries(outcomes ?? {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  let next = 1;
  return known.map(([key, value]) => ({
    key,
    value,
    color: key === "ok" ? "var(--color-tag-green-solid)" : (PALETTE[next++ % PALETTE.length] as string),
  }));
}

export function topSegments(items: readonly { key: string; label: string; value: number }[], n: number, otherLabel: string): Segment[] {
  const sorted = [...items].filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, n).map((i, idx) => ({ ...i, color: PALETTE[idx % PALETTE.length] as string }));
  const rest = sorted.slice(n).reduce((sum, i) => sum + i.value, 0);
  return rest > 0 ? [...head, { key: "__other", label: otherLabel, value: rest, color: OTHER_COLOR }] : head;
}

/** Requests by local weekday (0 is Sunday) and hour. */
export function hourGrid(points: readonly { ts: number; count?: number }[]): number[][] {
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const p of points) {
    const d = new Date(p.ts);
    const row = grid[d.getDay()];
    if (row) row[d.getHours()] = (row[d.getHours()] ?? 0) + (p.count ?? 0);
  }
  return grid;
}

export type Proportions = { rateA: number; rateB: number; difference: number; low: number; high: number; significant: boolean };

// Normal approximation of the 95% interval on the difference of two error rates.
export function compareProportions(a: { errors: number; count: number }, b: { errors: number; count: number }): Proportions {
  const rateA = a.count > 0 ? a.errors / a.count : 0;
  const rateB = b.count > 0 ? b.errors / b.count : 0;
  const se = Math.sqrt((a.count > 0 ? (rateA * (1 - rateA)) / a.count : 0) + (b.count > 0 ? (rateB * (1 - rateB)) / b.count : 0));
  const difference = rateB - rateA;
  const low = difference - 1.96 * se;
  const high = difference + 1.96 * se;
  return { rateA, rateB, difference, low, high, significant: low > 0 || high < 0 };
}
