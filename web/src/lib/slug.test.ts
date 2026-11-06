import { describe, expect, it } from "vitest";

import { isBranchEnvironment, slugError, SLUG_RE } from "./slug";

describe("slugError", () => {
  it("accepts what the server accepts", () => {
    for (const s of ["a", "my-app", "app2", "a".repeat(63)]) {
      expect(SLUG_RE.test(s)).toBe(true);
      expect(slugError(s)).toBeNull();
    }
  });

  it("names the characters that are not allowed, once each", () => {
    const m = slugError("Bad_Name_B");
    expect(m).toContain("B, _, N.");
    expect(m).not.toContain("Enter");
  });

  it("explains the other rules", () => {
    expect(slugError("-app")).toMatch(/start and end/i);
    expect(slugError("app-")).toMatch(/start and end/i);
    expect(slugError("a--b")).toMatch(/two hyphens/i);
    expect(slugError("a".repeat(64))).toMatch(/63/);
  });

  it("agrees with the pattern on everything it passes", () => {
    for (const s of ["A", "a b", "é", "a-", "--", "a--b", "a.b"]) {
      expect(slugError(s)).not.toBeNull();
      expect(SLUG_RE.test(s)).toBe(false);
    }
  });
});

describe("isBranchEnvironment", () => {
  it("recognises the runtime's label for a branch", () => {
    expect(isBranchEnvironment("br-priority")).toBe(true);
    expect(isBranchEnvironment("production")).toBe(false);
    expect(isBranchEnvironment("brown")).toBe(false);
  });
});
