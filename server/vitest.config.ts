import { defineConfig } from "vitest/config";

// Two projects: `unit` runs in Node against the in-memory adapters; `integration`
// talks to a live local runtime (RT_INVOKE) and skips itself when that is unset.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/gen/**"],
      // Floors at the current unit-test level rounded down; raise them, never lower them.
      thresholds: { statements: 90, branches: 79, functions: 92, lines: 94 },
    },
    projects: [
      { test: { name: "unit", include: ["test/**/*.test.ts"], exclude: ["test/integration/**"] } },
      { test: { name: "integration", include: ["test/integration/**/*.test.ts"], testTimeout: 30_000 } },
    ],
  },
});
