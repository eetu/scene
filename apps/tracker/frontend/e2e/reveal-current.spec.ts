// Guards "reveal the current track when the list comes to the front": returning
// from the player overlay (here via a cold reload that cues a bookmarked ?t)
// should open the current track's group and scroll it into view, instead of
// dropping you at wherever the list happened to be scrolled.
//
// The fixture has enough groups (>12) that grouping defaults to all-closed and
// the target group sits below the fold — so before the reveal the row isn't even
// rendered, and afterwards it must be both expanded and on-screen.
import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { FIXTURE_XM } from "../../../../packages/player/testing/playback-smoke";

const B = readFileSync(FIXTURE_XM);

function trk(group: string, hash: string, title: string) {
  return {
    hash,
    md5: hash,
    path: `${group}/${hash}.xm`,
    group,
    artist: null,
    filename: `${hash}.xm`,
    ext: "xm",
    size: B.length,
    title,
    type_long: "FastTracker II",
    tracker: "",
    duration: 60,
    channels: 4,
    instruments: 0,
    samples: 3,
    favorite: false,
    play_count: 0,
  };
}

// 20 filler groups (2 tracks each) that sort before the target, plus the target
// group pinned last by name ("Zzz…") so its row is well below the fold.
const TARGET_GROUP = "Zzz Last Group";
const TARGET_HASH = "deeptarget";
const TARGET_PATH = `${TARGET_GROUP}/${TARGET_HASH}.xm`;
const tracks = [
  ...Array.from({ length: 20 }, (_, g) =>
    Array.from({ length: 2 }, (_, t) =>
      trk(`Group ${String(g + 1).padStart(2, "0")}`, `g${g}t${t}`, `Filler ${g}-${t}`),
    ),
  ).flat(),
  trk(TARGET_GROUP, TARGET_HASH, "Deep Target Track"),
];

test("reveal-current: closing the player opens + scrolls to the playing track", async ({
  context,
  page,
}) => {
  await context.route("**/api/tracks", (r) => r.fulfill({ json: { tracks } }));
  await context.route("**/api/playlists", (r) => r.fulfill({ json: { playlists: [] } }));
  await context.route("**/api/file/*", (r) =>
    r.fulfill({ contentType: "application/octet-stream", body: B }),
  );
  await context.route("**/api/play/*", (r) => r.fulfill({ json: { play_count: 1 } }));
  await context.route("**/api/meta/*", (r) => r.fulfill({ status: 204, body: "" }));
  await context.route("**/status", (r) =>
    r.fulfill({
      json: {
        service: "t",
        version: "x",
        db_healthy: true,
        track_count: tracks.length,
        root: "/x",
        scanning: false,
        scan_total: 0,
        scan_processed: 0,
        scan_hashed: 0,
      },
    }),
  );

  await page.setViewportSize({ width: 1100, height: 700 });

  // Cold restore straight onto the deep track: +page cues it and opens the
  // player overlay on mount (no gesture needed for the cue/pattern decode).
  await page.goto(`/?t=${TARGET_HASH}`);
  await expect(page.locator(".pattern-overlay")).toBeVisible();

  // The target group defaults closed and off-screen, so its row isn't rendered
  // yet — this is what makes the post-close assertion non-vacuous.
  const row = page.locator(`button.row[title="${TARGET_PATH}"]`);
  await expect(row).toHaveCount(0);

  // Move back to the list.
  await page.keyboard.press("Escape");
  await expect(page.locator(".pattern-overlay")).toHaveCount(0);

  // The group is now expanded and the playing row is scrolled into view.
  const header = page.locator("button.head", { hasText: TARGET_GROUP });
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(row).toBeInViewport();
});
