// Guards the bookmarkable-song URL state: the open track is mirrored in ?t=,
// and loading that URL restores the song + opens the player view. (Also what
// keeps a dev HMR reload from losing your place.)
import { expect, test } from "@playwright/test";

import { mockLibrary } from "../../../../packages/player/testing/playback-smoke";

test("clicking a track writes ?t=<hash> to the URL", async ({ context, page }) => {
  const track = await mockLibrary(context); // hash "testhash"
  await page.goto("/");
  await page.locator("button.row").first().click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("t"), { timeout: 5000 })
    .toBe(track.hash);
});

test("loading /?t=<hash> restores the track: pattern decodes, transport ready (no autoplay)", async ({
  context,
  page,
}) => {
  await mockLibrary(context);
  await page.goto("/?t=testhash");
  // Restored on a cold load: the worker decodes the pattern (no gesture needed),
  // so the grid fills in — but audio does NOT auto-start (the browser blocks it
  // without a gesture), so the transport shows ▶, not a pause icon over a frozen
  // clock. Starting audio needs a tap; that's covered by the click-path specs.
  await expect(page.getByTestId("transport-time")).toBeVisible();
  await expect(page.getByText("decoding pattern…")).toHaveCount(0, { timeout: 8000 });
  const playBtn = page.getByRole("button", { name: /^(play|pause)$/ });
  await expect(playBtn).toHaveAttribute("aria-label", "play");
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
