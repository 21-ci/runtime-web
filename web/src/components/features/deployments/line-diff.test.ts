import { describe, expect, it } from "vitest";

import { lineDiff } from "./line-diff";

describe("lineDiff", () => {
  it("marks added, removed and unchanged lines in order", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "add", text: "x" },
      { kind: "del", text: "b" },
      { kind: "same", text: "c" },
    ]);
  });

  it("handles an empty side and identical files", () => {
    expect(lineDiff("a", "a")).toEqual([{ kind: "same", text: "a" }]);
    expect(lineDiff("", "a")?.filter((l) => l.kind === "add")).toEqual([{ kind: "add", text: "a" }]);
  });

  it("gives up on very large changes instead of freezing the tab", () => {
    const big = (c: string) => Array.from({ length: 3000 }, (_, i) => `${c}${i}`).join("\n");
    expect(lineDiff(big("a"), big("b"))).toBeNull();
  });
});
