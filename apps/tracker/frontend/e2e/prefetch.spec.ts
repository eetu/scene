// Guards Tier-1 prefetch: once the current track settles, the (deterministic)
// next track's bytes are fetched ahead of time so the switch skips the network.
import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { FIXTURE_XM } from "../../../../packages/player/testing/playback-smoke";

const BYTES = readFileSync(FIXTURE_XM);

const mk = (hash: string, filename: string) => ({
  hash,
  md5: hash,
  path: `Demo/${filename}`,
  group: "Demo",
  artist: null,
  filename,
  ext: "xm",
  size: BYTES.length,
  title: filename,
  type_long: "FastTracker II",
  tracker: "",
  duration: 42,
  channels: 4,
  instruments: 0,
  samples: 3,
  favorite: false,
  play_count: 0,
});

test("prefetches the next track's bytes after the current one settles", async ({
  context,
  page,
}) => {
  const fetched = new Set<string>();
  await context.route("**/api/tracks", (r) =>
    r.fulfill({ json: { tracks: [mk("aaa", "a-first.xm"), mk("bbb", "b-second.xm")] } }),
  );
  await context.route("**/api/playlists", (r) => r.fulfill({ json: { playlists: [] } }));
  await context.route("**/api/play/*", (r) => r.fulfill({ json: { play_count: 1 } }));
  await context.route("**/api/meta/*", (r) => r.fulfill({ status: 204, body: "" }));
  await context.route("**/status", (r) =>
    r.fulfill({
      json: {
        service: "tracker",
        version: "e2e",
        db_healthy: true,
        track_count: 2,
        root: "/x",
        scanning: false,
        scan_total: 0,
        scan_processed: 0,
        scan_hashed: 0,
      },
    }),
  );
  await context.route("**/api/file/*", (route) => {
    fetched.add(new URL(route.request().url()).pathname.split("/").pop() ?? "");
    return route.fulfill({ contentType: "application/octet-stream", body: BYTES });
  });

  await page.goto("/");
  await page.locator("button.row").first().click(); // plays one track (fetches its bytes)
  // After the debounce, the OTHER track's bytes are prefetched → both fetched.
  await expect.poll(() => fetched.size, { timeout: 5000 }).toBe(2);
  expect([...fetched].sort()).toEqual(["aaa", "bbb"]);
});
