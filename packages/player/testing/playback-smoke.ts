// Shared Playwright playback smoke test — the reusable half that lives with the
// component both apps embed (@scene/player: the chiptune3 worklet + transport).
//
// Why this exists: the libopenmpt WASM worklet only fails in a *real browser*
// (WebAudio + TextDecoder + WASM memory), invisible to node/unit tests. The
// emsdk-6 bump shipped a worklet that hung the tracker at "decoding pattern…"
// with a resizable-ArrayBuffer TextDecoder error; a node gate passed it. This
// spec reproduces that class as a red test: load a module, play it, and assert
// the transport clock actually advances with no error banner.
//
// Each app writes a ~5-line spec that stubs the library, drives its own
// "open a track" UI, then calls expectPlaybackAdvances(). App-specific bits
// (how to click play) stay in the app; the mocking + assertion are shared here.
import { expect, type Page, type BrowserContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
/** A tiny real FastTracker II module (OpenMPT's own test.xm) — 3 samples. */
export const FIXTURE_XM = resolve(here, "fixtures/test.xm");
const FIXTURE_BYTES = readFileSync(FIXTURE_XM);

/** Minimal shape of a library track — matches the backend JSON the SPA reads
 *  (hand-written, like the app's own api.ts; no cross-app type import). */
function fixtureTrack(hash: string) {
  return {
    hash,
    md5: hash,
    path: "Test/test.xm",
    group: "Test",
    artist: null,
    filename: "test.xm",
    ext: "xm",
    size: FIXTURE_BYTES.length,
    title: "Test Module",
    type_long: "FastTracker II",
    tracker: "",
    duration: 42,
    channels: 4,
    instruments: 0,
    samples: 3,
    favorite: false,
    play_count: 0,
  };
}

/** Serve the fixture module bytes for any `/api/file/{hash}` — the request that
 *  used to trip the resizable-buffer bug. Both apps fetch modules from this same
 *  path, so this is the genuinely shared mock; each app stubs its own listing +
 *  navigation API on top. */
export async function mockModuleFile(context: BrowserContext) {
  await context.route("**/api/file/*", (route) =>
    route.fulfill({ contentType: "application/octet-stream", body: FIXTURE_BYTES }),
  );
}

export type MockLibraryOptions = {
  /** Content hash the SPA uses in fileUrl(hash). */
  hash?: string;
};

/** Stub the backend JSON API so the SPA lists + fetches one module fully
 *  offline. Registered on the BrowserContext so requests from the page (the
 *  module fetch is main-thread in chiptune3.js) are all intercepted.
 *  Returns the single track the UI will show. */
export async function mockLibrary(context: BrowserContext, opts: MockLibraryOptions = {}) {
  const hash = opts.hash ?? "testhash";
  const track = fixtureTrack(hash);

  await context.route("**/api/tracks", (route) => route.fulfill({ json: { tracks: [track] } }));
  await context.route("**/api/playlists", (route) => route.fulfill({ json: { playlists: [] } }));
  await mockModuleFile(context);
  await context.route("**/api/play/*", (route) => route.fulfill({ json: { play_count: 1 } }));
  await context.route("**/api/meta/*", (route) => route.fulfill({ status: 204, body: "" }));
  await context.route("**/status", (route) =>
    route.fulfill({
      json: {
        service: "test",
        version: "e2e",
        db_healthy: true,
        track_count: 1,
        root: "/fixtures",
        scanning: false,
        scan_total: 0,
        scan_processed: 0,
        scan_hashed: 0,
      },
    }),
  );
  return track;
}

/** The core assertion: once a module is loaded + playing, the shared Transport's
 *  clock must climb past 0:00 (proves decode → render → WebAudio actually runs)
 *  and the "Couldn't play this module" banner must never appear. */
export async function expectPlaybackAdvances(page: Page) {
  const errorBanner = page.getByText(/Couldn't play this module/);
  const time = page.getByTestId("transport-time");

  await expect(time, "transport should be visible once a track is opened").toBeVisible();
  await expect(errorBanner, "no playback error banner").toHaveCount(0);

  // Elapsed portion of "M:SS / M:SS" must advance past 0:00 within a few seconds.
  await expect(async () => {
    const txt = (await time.textContent()) ?? "";
    const elapsed = txt.split("/")[0].trim();
    expect(elapsed, `transport time was "${txt}"`).not.toBe("0:00");
  }).toPass({ timeout: 8000, intervals: [200, 400, 800] });

  // Still no error after it has been playing (catches decode-then-throw).
  await expect(errorBanner, "no playback error after playing").toHaveCount(0);
}
