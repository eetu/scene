// Guards the library row-height ↔ virtualizer coordination: track rows are a
// compact single line on desktop and two lines on mobile (so long module names
// aren't ellipsised). The height must track the breakpoint or the virtualizer
// (fixed-size, no measureElement) would clip/desync.
import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { FIXTURE_XM } from "../../../../packages/player/testing/playback-smoke";

const B = readFileSync(FIXTURE_XM);
const tracks = Array.from({ length: 6 }, (_, i) => ({
  hash: `t${i}`,
  md5: `t${i}`,
  path: `Demo/Long Module Title Number ${i} That Overflows.xm`,
  group: "Demo",
  artist: null,
  filename: `Long Module Title Number ${i} That Overflows.xm`,
  ext: "xm",
  size: B.length,
  title: `Long Module Title Number ${i} That Overflows`,
  type_long: "FastTracker II",
  tracker: "",
  duration: 120,
  channels: 8,
  instruments: 0,
  samples: 3,
  favorite: false,
  play_count: i,
}));

test("track rows: single-line on desktop, two-line on mobile", async ({ context, page }) => {
  await context.route("**/api/tracks", (r) => r.fulfill({ json: { tracks } }));
  await context.route("**/api/playlists", (r) => r.fulfill({ json: { playlists: [] } }));
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

  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto("/");
  const row = page.locator("div.li").first();
  await row.waitFor();
  expect((await row.boundingBox())!.height).toBeLessThan(40); // single line

  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(300);
  expect((await row.boundingBox())!.height).toBeGreaterThan(44); // wrapped to two lines
});
