// Guards the playlist item row: one visual line on BOTH breakpoints (mobile a
// touch taller for the tap target), the same shape as a library row — title +
// trailing muted group·artist, then the duration, then reorder/remove. Pinned
// by geometry, not by a magic row height.
import { readFileSync } from "node:fs";

import { expect, type Locator, test } from "@playwright/test";

import { FIXTURE_XM } from "../../../../packages/player/testing/playback-smoke";
import type { Track } from "../src/lib/api";
import { mockLibrary } from "./mock-api";

const B = readFileSync(FIXTURE_XM);

const playlist = {
  id: "pl1",
  name: "Long Player",
  kind: "user",
  source_ref: null,
  item_count: 3,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

// Titles long enough to need the ellipsis at 390px, so the name can't quietly
// push the duration onto its own line.
function item(id: number, present: boolean) {
  return {
    id,
    position: id,
    md5: `m${id}`,
    present,
    hash: present ? `h${id}` : null,
    path: present ? `Artist/Long Module Title Number ${id} That Overflows.xm` : null,
    group: "Some Group",
    artist: "Some Artist",
    filename: `Long Module Title Number ${id} That Overflows.xm`,
    ext: "xm",
    size: B.length,
    title: `Long Module Title Number ${id} That Overflows`,
    type_long: "FastTracker II",
    tracker: "",
    duration: 125,
    channels: 8,
    instruments: 0,
    samples: 3,
    favorite: false,
    play_count: 0,
  };
}

const items = [item(1, true), item(2, true), item(3, false)];

test("playlist item rows are one line (title + duration) at both breakpoints", async ({
  context,
  page,
}) => {
  await mockLibrary(context, [] as unknown as Track[]);
  await context.route("**/api/playlists", (r) => r.fulfill({ json: { playlists: [playlist] } }));
  // Registered after the list route so it wins for the detail URL.
  await context.route("**/api/playlists/pl1", (r) => r.fulfill({ json: { playlist, items } }));

  // The name and the duration share one visual row (centres aligned) — the
  // property that broke when the metadata wrapped underneath.
  const oneLine = async (r: Locator) => {
    const n = (await r.locator(".nm").boundingBox())!;
    const d = (await r.locator(".dur").boundingBox())!;
    expect(Math.abs(n.y + n.height / 2 - (d.y + d.height / 2))).toBeLessThan(6);
    expect(n.x + n.width).toBeLessThanOrEqual(d.x + 1); // side by side, not stacked
  };

  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "playlists", exact: true }).click();
  await page.getByRole("button", { name: /Long Player/ }).click();

  const rows = page.locator("ol.items li");
  await expect(rows).toHaveCount(items.length);
  const row = rows.first();
  const missing = rows.last();
  const desktopH = (await row.boundingBox())!.height;
  await oneLine(row);
  await oneLine(missing); // the "(missing)" variant is the same single-line row
  await expect(row.getByTitle("remove")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(200);
  await oneLine(row); // still one line — the name ellipsises rather than wrapping
  await oneLine(missing);
  // Reorder/remove have no other home (unlike the library's fav/rename), so they
  // stay on the narrow row — touch-sized, which makes the row a touch taller.
  await expect(row.getByTitle("up")).toBeVisible();
  await expect(row.getByTitle("down")).toBeVisible();
  await expect(row.getByTitle("remove")).toBeVisible();
  expect((await row.boundingBox())!.height).toBeGreaterThan(desktopH);
});
