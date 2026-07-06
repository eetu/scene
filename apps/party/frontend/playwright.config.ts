import { defineConfig, devices } from "@playwright/test";

// Browser e2e for the party SPA. Same shape as the tracker's: serve the REAL
// production build (so the vendored libopenmpt worklet is exercised as shipped)
// and mock the backend JSON API per-test. Reuses @scene/player's shared
// playback-smoke assertion; the party-specific navigation lives in the spec.
// Port 4174 so it never clashes with a locally-running tracker preview (4173).
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  timeout: 30_000,
  webServer: {
    command: "yarn build && yarn preview --port 4174 --strictPort",
    url: "http://localhost:4174",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  use: {
    baseURL: "http://localhost:4174",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
      },
    },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
