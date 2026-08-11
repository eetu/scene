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
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" as const }],
    },
  },
});
