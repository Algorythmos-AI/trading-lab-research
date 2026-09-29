import { defineConfig, devices } from "@playwright/test";

// CI only: browsers are installed by the workflow (`pnpm exec playwright install --with-deps chromium`),
// never on the owner's Mac. The app runs in fixture mode, so no storage or secrets are needed.
const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "test/e2e",
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
    env: { DASHBOARD_FIXTURE: "1" },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
