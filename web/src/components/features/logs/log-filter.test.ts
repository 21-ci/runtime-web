import { describe, expect, it } from "vitest";

import type { LogLine } from "./use-log-stream";
import { exportQuery, matchesLine, parseFilterText, parseLogSearch, rangeBounds } from "./log-filter";

const line = (over: Partial<LogLine>): LogLine => ({ seq: 1, ts: 1, level: "info", version: 1, task_id: null, trigger: null, kind: "runtime", msg: "hello world", truncated: false, ...over });

describe("parseFilterText", () => {
  it("splits tokens from the free text", () => {
    expect(parseFilterText("@level:error  timeout @kind:build")).toEqual({ level: "error", kind: "build", text: "timeout" });
  });
  it("treats an unknown token value as text, so a typo does not silently hide it", () => {
    expect(parseFilterText("@level:nope x")).toEqual({ text: "@level:nope x" });
  });
});

describe("matchesLine", () => {
  it("level is a minimum, kind is exact, text is case-insensitive", () => {
    expect(matchesLine(line({ level: "error" }), { level: "warn" })).toBe(true);
    expect(matchesLine(line({ level: "info" }), { level: "warn" })).toBe(false);
    expect(matchesLine(line({ kind: "build" }), { kind: "runtime" })).toBe(false);
    expect(matchesLine(line({}), { text: "WORLD" })).toBe(true);
    expect(matchesLine(line({}), { text: "absent" })).toBe(false);
  });
});

describe("rangeBounds", () => {
  const NOW = Date.UTC(2026, 10, 6, 15);
  it("a preset ends now", () => {
    expect(rangeBounds({ range: "1h" }, NOW)).toEqual({ since: NOW - 3_600_000, until: NOW });
  });
  it("a custom range uses its own ends and is null until they are valid", () => {
    expect(rangeBounds({ range: "custom", since: "2026-11-06T14:00:00.000Z", until: "2026-11-06T15:00:00.000Z" }, NOW)).toEqual({ since: NOW - 3_600_000, until: NOW });
    expect(rangeBounds({ range: "custom", since: "2026-11-06T16:00:00.000Z", until: "2026-11-06T15:00:00.000Z" }, NOW)).toBeNull();
    expect(rangeBounds({ range: "custom" }, NOW)).toBeNull();
  });
});

describe("exportQuery", () => {
  it("carries the filters on screen as RFC 3339", () => {
    const q = exportQuery("txt", { level: "warn", kind: "build" }, { since: 0, until: 1000 });
    expect(q).toBe("format=txt&level=warn&kind=build&since=1970-01-01T00%3A00%3A00.000Z&until=1970-01-01T00%3A00%3A01.000Z");
  });
});

describe("parseLogSearch", () => {
  it("drops unknown values", () => {
    expect(parseLogSearch({ mode: "range", range: "9y", level: "warn", kind: "x" })).toEqual({ mode: "range", level: "warn" });
  });
});
