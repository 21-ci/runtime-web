import { describe, expect, it } from "vitest";

import { formatBytes, formatCount, formatDuration, formatQuantity, formatRelative, labelFor } from "./format";

describe("format", () => {
  it("formats bytes with binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.00 KiB");
    expect(formatBytes(1_048_576)).toBe("1.00 MiB");
    expect(formatBytes(15.5 * 1_048_576)).toBe("15.5 MiB");
    expect(formatBytes(27.2 * 1024 ** 3)).toBe("27.2 GiB");
    expect(formatBytes(null)).toBe("-");
  });

  it("groups counts", () => {
    expect(formatCount(100000)).toBe("100,000");
    expect(formatCount(undefined)).toBe("-");
  });

  it("formats durations from milliseconds", () => {
    expect(formatDuration(13)).toBe("13 ms");
    expect(formatDuration(2500)).toBe("2.5 s");
    expect(formatDuration(45_000)).toBe("45 s");
    expect(formatDuration(3 * 60_000)).toBe("3 min");
    expect(formatDuration(3.6e6)).toBe("1.0 h");
    expect(formatDuration(3 * 24 * 3.6e6)).toBe("3 d");
  });

  it("picks a unit from the metric name", () => {
    expect(formatQuantity("committed_bytes", 1024)).toBe("1.00 KiB");
    expect(formatQuantity("uptime_ms", 60_000)).toBe("1 min");
    expect(formatQuantity("idle_seconds", 45)).toBe("45 s");
    expect(formatQuantity("procs", 10)).toBe("10");
    expect(formatQuantity("mode", "normal")).toBe("normal");
    expect(formatQuantity("x", null)).toBe("-");
  });

  it("renders relative times", () => {
    const now = 1_700_000_000_000;
    expect(formatRelative(now - 10_000, now)).toBe("just now");
    expect(formatRelative(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(formatRelative(now + 2 * 3.6e6, now)).toBe("in 2 h");
    expect(formatRelative(now - 3 * 86_400_000, now)).toBe("3 d ago");
    expect(formatRelative(now - 90 * 86_400_000, now)).toMatch(/\d/);
  });

  it("labels snake_case keys", () => {
    expect(labelFor("bound_count")).toBe("Bound count");
    expect(labelFor("v8-sandbox")).toBe("V8 sandbox");
  });
});
