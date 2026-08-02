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
  await mockLibrary(context);
  await page.goto("/");

  await page.locator("button.row").first().click();
  const overlay = page.locator(".pattern-overlay");
  await overlay.getByRole("button", { name: "viz", exact: true }).click();

  // Count the visualisers from the DESKTOP pill row, which is the full list by
  // construction, and hold the mobile sheet to the same number. Hard-coding it meant
  // adding a visualiser broke this test for no reason — and the property worth checking
  // was never the number, it was that the sheet lists all of them rather than a subset.
  const vizCount = await overlay.locator(".vizpick button:not(.crt)").count();
  expect(vizCount).toBeGreaterThan(5);

  await page.setViewportSize({ width: 390, height: 780 }); // iPhone-ish portrait

  // One row: two steppers, the current visualiser, and the CRT toggle — not the pills.
  const pick = overlay.locator(".vizpick");
  await expect(pick).toBeVisible();
  // One row, not two: every control has to fit on a phone, which is the whole reason this
  // layout exists. Measured rather than eyeballed — a wrap here is invisible to any
  // structural assertion.
  await expect(pick).toHaveClass(/one-row/);
  const rowH = (await pick.boundingBox())!.height;
  expect(rowH).toBeLessThan(56);
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
  await expect(tiles).toHaveCount(vizCount);
  // A cheap 2D effect on purpose. This test is about the picker, and picking one of the
  // three.js scenes (tubes, paint, dancer) drags a lazy three.js import and a scene build
  // into it — slow anywhere, and on a runner falling back to software WebGL slow enough
  // to time out.
  await sheet.getByRole("button", { name: "copper", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(current).toHaveText("copper");

  // A fullscreen button, because a phone has no 'f' key — but only where the browser can
  // actually do it. iOS Safari has no Element.requestFullscreen, and headless Chromium
  // reports fullscreenEnabled false, so the button is deliberately absent in both. The
  // assertion follows the same condition the component uses rather than assuming a
  // browser that supports it; asserting it unconditionally failed on CI for the very
  // reason the gate exists. Whether fullscreen SUCCEEDS is not asserted either: that
  // needs a real user gesture and headless is unreliable about it.
  const canFullscreen = await page.evaluate(
    () => !!document.fullscreenEnabled && typeof Element.prototype.requestFullscreen === "function",
  );
  await expect(pick.locator(".fs")).toHaveCount(canFullscreen ? 1 : 0);

  // Escape closes it too, rather than stranding it over the picture.
  await current.click();
  await expect(overlay.locator(".vizsheet")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(overlay.locator(".vizsheet")).toHaveCount(0);
  await expect(overlay).toBeVisible();
});

// The CRT bezel is the one part of the viz pane with no test at all — it's CSS, so no
// component test renders it, and it had been carrying hard-coded greys that ignored the
// theme. It now derives from --panel-hi, which is dark on the dark theme and light on the
// light one, so the set sits in the room's lighting rather than glowing out of a dark page.
//
// Asserted on the RESOLVED box-shadow colour rather than the custom property: the property
// holds an unresolved color-mix() expression, which would pass this test while painting
// anything at all.
test("the CRT bezel takes its grey from the theme", async ({ context, page }) => {
  await mockLibrary(context);
  await page.goto("/");
  await page.locator("button.row").first().click();
  const overlay = page.locator(".pattern-overlay");
  await overlay.getByRole("button", { name: "viz", exact: true }).click();

  // Onto a visualiser the CRT actually suits before looking for the bezel. The default is
  // `vu`, and the screen deliberately does not mount over that one — a moving-coil meter is
  // an object in a room, not a picture, so a raster over it claims it is emitting (see
  // `crtSuits`). `copper` for the same reason the picker test picks it: a cheap 2D effect,
  // where one of the three.js scenes would drag a lazy import and a scene build into a test
  // that is about neither.
  await overlay.locator(".vizpick").getByRole("button", { name: "copper", exact: true }).click();

  // CRT is on by default, so the bezel is there; turning it off takes it away.
  const bezel = overlay.locator(".bezel");
  await expect(bezel).toHaveCount(1);

  // Perceived lightness of the face plate. Measured by painting --bezel onto a throwaway
  // probe and reading back its background-color, which a browser always resolves to
  // rgb(). Neither of the direct routes works: the custom property computes to an
  // unresolved color-mix() expression, and box-shadow keeps it unresolved too — parsing
  // that string found the inset recess's rgb(0 0 0) instead and reported 0 for both
  // themes.
  const plateLightness = async () =>
    await bezel.evaluate((el) => {
      const probe = document.createElement("div");
      probe.style.background = "var(--bezel)";
      el.parentElement!.appendChild(probe);
      const rgb = getComputedStyle(probe).backgroundColor;
      probe.remove();
      // Two serialisations to handle: plain rgb(), and color(srgb r g b) with 0..1
      // components, which is how a color-mix() result comes back.
      const srgb = /color\(srgb ([^)]+)\)/.exec(rgb);
      const plain = /rgba?\(([^)]+)\)/.exec(rgb);
      if (!srgb && !plain) throw new Error("unresolved bezel colour: " + rgb);
      const parts = (srgb ? srgb[1] : plain![1]).split(/[ ,/]+/).map((n) => parseFloat(n));
      const [r, g, b] = srgb ? parts.slice(0, 3).map((n) => n * 255) : parts;
      return 0.299 * r + 0.587 * g + 0.114 * b;
    });

  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  const dark = await plateLightness();
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  const light = await plateLightness();

  // Lighter on the light theme, darker on the dark one, and by a margin you can see —
  // two greys a few points apart would satisfy a bare inequality and look identical.
  expect(light, `light=${light} dark=${dark}`).toBeGreaterThan(dark + 60);

  // And it belongs to the screen, not the pane: no CRT, no bezel.
  await overlay.getByRole("button", { name: /CRT screen/ }).click();
  await expect(overlay.locator(".bezel")).toHaveCount(0);
});
