// Guards type-to-filter: a bare alphanumeric keystroke while the library list is
// focused jumps into the filter box, but space stays play/pause (not captured).
import { expect, test } from "@playwright/test";

import { mockLibrary } from "../../../../packages/player/testing/playback-smoke";

test("a letter with the list focused routes into the filter box", async ({ context, page }) => {
  await mockLibrary(context);
  await page.goto("/");
  const filter = page.locator("input.filter");
  await expect(filter).not.toBeFocused();
  await page.keyboard.press("e");
  await expect(filter).toBeFocused();
  await expect(filter).toHaveValue("e");
});

test("space is not captured by type-to-filter", async ({ context, page }) => {
  await mockLibrary(context);
  await page.goto("/");
  await page.keyboard.press("Space");
  const filter = page.locator("input.filter");
  await expect(filter).toHaveValue("");
  await expect(filter).not.toBeFocused();
});
