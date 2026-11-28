import { defineConfig, devices } from "@playwright/test";
import { serverErrorFile } from "./test/e2e/server-errors";

// CI only: browsers are installed by the workflow (`pnpm exec playwright install --with-deps chromium`),
// never on the owner's Mac. The app runs in fixture mode, so no storage or secrets are needed.
const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "test/e2e",
  // The server writes down every error it throws (src/instrumentation.ts); the run fails after the tests on any that
  // no fixture flag explains, so a throw that a pane's boundary hides cannot pass unseen (test/e2e/server-errors.ts).
  globalSetup: "./test/e2e/global-setup.ts",
  globalTeardown: "./test/e2e/global-teardown.ts",
  // One set of pictures, made on the CI runner (Linux): the same machine every time, so no platform in the name.
  snapshotPathTemplate: "test/e2e/__screenshots__/{projectName}/{arg}{ext}",
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: "disabled", caret: "hide" } },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "phone", use: { ...devices["Pixel 7"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `pnpm start --hostname 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    env: { DASHBOARD_FIXTURE: "1", E2E_SERVER_ERRORS: serverErrorFile(PORT) },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
