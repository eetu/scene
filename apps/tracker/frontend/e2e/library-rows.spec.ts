// Guards the library row-height ↔ virtualizer coordination: track rows are a
// compact single line on BOTH desktop and mobile (mobile a touch taller for a
// comfortable tap target). The fixed-size virtualizer (no measureElement)
// depends on the height tracking the breakpoint, so assert both. On mobile the
// playcount is dropped and the name ellipsises, keeping title + duration on one
// row instead of wrapping to a padded second line.
import { readFileSync } from "node:fs";

import { expect, type Locator, test } from "@playwright/test";

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
  play_count: i + 1, // all > 0 so the playcount column actually renders on desktop
}));

test("track rows are one line (title + duration); playcount hidden on mobile", async ({
  context,
  page,
}) => {
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

  // Title + duration share one visual row (centres aligned), never stacked —
  // asserted by geometry, not a pixel-exact row height.
  const oneLine = async (r: Locator) => {
    const n = (await r.locator(".name").boundingBox())!;
    const d = (await r.locator(".dur").boundingBox())!;
    expect(Math.abs(n.y + n.height / 2 - (d.y + d.height / 2))).toBeLessThan(6);
  };

  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto("/");
  const row = page.locator("div.li").first();
  await row.waitFor();
  const desktopH = (await row.boundingBox())!.height;
  await oneLine(row);
  await expect(row.locator(".plays")).toBeVisible(); // playcount column on desktop

  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(300);
  const mobileH = (await row.boundingBox())!.height;
  await oneLine(row); // still one line — the name ellipsises rather than wrapping
  await expect(row.locator(".plays")).toBeHidden(); // playcount dropped on mobile
  // Grows a touch for a tap target, and the fixed-size virtualizer tracks the
  // breakpoint — asserted relatively, not against a magic pixel height.
  expect(mobileH).toBeGreaterThan(desktopH);
});
