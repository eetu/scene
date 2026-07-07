// Guards the PlayerView overlay (extracted from +page) + the shared pv tab store:
// opening a track shows the overlay, the tabs switch the surface, and Escape
// closes it. Deliberately does NOT assert audio advances (that's the flaky
// headless-audio path covered — and skipped — elsewhere); this is structure only.
import { expect, test } from "@playwright/test";

import { mockLibrary } from "../../../../packages/player/testing/playback-smoke";

test("opening a track shows the player overlay; tabs switch; Escape closes", async ({
  context,
  page,
}) => {
  await mockLibrary(context);
  await page.goto("/");

  // Tap the track row → the full-screen overlay opens with its tab bar.
  await page.locator("button.row").first().click();
  const overlay = page.locator(".pattern-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay.getByRole("button", { name: "viz", exact: true })).toBeVisible();

  // viz tab → the visualizer picker (driven by the pv store) appears.
  await overlay.getByRole("button", { name: "viz", exact: true }).click();
  await expect(overlay.locator(".vizpick")).toBeVisible();

  // samples tab → the sample browser surface.
  await overlay.getByRole("button", { name: "samples", exact: true }).click();
  await expect(overlay.locator(".vizpick")).toHaveCount(0);

  // Escape closes the overlay (back to the list).
  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
});
