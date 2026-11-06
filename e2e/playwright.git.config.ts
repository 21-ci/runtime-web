import { defineConfig } from "@playwright/test";

// Git deploy (R4) journey against a real `rt` node and a real Gitea container. No browser: API calls only.
// `npx playwright test -c playwright.git.config.ts`. See git-deploy/stack.ts for the stack and its limits.
export default defineConfig({
  testDir: ".",
  testMatch: /git-deploy\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Deliveries advance on the console's one-minute job, so a case with several deploys takes minutes.
  timeout: 600_000,
  reporter: [["list"]],
  globalSetup: "./git-deploy/stack.ts",
});
