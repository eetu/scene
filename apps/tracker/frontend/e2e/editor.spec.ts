import { expect, test } from "@playwright/test";

import { mockLibrary } from "../../../../packages/player/testing/playback-smoke";

// E2E guard for the pattern editor + its Web Audio sequencer. Enters edit mode
// and plays the edited pattern, asserting the sequencer actually runs: the play
// button latches and the playhead row advances — which only happens if the
// scheduler steps rows on the audio clock (seqSchedule → scheduleSeqRow, pulling
// sample buffers from the jam module). Guards the editor extraction, whose
// sequencer/edit-buffer machinery isn't otherwise exercised in a real browser.
test("editor: the sequencer plays the edited pattern and the playhead advances", async ({
  context,
  page,
}) => {
  await mockLibrary(context);
  // The editor is hidden behind a flag while it's unfinished (no save, no undo,
  // no mobile surface) — see settings.svelte.ts. This spec exists to keep the
  // machinery working while it's shelved, so it turns the flag on rather than
  // being deleted along with the UI.
  await context.addInitScript(() => localStorage.setItem("tracker:editor", "1"));
  await page.goto("/");
  await page.locator("button.row").first().click();
  const overlay = page.locator(".pattern-overlay");
  await expect(overlay).toBeVisible();

  // Edit mode is a custom-build capability (canReadCells) shown on desktop.
  const edit = overlay.getByRole("button", { name: "edit", exact: true });
  await expect(edit, "edit toggle needs the custom build's canReadCells").toBeVisible({
    timeout: 15000,
  });
  await edit.click();

  // Play the edited pattern through the Web Audio sequencer.
  const seq = overlay.getByRole("button", { name: "play or stop the edited pattern" });
  await expect(seq).toBeVisible();
  await seq.click();
  await expect(seq, "sequencer play button latches on").toHaveAttribute("aria-pressed", "true");

  // The playhead marks the currently-sounding row (seqRow); it must advance to a
  // different row as the scheduler steps.
  const playhead = overlay.locator(".trow.playhead");
  await expect(playhead).toBeVisible({ timeout: 5000 });
  const firstRow = await playhead.getAttribute("data-r");
  await expect(async () => {
    const r = await playhead.getAttribute("data-r");
    expect(r, `playhead row stayed at ${r}`).not.toBe(firstRow);
  }).toPass({ timeout: 6000, intervals: [150, 300, 600] });

  await seq.click(); // stop
});

test("the editor is hidden by default while it is unfinished", async ({ context, page }) => {
  // No flag set: nothing about editing should be reachable. A visible "edit"
  // button promises save/undo the app doesn't have.
  await mockLibrary(context);
  await page.goto("/");
  await page.locator("button.row").first().click();
  const overlay = page.locator(".pattern-overlay");
  await expect(overlay).toBeVisible();
  // The pattern grid itself is still there — only the editing surface is gone.
  await expect(overlay.locator(".trow").first()).toBeVisible({ timeout: 15000 });

  await expect(overlay.getByRole("button", { name: "edit", exact: true })).toHaveCount(0);
  await expect(overlay.getByRole("button", { name: "view", exact: true })).toHaveCount(0);
  await expect(
    overlay.getByRole("button", { name: "play or stop the edited pattern" }),
  ).toHaveCount(0);
});
