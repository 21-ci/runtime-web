import { describe, expect, it } from "vitest";

import { safeNext } from "./safe-next";

describe("safeNext", () => {
  it.each([
    "/\t/evil.com",
    "/\n/evil.com",
    "//evil.com",
    "/%5Cevil.com",
    "/%2F%2Fevil.com",
    "https://evil.com",
    "javascript:alert(1)",
    "",
    undefined,
  ])("falls back to / for %j", (value) => {
    expect(safeNext(value)).toBe("/");
  });

  it("keeps same-origin paths with query and hash", () => {
    expect(safeNext("/orgs/a?x=1#h")).toBe("/orgs/a?x=1#h");
  });
});
