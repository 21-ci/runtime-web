import { defineConfig, devices } from "@playwright/test";

// The stack is started by `make e2e` (docker compose up --build --wait). Hosts follow .env.example.
const consoleURL = process.env.E2E_CONSOLE_URL ?? "http://console.localhost:8080";

export default defineConfig({
  testDir: ".",
  testMatch: /smoke\.spec\.ts/,
  // One journey, one worker: the steps share the stack state (admin, org, app).
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: [["list"]],
  use: {
    baseURL: consoleURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
