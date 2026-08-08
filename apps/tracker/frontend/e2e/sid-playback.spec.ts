// SID playback in a real browser — the proof that the second engine works.
//
// Everything below the surface differs from the module path: libsidplayfp
// instead of libopenmpt, a bundled TypeScript worker instead of a vendored
// static one, C64 ROMs fetched at runtime. What must NOT differ is the audio
// coming out, so this asserts the same thing the module smoke test does — the
// transport clock advances with no error banner — through the shared pipeline.
//
// The tune is a 158-byte synthetic PSID (see FIXTURE_SID): a sustained sawtooth,
// legally clean, and verified to render non-silent audio.
import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import {
  expectPlaybackAdvances,
  FIXTURE_SID,
} from "../../../../packages/player/testing/playback-smoke";
import type { Track } from "../src/lib/api";
import { mockLibrary } from "./mock-api";

const SID_BYTES = readFileSync(FIXTURE_SID);

/** Two subtunes of one file, exactly as the backend shapes them. */
const tracks = [0, 1].map((subsong) => ({
  id: 256 + subsong, // library::track_id(1, subsong)
  subsong,
  subsongs: 2,
  hash: "sidhash",
  md5: "sidhash",
  path: "scene/test-tone.sid",
  collection: "mods",
  group: "scene",
  artist: "scene",
  filename: "test-tone.sid",
  ext: "sid",
  size: SID_BYTES.length,
  title: "Test Tone",
  type_long: "PSID v2",
  tracker: "PAL MOS6581",
  duration: null, // a SID carries no length — the host supplies the window
  channels: 3,
  instruments: 0,
  samples: 0,
  favorite: false,
  play_count: 0,
})) as unknown as Track[];

/** Correctly-sized stand-ins for the three C64 ROMs.
 *
 *  The real images are operator-supplied and gitignored — they're copyrighted,
 *  and deliberately never in the repo — so a committed test cannot read them.
 *
 *  What these specs need from the ROMs is the *transport* — that the app fetches
 *  three of them and hands them to the decoder — not their contents. A PSID
 *  never executes KERNAL code (libsidplayfp calls its init and play routines
 *  directly), so stand-ins exercise that path without changing what comes out of
 *  the speaker. Filled with `RTS` rather than zeroes so that if anything ever
 *  does jump in, it returns instead of running whatever `brk` would do.
 *
 *  The genuinely ROM-less case has its own test below. */
const ROM_BYTES: Record<string, number> = { kernal: 8192, basic: 8192, chargen: 4096 };
const RTS = 0x60;

async function mock(context: import("@playwright/test").BrowserContext, opts = { roms: true }) {
  await mockLibrary(context, tracks);
  await context.route("**/api/playlists", (r) => r.fulfill({ json: { playlists: [] } }));
  await context.route("**/api/file/*", (r) =>
    r.fulfill({ contentType: "application/octet-stream", body: SID_BYTES }),
  );
  await context.route("**/api/play/*", (r) => r.fulfill({ json: { play_count: 1 } }));
  await context.route("**/api/meta/*", (r) => r.fulfill({ status: 204, body: "" }));
  // The ROMs are operator-supplied; 404 is a supported state (built-in images).
  await context.route("**/api/roms/*", (r) => {
    if (!opts.roms) return r.fulfill({ status: 404, body: "" });
    const which = new URL(r.request().url()).pathname.split("/").pop() ?? "";
    return r.fulfill({
      contentType: "application/octet-stream",
      body: Buffer.alloc(ROM_BYTES[which] ?? 8192, RTS),
    });
  });
}

test("plays a SID: libsidplayfp decodes and the transport clock advances", async ({
  context,
  page,
}) => {
  await mock(context);
  await page.goto("/");
  await page.locator("button.row").first().click();
  await expectPlaybackAdvances(page);
});

test("a SID has no pattern grid, so the player offers voices instead", async ({
  context,
  page,
}) => {
  await mock(context);
  await page.goto("/");
  await page.locator("button.row").first().click();
  await expect(page.getByTestId("transport-time")).toBeVisible();
  // The engine reports hasPatterns=false; the pattern tab must not claim to be
  // decoding a grid that does not exist in this format.
  await expect(page.getByText("decoding pattern…")).toHaveCount(0);
});

