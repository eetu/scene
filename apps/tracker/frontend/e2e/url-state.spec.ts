// Guards the bookmarkable-song URL state: the open track is mirrored in ?t=,
// and loading that URL restores the song + opens the player view. (Also what
// keeps a dev HMR reload from losing your place.)
import { expect, test } from "@playwright/test";

import {
  expectPlaybackAdvances,
  mockLibrary,
} from "../../../../packages/player/testing/playback-smoke";

test("clicking a track writes ?t=<hash> to the URL", async ({ context, page }) => {
  const track = await mockLibrary(context); // hash "testhash"
  await page.goto("/");
  await page.locator("button.row").first().click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("t"), { timeout: 5000 })
    .toBe(track.hash);
});

test("loading /?t=<hash> opens the player view and plays", async ({ context, page }) => {
  await mockLibrary(context);
  await page.goto("/?t=testhash");
  // Restored → the module loads + decodes and the transport clock advances,
  // proving the pattern view opened onto a real decode (not frozen on
  // "decoding pattern…").
  await expectPlaybackAdvances(page);
});

test("the copy-link button puts ?t=&pos= on the clipboard", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockLibrary(context);
  await page.goto("/");
  await page.locator("button.row").first().click(); // opens the player view + plays
  await page.getByLabel("copy link at current time").click();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  expect(url).toMatch(/[?&]t=testhash/);
  expect(url).toMatch(/[?&]pos=\d+/);
});
