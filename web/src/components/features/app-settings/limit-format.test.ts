import { describe, expect, it } from "vitest";

import { formatLimit } from "./limit-format";

describe("formatLimit", () => {
  it.each([
    ["egress_bytes", 1_048_576, "1 MiB"],
    ["storage_bytes", 512, "512 B"],
    ["cpu_ms", 250, "250 ms"],
    ["timeout_seconds", 30, "30 s"],
    ["max_instances", 50, "50"],
    ["invocations", null, "unlimited"],
  ] as const)("formats %s", (key, value, text) => {
    expect(formatLimit(key, value)).toEqual({ label: expect.any(String), value: text });
  });

  it("humanizes the key into a label", () => {
    expect(formatLimit("egress_bytes", 1).label).toBe("Egress");
    expect(formatLimit("max_instances", 1).label).toBe("Max instances");
  });
});
