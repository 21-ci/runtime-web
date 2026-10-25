import { defineConfig, devices } from "@playwright/test";

// Targets a console already hosted on a 21 Cloud Runtime node (make server-install, then setup).
// RTWEB_URL is required (no default port: the runtime itself listens on 8080/8081).
// RTWEB_RUNTIME_PUBLIC_URL (app URLs) and RTWEB_SETUP_TOKEN are read by smoke.spec.ts.
const consoleURL = process.env.RTWEB_URL;
if (!consoleURL) throw new Error("e2e: set RTWEB_URL to the runtime-hosted console URL (e.g. https://console.example.com)");

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