test("each subtune is its own row and plays on its own", async ({ context, page }) => {
  await mock(context);
  await page.goto("/");
  // Two entries for one file, distinguished by the tune label.
  const rows = page.locator("button.row");
  await expect(rows).toHaveCount(2);
  await expect(page.getByText("Tune 1/2")).toBeVisible();
  await expect(page.getByText("Tune 2/2")).toBeVisible();

  await rows.nth(1).click();
  await expectPlaybackAdvances(page);
});

test("a deep-linked SID cues without handing its bytes to libopenmpt", async ({
  context,
  page,
}) => {
  // The cold-restore path (?t=) decodes a module's pattern before any gesture,
  // so the grid is ready when you press play. A SID has no pattern to decode,
  // and cueing one must not build the *module* engine — libopenmpt rejects SID
  // bytes inside the WASM and strands the transport.
  // Asserted on the *network*, not the console: the failure happens inside a
  // Worker, and worker console output isn't part of the page's console events.
  // Which decoder got built is directly observable instead.
  const fetched: string[] = [];
  page.on("request", (r) => fetched.push(r.url()));

  await mock(context);
  await page.goto("/?t=sidhash");

  // Cued and ready, not stuck.
  await expect(page.getByTestId("transport-time")).toBeVisible();
  await expect(page.getByText(/Couldn't play this module/)).toHaveCount(0);

  // Only the libopenmpt-specific files count. `chiptune3.worklet.js` is the
  // shared PCM drainer both engines use, and WebKit fetches it eagerly where
  // Chromium defers it — matching on it would fail on browser timing rather
  // than on the thing under test.
  expect(
    fetched.filter((u) => /decoder\.worker|libopenmpt/i.test(u)),
    "cueing a SID must not build the libopenmpt decoder",
  ).toEqual([]);
});

test("a SID gets both a trace grid and a voice monitor, landing on the grid", async ({
  context,
  page,
}) => {
  await mock(context);
  await page.goto("/");
  await page.locator("button.row").first().click();
  await expectPlaybackAdvances(page);

  // `pattern` for a SID is the reconstructed trace — one row per raster frame —
  // so a SID lands where a module lands, on the format's equivalent of a score,
  // in the same frame: centerline, whole-column paging, VU off the line.
  await expect(page.locator(".tg")).toBeVisible({ timeout: 8000 });
  // Rows arrive as the tune plays; the grid fills rather than staying idle.
  await expect(page.locator(".trow.now").first()).toBeVisible({ timeout: 8000 });
  await expect(page.locator(".centerline")).toBeVisible();
  // And no claim to be decoding a grid this format doesn't have.
  await expect(page.getByText("decoding pattern…")).toHaveCount(0);

  const vm = page.locator("[aria-label='SID voice monitor']");
  await expect(vm).toHaveCount(0);
  await page.getByRole("button", { name: "voices", exact: true }).click();
  await expect(vm).toBeVisible();
  // Three voices for a single-chip tune.
  await expect(vm.locator(".voice")).toHaveCount(3);

  // The fixture gates voice 1 with a sawtooth, so that voice must read as
  // sounding — proving the registers are real chip state and not zeroes.
  const v1 = vm.locator(".voice").first();
  await expect(v1).toHaveClass(/\bon\b/);
  await expect(v1.locator(".w.lit")).toHaveCount(1); // saw only
  await expect(v1.locator(".note")).not.toHaveText("—");

  // Voices 2 and 3 are untouched by the fixture: present, but not sounding.
  await expect(vm.locator(".voice.on")).toHaveCount(1);
});

test("plays without ROMs too — degraded, not broken", async ({ context, page }) => {
  // Most tunes survive on libsidplayfp's built-in images; only a BASIC-driven
  // RSID genuinely needs the real ones. A missing ROM route must not be fatal.
  await mock(context, { roms: false });
  await page.goto("/");
  await page.locator("button.row").first().click();
  await expectPlaybackAdvances(page);
});
