import { svelte } from "@sveltejs/vite-plugin-svelte";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// One project: this tool is UI, so what is worth testing is that it mounts,
// paints and saves in a real browser. The format and the paint operations
// themselves are tested in @scene/player, where they live.
export default defineConfig({
  plugins: [svelte()],
  test: {
    include: ["src/__tests__/*.svelte.test.ts"],
    // One file at a time. Every suite here mounts the whole app in a real
    // browser, and running several of those at once is more than a two-core CI
    // runner has: the ones that lose the race fail while their module is still
    // being fetched — "Failed to fetch dynamically imported module", which reads
    // like a broken import rather than a starved machine. The suite is a couple
    // of seconds either way, so there is nothing to win by overlapping them.
    fileParallelism: false,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" as const }],
    },
  },
});
