import { test } from "@playwright/test";

// Shared, worklet-level assertion + the /api/file mock live with @scene/player
// (same guard the tracker uses; both apps embed the same worklet).
import {
  expectPlaybackAdvances,
  mockModuleFile,
} from "../../../../packages/player/testing/playback-smoke";

// End-to-end playback guard for party: real built SPA + real vendored WASM
// worklet in a real browser, backend mocked. Party reaches playback through a
// different UI than the tracker (party → compo → music entry), but the engine
// and the assertion are identical — this is the shared-spec reuse in action.
const SLUG = "test-party";

// One music competition entry the catalog will show, wired to the fixture bytes.
const musicProd = {
  id: "p1",
  category: "Music",
  compo: "Music",
  platform: "amiga",
  medium: "music",
  rank: 1,
  group: "Testers",
  title: "Test Song",
  points: 100,
  primary_hash: "testhash",
  primary_kind: "music",
  primary_filename: "test.xm",
  n_files: 1,
  order: 0,
};

test("plays a music production: decodes and the transport clock advances", async ({
  context,
  page,
}) => {
  await mockModuleFile(context);
  await context.route("**/status", (route) =>
    route.fulfill({
      json: {
        service: "party",
        version: "e2e",
        db_healthy: true,
        file_count: 1,
        production_count: 1,
        party_count: 1,
        root: null,
        kiosk: false,
        scanning: false,
        scan_total: 0,
        scan_processed: 0,
        scan_hashed: 0,
      },
    }),
  );
  await context.route("**/api/parties", (route) => route.fulfill({ json: { parties: [] } }));
  await context.route("**/api/parties/*/productions", (route) =>
    route.fulfill({
      json: {
        productions: [musicProd],
        kickstart_url: null,
        kickstart_a500_url: null,
        kickstart_a4000_url: null,
      },
    }),
  );
  await context.route("**/api/production/*", (route) =>
    route.fulfill({
      json: {
        production: { ...musicProd, party_slug: SLUG, primary_rel: "test.xm" },
        files: [
          {
            hash: "testhash",
            rel_path: "test.xm",
            filename: "test.xm",
            ext: "xm",
            kind: "music",
            mime: "audio/x-mod",
            size: 6279,
          },
        ],
        meta: null,
      },
    }),
  );
  await context.route("**/api/meta/*", (route) => route.fulfill({ status: 204, body: "" }));

  await page.goto(`/${SLUG}`);

  // Party-specific step: the compo cards start collapsed — expand the music
  // compo, then click the entry → playInOrder() loads + plays it.
  await page.locator("button.cathead").first().click();
  await page.getByRole("button", { name: /Test Song/ }).click();

  await expectPlaybackAdvances(page);
});
