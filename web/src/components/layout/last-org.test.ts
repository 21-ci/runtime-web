import { beforeEach, describe, expect, it } from "vitest";

import { pickOrg, readLastOrg, writeLastOrg } from "./last-org";

describe("last org", () => {
  beforeEach(() => localStorage.clear());

  it("remembers the last org", () => {
    expect(readLastOrg()).toBeNull();
    writeLastOrg("acme");
    expect(readLastOrg()).toBe("acme");
  });

  it("picks the remembered org only while the user still belongs to it", () => {
    const orgs = [{ slug: "acme" }, { slug: "beta" }];
    expect(pickOrg(undefined, "beta")).toBeNull();
    expect(pickOrg(orgs, "beta")).toBe("beta");
    expect(pickOrg(orgs, "gone")).toBe("acme");
    expect(pickOrg(orgs, null)).toBe("acme");
    expect(pickOrg([], "beta")).toBeNull();
  });
});
