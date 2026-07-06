import { test } from "@playwright/test";

// Shared, worklet-level assertion lives with @scene/player (party reuses it).
import {
  expectPlaybackAdvances,
  mockLibrary,
} from "../../../../packages/player/testing/playback-smoke";

// End-to-end playback guard: the real built SPA + real vendored WASM worklet in
// a real browser. Would have gone red on the emsdk-6 resizable-ArrayBuffer
// regression that a node gate waved through.
test("plays a module: decodes and the transport clock advances", async ({ context, page }) => {
  await mockLibrary(context);
  await page.goto("/");

  // Tracker-specific step: open the (only) library row → loads + plays.
  await page.locator("button.row").first().click();

  await expectPlaybackAdvances(page);
});
