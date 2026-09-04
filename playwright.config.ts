import { defineConfig } from "@playwright/test";

const executablePath = process.env.OXRAIL_CHROMIUM_PATH;

export default defineConfig({
  testDir: "./tests",
  testMatch: "native-fixture.spec.ts",
  fullyParallel: false,
  retries: 0,
  reporter: "line",
  use: {
    headless: true,
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    command: "node benchmarks/harness/server.mjs",
    port: 4173,
    reuseExistingServer: true,
  },
});
