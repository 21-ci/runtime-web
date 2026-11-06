import { describe, expect, it } from "vitest";

import { capPoints, formatBytes, linePath, MAX_POINTS, nearestIndex, niceMax } from "./chart";

const box = { width: 100, height: 100, left: 0, right: 0, top: 0, bottom: 0 };

describe("capPoints", () => {
  it("leaves a short series alone", () => {
    const p = [{ ts: 1, value: 1 }];
    expect(capPoints(p)).toEqual(p);
  });

  it("never returns more than 300 points, and keeps the last time", () => {
    const p = Array.from({ length: 1440 }, (_, i) => ({ ts: i, value: i }));
    const out = capPoints(p);
    expect(MAX_POINTS).toBe(300);
    expect(out).toHaveLength(300);
    expect(out.at(-1)?.ts).toBe(1439);
  });

  it("keeps an empty bucket as a gap, not as zero", () => {
    const p = [{ ts: 0, value: null }, { ts: 1, value: null }, { ts: 2, value: 4 }, { ts: 3, value: 6 }];
    expect(capPoints(p, 2).map((x) => x.value)).toEqual([null, 5]);
  });
});

describe("linePath", () => {
  it("lifts the pen over a gap", () => {
    const d = linePath([{ ts: 0, value: 0 }, { ts: 1, value: null }, { ts: 2, value: 1 }], box, 1);
    expect(d).toBe("M0.0 100.0M100.0 0.0");
  });

  it("draws nothing for no points", () => {
    expect(linePath([], box, 1)).toBe("");
  });
});

describe("axis and hover", () => {
  it("rounds the top up", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(130)).toBe(200);
    expect(niceMax(3)).toBe(5);
    expect(niceMax(900)).toBe(1000);
  });

  it("finds the nearest point", () => {
    const p = [{ ts: 0, value: 1 }, { ts: 10, value: 2 }, { ts: 100, value: 3 }];
    expect(nearestIndex(p, 0.09)).toBe(1);
    expect(nearestIndex(p, 2)).toBe(2);
    expect(nearestIndex([], 0.5)).toBe(-1);
  });

  it("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });
});
