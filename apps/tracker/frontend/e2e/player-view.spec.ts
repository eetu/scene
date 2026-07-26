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

// The visualiser picker has two layouts. On a phone the fourteen pills wrap onto two
// rows and the CRT toggle takes a third, so narrow screens get one fixed row — steppers
// plus the current name — and the full set moves into a sheet. Structure only; the
// desktop test above never enters this path, which is exactly how a mobile-only layout
// rots unnoticed.
test("on a phone the viz picker is a stepper row with a sheet for the full set", async ({
  context,
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 780 }); // iPhone-ish portrait
  await mockLibrary(context);
  await page.goto("/");

  await page.locator("button.row").first().click();
  const overlay = page.locator(".pattern-overlay");
  await overlay.getByRole("button", { name: "viz", exact: true }).click();

  // One row: two steppers, the current visualiser, and the CRT toggle — not the pills.
  const pick = overlay.locator(".vizpick");
  await expect(pick).toBeVisible();
  // Exactly two steppers: the fullscreen toggle deliberately isn't one of them, so
  // "the last stepper" keeps meaning "next visualiser".
  await expect(pick.locator(".step")).toHaveCount(2);
  const current = pick.locator(".current");
  await expect(current).toBeVisible();
  const before = (await current.textContent())?.trim();

  // A stepper moves to the next visualiser without opening anything.
  await pick.locator(".step").last().click();
  await expect(current).not.toHaveText(before ?? "");

  // The name opens the sheet with every visualiser in it; picking one closes it.
  await current.click();
  const sheet = overlay.locator(".vizsheet");
  await expect(sheet).toBeVisible();
  const tiles = sheet.locator(".sheetgrid button");
  await expect(tiles).toHaveCount(14);
  await sheet.getByRole("button", { name: "tubes", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(current).toHaveText("tubes");

  // A fullscreen button, because a phone has no 'f' key. Only where the browser can
  // actually do it — iOS Safari has no Element.requestFullscreen, so it is absent there
  // rather than present and dead. Whether fullscreen SUCCEEDS isn't asserted: it needs a
  // real user gesture and headless is unreliable about it, so that stays a manual check.
  await expect(pick.locator(".fs")).toHaveCount(1);
  await expect(pick.getByRole("button", { name: "Fill the screen" })).toBeVisible();

  // Escape closes it too, rather than stranding it over the picture.
  await current.click();
  await expect(overlay.locator(".vizsheet")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(overlay.locator(".vizsheet")).toHaveCount(0);
  await expect(overlay).toBeVisible();
});
