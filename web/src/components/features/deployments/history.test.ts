import { describe, expect, it } from "vitest";

import type { Switch } from "@/components/features/branches/use-branches";

import { filterHistory, mergeHistory, parseFilters, switchDuration, versionSource } from "./history";
import type { Version } from "./use-versions";

const NOW = 1_000_000_000_000;
const v = (n: number, at: number, over: Partial<Version> = {}): Version => ({
  version: n, build_state: "ready", live: false, source_digest: null, failure: null, author: null, meta: null, created_at: at, ...over,
});
const s = (at: number, over: Partial<Switch> = {}): Switch => ({
  id: `swt_${at}`, kind: "rollback", state: "completed", from_version: 3, to_version: 2, source: null, inflight_old: 0, drain_deadline: null,
  interrupted: false, error: null, warnings: [], pending_migrations: null, dry_run: false, created_at: at, updated_at: at + 1500, ...over,
});

describe("mergeHistory", () => {
  it("puts switches between the versions they happened between, newest first", () => {
    const rows = mergeHistory([v(1, 10), v(2, 30)], [s(20)]);
    expect(rows.map((r) => r.key)).toEqual(["version:2", "switch:swt_20", "version:1"]);
  });
  it("leaves out dry runs, which changed nothing", () => {
    expect(mergeHistory([], [s(20, { dry_run: true })])).toEqual([]);
  });
});

describe("versionSource", () => {
  it("reads the commit from meta, the console from an author, and nothing else is claimed", () => {
    expect(versionSource(v(1, 1, { meta: { git: { sha: "abcdef1234", ref: "main" } } }))).toEqual({ kind: "git", sha: "abcdef1234", ref: "main" });
    expect(versionSource(v(1, 1, { author: { user_id: "u", name: "Ada" } }))).toEqual({ kind: "console" });
    expect(versionSource(v(1, 1))).toEqual({ kind: "api" });
  });
});

describe("switchDuration", () => {
  it("is known only once the switch has finished", () => {
    expect(switchDuration(s(0))).toBe(1500);
    expect(switchDuration(s(0, { state: "draining" }))).toBeNull();
  });
});

describe("filterHistory", () => {
  const rows = mergeHistory(
    [v(1, NOW - 40 * 86_400_000), v(2, NOW - 1000, { build_state: "failed" }), v(3, NOW - 2000, { build_state: "building", meta: { git: { sha: "abc1234" } } })],
    [s(NOW - 500), s(NOW - 600, { state: "failed", id: "bad" })],
  );
  const keys = (f: Parameters<typeof filterHistory>[1]) => filterHistory(rows, f, NOW).map((r) => r.key);

  it("period cuts by time", () => {
    expect(keys({ period: "30d" })).not.toContain("version:1");
    expect(keys({})).toContain("version:1");
  });
  it("state keeps failed switches with failed versions, and hides the other switches", () => {
    expect(keys({ state: "failed" })).toEqual(["switch:bad", "version:2"]);
    expect(keys({ state: "building" })).toEqual(["version:3"]);
  });
  it("source applies to versions only: a switch has no source", () => {
    expect(keys({ source: "git" })).toEqual(["version:3"]);
  });
});

describe("parseFilters", () => {
  it("keeps known values and drops the rest", () => {
    expect(parseFilters({ state: "failed", source: "nope", period: "7d", x: 1 })).toEqual({ state: "failed", period: "7d" });
  });
});
