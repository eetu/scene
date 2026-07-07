// Repro for the reload bug: opening a track by CLICK works, but reloading with
// the song already in the URL (?t=<hash>) — a real reload, no user gesture —
// leaves the pattern view stuck on "decoding pattern…" and the transport
// showing a pause icon ("playing") while the clock is frozen at 0:00.
//
// Root cause (confirmed by reproduction): the cold restore runs playInOrder from
// an on-mount $effect, so new AudioContext() is created outside a user-gesture
// call stack → the context starts suspended → the worklet never decodes. The
// click path only works because it runs inside the gesture.
//
// Runs in the `chromium-cold` project, which does NOT pass
// --autoplay-policy=no-user-gesture-required (see playwright.config.ts), so the
// gesture requirement is honest — the bypass the other specs use would mask this.
import { expect, test } from "@playwright/test";

import { mockLibrary } from "../../../../packages/player/testing/playback-smoke";

test("cold reload of /?t= decodes the pattern and keeps the transport honest", async ({
  context,
  page,
}) => {
  await mockLibrary(context); // one track, hash "testhash"

  // The exact user flow: click a track to play it, then reload. The reload
  // re-enters with ?t=testhash in the URL and restores on mount — no gesture.
  await page.goto("/");
  await page.locator("button.row").first().click();
  await expect(page.getByTestId("transport-time")).toBeVisible();
  await page.reload();

  // The player view reopens on restore (showPattern is set by the restore effect).
  await expect(page.getByTestId("transport-time")).toBeVisible();

  // Primary symptom — the pattern must decode, not hang on the placeholder.
  // (Non-vacuous: the overlay is open, so this element IS in the DOM; it must
  // go away, not merely be absent.)
  await expect(
    page.getByText("decoding pattern…"),
    "pattern hangs on 'decoding pattern…' after a cold reload",
  ).toHaveCount(0, { timeout: 8000 });

  // Secondary symptom — the transport must not lie: a pause icon means
  // "playing", so it can't sit on a frozen 0:00.
  const label = await page
    .getByRole("button", { name: /^(play|pause)$/ })
    .getAttribute("aria-label");
  const txt = (await page.getByTestId("transport-time").textContent()) ?? "";
  expect(
    label === "pause" && txt.split("/")[0].trim() === "0:00",
    `transport lies after reload: playBtn=${label} time="${txt}"`,
  ).toBe(false);
});
