import { expect, test } from "@playwright/test";

import { mockLibrary } from "../../../../packages/player/testing/playback-smoke";

// End-to-end guard for the Web Audio sampler (packages/player/src/jam.ts): the
// real built SPA + the custom-build worklet in a real browser. Opens a module,
// goes to the samples view, holds on the waveform to audition a sample, and
// asserts the live play cursor appears — which is only rendered while a jammed
// voice is actually sounding (playback.jamPos >= 0). That exercises the whole
// path the core-store refactor touched: canReadSamples from the custom build,
// attachJam wiring the engine, jamNote building + starting a buffer voice, and
// tickCursor advancing jamPos.
test("jams a sample: auditioning the waveform sounds a voice (play cursor appears)", async ({
  context,
  page,
}) => {
  await mockLibrary(context);
  await page.goto("/");

  // Open the (only) library row → loads the module, then switch to the samples
  // tab in the player overlay.
  await page.locator("button.row").first().click();
  const overlay = page.locator(".pattern-overlay");
  await expect(overlay).toBeVisible();
  await overlay.getByRole("button", { name: "samples", exact: true }).click();

  // The waveform only renders on the custom build (canReadSamples) once the
  // module's samples have been read; the props panel means the sample data is
  // loaded, so click-to-audition won't no-op.
  const wave = overlay.getByTestId("sample-wave");
  await expect(wave, "custom-build waveform should render for a module with samples").toBeVisible({
    timeout: 15000,
  });
  await expect(overlay.locator(".props")).toBeVisible({ timeout: 15000 });

  // Press-and-hold on the waveform to audition (a real gesture, so the audio
  // context resumes) and keep the voice sounding while we assert.
  const box = await wave.boundingBox();
  if (!box) throw new Error("waveform has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  try {
    await expect(
      overlay.getByTestId("sample-cursor"),
      "play cursor appears while a jammed voice is sounding",
    ).toBeVisible({ timeout: 5000 });
  } finally {
    await page.mouse.up();
  }
});
