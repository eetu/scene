// Guards the modal overlays (settings, add-to-playlist, rename) so the upcoming
// component extraction (shared Modal + panels) can't silently regress them —
// nothing else in the suite opens these. Behaviour-level: each opens on the
// right trigger and renders its dialog.
import { expect, test } from "@playwright/test";

import { mockLibrary } from "../../../../packages/player/testing/playback-smoke";

test("settings overlay opens from the topbar", async ({ context, page }) => {
  await mockLibrary(context);
  await page.goto("/");
  await page.getByRole("button", { name: "settings" }).click();
  const dialog = page.getByRole("dialog", { name: "settings" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: /rescan|scanning/ })).toBeVisible();
});

test("add-to-playlist overlay opens from a track row", async ({ context, page }) => {
  await mockLibrary(context);
  await page.goto("/");
  // Row actions can be hover-revealed; hovering the row first is closest to use.
  await page.locator("button.row").first().hover();
  await page.getByRole("button", { name: "add to playlist" }).first().click();
  await expect(page.getByRole("dialog", { name: "add to playlist" })).toBeVisible();
});

test("rename overlay opens from a track row", async ({ context, page }) => {
  await mockLibrary(context);
  await page.goto("/");
  await page.locator("button.row").first().hover();
  await page.getByRole("button", { name: "rename / move" }).first().click();
  await expect(page.getByRole("dialog", { name: "rename or move" })).toBeVisible();
});
