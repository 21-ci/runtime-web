import { defineConfig } from "vitest/config";

// Two projects: `unit` runs in Node against the in-memory adapters; `integration`
// talks to a live local runtime (RT_INVOKE) and skips itself when that is unset.
export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["test/**/*.test.ts"], exclude: ["test/integration/**"] } },
      { test: { name: "integration", include: ["test/integration/**/*.test.ts"], testTimeout: 30_000 } },
    ],
  },
});
