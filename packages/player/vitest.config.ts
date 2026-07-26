import { svelte } from "@sveltejs/vite-plugin-svelte";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// @scene/player ships source-only (apps transpile it); this config exists only
// for its own tests. Same split as the apps (see the testing skill):
//   unit    — *.test.ts        → node (pure logic)
//   browser — *.svelte.test.ts → real headless chromium (component render,
//                                 WebGL shader compile — needs a real GL context)
//   visual  — the screenshot suites, EXCLUDED from `yarn test` (see VISUAL below)
const BROWSER = {
  enabled: true,
  headless: true,
  provider: playwright(),
  instances: [{ browser: "chromium" as const }],
};

// The screenshot suites: they render whole visualisers and capture frames. Kept OUT of
// the default `yarn test`, and therefore out of CI, on purpose.
//
// They need a GPU to mean anything. On a CI runner falling back to software WebGL they
// took 300–500 seconds apiece, blew their own timeouts, starved unrelated 15-second
// tests into failing, and threw unhandled "ResizeObserver loop completed with
// undelivered notifications" from mounting and unmounting scenes in quick succession —
// a red build that said nothing about the code. Their value is in being LOOKED at while
// working on an effect, which is exactly what CI cannot do.
//
// Run them with `yarn test:visual` (frames land in src/__tests__/viz-gallery/ and crt/).
const VISUAL = [
  "src/__tests__/viz-gallery.svelte.test.ts",
  "src/__tests__/crt.svelte.test.ts",
  "src/__tests__/crt-order.svelte.test.ts",
  "src/__tests__/crt-element-mode.svelte.test.ts",
  "src/__tests__/viz-layout.svelte.test.ts",
  "src/__tests__/dancer-readout.svelte.test.ts",
];

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
          exclude: VISUAL,
          browser: BROWSER,
        },
      },
      {
        extends: true,
        test: {
          name: "visual",
          include: VISUAL,
          browser: BROWSER,
        },
      },
    ],
  },
});
