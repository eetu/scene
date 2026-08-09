// The queue face on the real panel: mixed drums per field, and a frame to look at.
//
// A screenshot suite — see VISUAL in vitest.config.ts. Not part of `yarn test`.
import { mount, unmount } from "svelte";
import { page } from "vitest/browser";
import { afterEach, expect, test } from "vitest";

import { setBoardMode } from "../board-mode.svelte";
import { setPlayerHost } from "../host";
import { playInOrder } from "../player.svelte";
import ScrollerBoard from "../ScrollerBoard.svelte";
import { playback } from "../state.svelte";
import { startVizFeed } from "./viz-feed";

let host: HTMLDivElement | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any = null;
let feed: { stop: () => void } | null = null;

const QUEUE = [
  { hash: "a", filename: "crystal surface.xm", title: "Crystal Surface", duration: 214 },
  { hash: "b", filename: "nameme.it", title: "Nameme", duration: 412 },
  { hash: "c", filename: "sit down.it", title: "Sit Down", duration: 288 },
  { hash: "d", filename: "tight to me.it", title: "Tight to Me", duration: 601 },
  { hash: "e", filename: "clouds above.xm", title: "Clouds above", duration: 196 },
];

/** The minimum the play path needs. It never reaches the network here — the
 *  engine fails first — but `@scene/player` refuses to run without a host at
 *  all, on the grounds that a missing one is an app-wiring bug. */
function installHost() {
  setPlayerHost({
    appName: "test",
    fileUrl: (hash: string) => `/api/file/${hash}`,
    play: async () => ({ play_count: 1 }),
    putMeta: async () => {},
  });
}

afterEach(() => {
  if (app) unmount(app);
  app = null;
  feed?.stop();
  feed = null;
  host?.remove();
  host = null;
  setBoardMode("scroll");
});

test("the queue face draws the departures board", { timeout: 90000 }, async () => {
  await page.viewport(1000, 620);
  feed = startVizFeed();

  // A real queue, so the rows are the ones the transport would actually play next.
  // playInOrder starts a load; the fake feed keeps `playing` true either way, and the
  // face only reads the queue window and the position.
  //
  // The load is expected to fail — there is no audio graph here — so the rejection is
  // swallowed rather than left to surface as an unhandled one. It still needs a host,
  // because the play path asks one for the track's play length before it gets that far.
  installHost();
  void playInOrder(QUEUE, QUEUE[0]).catch(() => {});
  playback.position = 42;

  setBoardMode("departures");

  host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;width:960px;height:560px;background:#0a0b0d";
  document.body.appendChild(host);
  app = mount(ScrollerBoard, { target: host, props: { active: true } });

  await new Promise((r) => setTimeout(r, 4000));

  const canvas = host.querySelector("canvas")!;
  const label = canvas.getAttribute("aria-label") ?? "";

  await page.elementLocator(host).screenshot({ path: "viz-gallery/board-departures.png" });

  // Header, the playing marker, and at least the first two destinations.
  expect(label, "no header row").toContain("DESTINATION");
  expect(label, "no playing marker").toContain("▶");
  expect(label, "first destination missing").toContain("CRYSTAL SURFACE");
  expect(label, "second destination missing").toContain("NAMEME");
  // The elapsed field, on the digit drum. Matched as a shape rather than a value: the
  // feed drives playback.position itself, so pinning a number here would be testing the
  // fixture's clock rather than the board's.
  expect(label, "no mm:ss elapsed field").toMatch(/\d\d:\d\d/);
  // The queued rows show their own durations, which the feed does not touch — 412s and
  // 288s. This is the assertion that proves row 0 ticks and the rest don't.
  expect(label, "queued duration missing (Nameme, 6:52)").toContain("06:52");
  expect(label, "queued duration missing (Sit Down, 4:48)").toContain("04:48");

  // Switching back re-configures rather than leaving digit drums under letters.
  setBoardMode("scroll");
  await new Promise((r) => setTimeout(r, 2500));
  expect(canvas.getAttribute("aria-label"), "face did not switch back").not.toContain(
    "DESTINATION",
  );
});
