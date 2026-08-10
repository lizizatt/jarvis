import { defineConfig, devices } from "@playwright/test";

const E2E_PORT = Number(process.env.E2E_PORT ?? 3211);
const externalBase = process.env.PLAYWRIGHT_BASE_URL;
if (externalBase && process.env.PLAYWRIGHT_ALLOW_EXTERNAL !== "true") {
  throw new Error("PLAYWRIGHT_BASE_URL requires PLAYWRIGHT_ALLOW_EXTERNAL=true because e2e tests create tasks and terminal sessions.");
}

export default defineConfig({
  testDir: "./apps/web/e2e",
  outputDir: "./test-results",
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : [["html", { open: "never" }]],
  use: {
    baseURL: externalBase ?? `http://127.0.0.1:${E2E_PORT}`,
    trace: "on-first-retry",
  },
  webServer: externalBase ? undefined : {
    command: `./node_modules/.bin/tsx apps/server/e2e-server.ts`,
    url: `http://127.0.0.1:${E2E_PORT}/api/health`,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    env: { E2E_PORT: String(E2E_PORT) },
  },
  projects: [
    { name: "mobile-chrome", use: { ...devices["Pixel 7"] } },
    { name: "desktop-chrome", use: { ...devices["Desktop Chrome"] } },
  ],
});
