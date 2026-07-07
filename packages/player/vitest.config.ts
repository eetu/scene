import { svelte } from "@sveltejs/vite-plugin-svelte";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// @scene/player ships source-only (apps transpile it); this config exists only
// for its own tests. Same split as the apps (see the testing skill):
//   unit    — *.test.ts        → node (pure logic)
//   browser — *.svelte.test.ts → real headless chromium (component render,
//                                 WebGL shader compile — needs a real GL context)
export default defineConfig({
  plugins: [svelte()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.{test,spec}.{js,ts}"],
          exclude: ["src/**/*.svelte.{test,spec}.{js,ts}"],
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: ["src/**/*.svelte.{test,spec}.{js,ts}"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
