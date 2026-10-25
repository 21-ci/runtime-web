import { describe, expect, it } from "vitest";

import { planAllowsCron } from "./cron-allowed";

describe("planAllowsCron", () => {
  it("allows cron when the plan does not restrict trigger kinds", () => {
    expect(planAllowsCron({})).toBe(true);
    expect(planAllowsCron({ allowed_triggers: null })).toBe(true);
    expect(planAllowsCron(undefined)).toBe(true);
  });

  it("forbids cron when the plan lists trigger kinds without it", () => {
    expect(planAllowsCron({ allowed_triggers: ["interval", "http"] })).toBe(false);
    expect(planAllowsCron({ allowed_triggers: ["cron", "interval"] })).toBe(true);
  });
});
