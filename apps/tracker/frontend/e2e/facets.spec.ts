// Guards the library controls (group-by / facet filters) before they move into a
// FacetBar component + view store — nothing else exercises the dropdowns.
import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { FIXTURE_XM } from "../../../../packages/player/testing/playback-smoke";

const BYTES = readFileSync(FIXTURE_XM);

function track(hash: string, group: string, ext: string) {
  return {
    hash,
    md5: hash,
    path: `${group}/${hash}.${ext}`,
    group,
    artist: null,
    filename: `${hash}.${ext}`,
    ext,
    size: BYTES.length,
    title: null,
    type_long: "Module",
    tracker: "PT",
    duration: 10,
    channels: 4,
    instruments: 0,
    samples: 0,
    favorite: false,
    play_count: 0,
  };
}

const tracks = [track("a", "Alpha", "mod"), track("b", "Beta", "mod"), track("c", "Gamma", "xm")];

async function mock(context: import("@playwright/test").BrowserContext) {
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
}

test("group-by control re-buckets the list", async ({ context, page }) => {
  await mock(context);
  await page.goto("/");
  await expect(page.locator(".grp-name")).toHaveText(["Alpha", "Beta", "Gamma"]);

  await page.getByLabel("group by").selectOption("ext");
  await expect(page.locator(".grp-name")).toHaveText(["MOD", "XM"]);
});

test("format facet filters the list", async ({ context, page }) => {
  await mock(context);
  await page.goto("/");
  // The format facet is the select offering the module formats (has an "XM" option).
  const fmt = page.locator("select").filter({ has: page.getByRole("option", { name: "XM" }) });
  await fmt.selectOption("XM");
  await expect(page.locator(".grp-name")).toHaveText(["Gamma"]); // only the XM group
});
