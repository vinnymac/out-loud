import { defineConfig, devices } from "@playwright/test";

// E2E for the web build. Drives a real headless Chromium through the cold-load
// flow, which downloads the ~86 MB model from HuggingFace + espeak/ORT wasm from
// jsDelivr — so timeouts are generous and the run needs network access.
export default defineConfig({
  testDir: "./e2e",
  timeout: 6 * 60 * 1000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4173",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run preview",
    url: "http://localhost:4173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
