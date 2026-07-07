import { defineConfig, devices } from "@playwright/test";

// Browser e2e for the tracker SPA. Serves the REAL production build (so the
// vendored libopenmpt worklet is exercised as shipped, not a dev shim) and
// mocks the backend JSON API per-test (see e2e/*.spec.ts + @scene/player's
// shared playback-smoke helper). No Rust backend / transcoder needed.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  timeout: 30_000,
  webServer: {
    command: "yarn build && yarn preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      // The playback specs let the AudioContext start without a gesture; the
      // cold-reload repro (reload-restore) must NOT — it runs in chromium-cold.
      testIgnore: /reload-restore\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        // Let the AudioContext start without a gesture ceremony in headless.
        launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
      },
    },
    {
      name: "webkit",
      testIgnore: /reload-restore\.spec\.ts/,
      use: { ...devices["Desktop Safari"] },
    },
    {
      // Real-world autoplay policy (gesture required), so a cold /?t= restore is
      // exercised the way an actual reload hits it — no autoplay bypass.
      name: "chromium-cold",
      testMatch: /reload-restore\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--autoplay-policy=document-user-activation-required"] },
      },
    },
  ],
});
