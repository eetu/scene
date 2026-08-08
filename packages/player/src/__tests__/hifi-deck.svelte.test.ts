// The hi-fi under a synthetic feed: every display face, the reels turning, and the eject
// cycle a track change triggers. Frames land in src/__tests__/viz-gallery/hifi-*.png.
//
// A screenshot suite — see VISUAL in vitest.config.ts. Not part of `yarn test`.
import { page } from "vitest/browser";
import { mount, tick, unmount } from "svelte";
import { expect, test, vi } from "vitest";

import HiFiDeck from "../HiFiDeck.svelte";
import { chassisMode, layoutHifi, layoutWalkman, type Rect } from "../hifi-chassis";
import { BODY_ASPECT } from "../hifi-walkman";
import { setVolume } from "../player.svelte";
import { playback } from "../state.svelte";
import { setGrilles, VFD_FACES, vfdView } from "../vfd-mode.svelte";
import { captureViz, fill, grab, motion } from "./viz-shots";
import { installTheme, startVizFeed } from "./viz-feed";

const OUT = "viz-gallery";

// The transport functions all bail early without a live engine (`if (!player) return`), and
// there is no audio graph in a headless browser without a user gesture. So the transport is
// spied rather than exercised: what this file can honestly check is that the drawn key row
// is WIRED to the right call, which is where a typo in the switch would hide. That the
// calls themselves work is the player's own business, and tested there.
const wired = vi.hoisted(() => ({
  playNext: vi.fn(),
  playPrev: vi.fn(),
  stop: vi.fn(),
  togglePause: vi.fn(),
  transportToggle: vi.fn(),
}));

vi.mock("../player.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../player.svelte")>()),
  ...wired,
}));

test("each display face draws and moves", { timeout: 300000 }, async () => {
  await page.viewport(960, 560);
  installTheme("dark");

  for (const face of VFD_FACES) {
    vfdView.face = face.id;
    const shot = await captureViz(HiFiDeck, {
      id: `hifi-${face.id}`,
      outDir: OUT,
      // Long enough for the panel's power-on self-test to finish; it lights every anode
      // for about a second, and a frame caught during it says nothing about the face.
      settleMs: 2600,
    });
    // The stack fills most of the pane, so this floor is well above "drew a dark
    // rectangle" and well below anything the scene legitimately does.
    expect.soft(shot.fill, `${face.id}: nothing on screen`).toBeGreaterThan(8);
    // Something is always moving — the reels if nothing else.
    expect.soft(shot.motion, `${face.id}: frozen`).toBeGreaterThan(0.05);
  }
});

/** Mean absolute luma change per pixel inside `box`, which is in CSS pixels of the pane.
 *
 *  Restricting it matters: across the whole pane the analyser's motion is an order of
 *  magnitude larger than the reels', so a whole-frame measurement passes just as happily
 *  with the deck frozen — which is precisely the failure it is supposed to catch. The box
 *  comes from the component's own layout function rather than from eyeballed fractions, so
 *  it follows the design instead of going stale against it. */
function motionIn(a: ImageData, b: ImageData, pane: [number, number], box: Rect): number {
  const x0 = Math.max(0, Math.floor((box.x / pane[0]) * a.width));
  const x1 = Math.min(a.width, Math.ceil(((box.x + box.w) / pane[0]) * a.width));
  const y0 = Math.max(0, Math.floor((box.y / pane[1]) * a.height));
  const y1 = Math.min(a.height, Math.ceil(((box.y + box.h) / pane[1]) * a.height));
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * a.width + x) * 4;
      const la = 0.299 * a.data[i] + 0.587 * a.data[i + 1] + 0.114 * a.data[i + 2];
      const lb = 0.299 * b.data[i] + 0.587 * b.data[i + 1] + 0.114 * b.data[i + 2];
      sum += Math.abs(la - lb);
      n++;
    }
  }
  return n ? (sum / n / 255) * 100 : 0;
}

function reelMotion(frames: ImageData[], pane: [number, number]): number {
  const { cass } = layoutHifi(pane[0], pane[1]);
  const diffs: number[] = [];
  for (let i = 1; i < frames.length; i++)
    diffs.push(motionIn(frames[i - 1], frames[i], pane, cass));
  return diffs.reduce((a, b) => a + b, 0) / diffs.length;
}

test("the reels turn, and stop when the music does", { timeout: 120000 }, async () => {
  const PANE: [number, number] = [960, 560];
  await page.viewport(...PANE);
  installTheme("dark");
  vfdView.face = "spectrum";

  const playing = await captureViz(HiFiDeck, {
    id: "hifi-reels",
    outDir: OUT,
    settleMs: 2600,
    count: 6,
    onReady: async () => {
      // Park the tape mid-side: both packs are a good size there, which is where a hub's
      // rotation is easiest to see and hardest to fake.
      playback.duration = 200;
      playback.position = 90;
      await new Promise((r) => setTimeout(r, 400));
    },
  });
  const turning = reelMotion(playing.frames, PANE);
  expect(turning, "the reels are not turning").toBeGreaterThan(0.25);

  // Now stop the transport. The reels have inertia so they coast, and the frame driver
  // paints a settle window before it freezes — this is measured well after both.
  const stopped = await captureViz(HiFiDeck, {
    id: "hifi-stopped",
    outDir: OUT,
    settleMs: 2600,
    count: 4,
    props: { active: false },
    onReady: async () => {
      playback.playing = false;
      playback.paused = false;
      await new Promise((r) => setTimeout(r, 2500));
    },
  });
  const still = reelMotion(stopped.frames, PANE);
  expect(still, `the reels keep spinning after stop (${still} vs ${turning} playing)`).toBeLessThan(
    turning * 0.25,
  );
});

test("the grille covers come off, in both finishes", { timeout: 180000 }, async () => {
  // Clipping the covers on and pulling them off is the one thing you do by touching the
  // hardware itself rather than a control, and it is the only state this visualiser keeps
  // that isn't about the music. Both finishes, because the cabinets behind the cloth are
  // where the drivers are — and the drivers' own shading is deliberately NOT themed (see
  // DRIVER in hifi-chassis.ts), so the light theme is where that would show up broken.
  const PANE: [number, number] = [960, 560];
  await page.viewport(...PANE);
  vfdView.face = "spectrum";

  // The left cabinet's woofer, in the coordinates the layout puts it at — the region that
  // must actually change when the cloth comes off.
  const l = layoutHifi(...PANE);
  const cab = l.speakers![0];
  const box = { x: cab.x, y: cab.y + cab.h * 0.35, w: cab.w, h: cab.h * 0.3 };

  for (const theme of ["dark", "light"] as const) {
    installTheme(theme);
    setGrilles(true);
    const on = await captureViz(HiFiDeck, {
      id: `hifi-grilles-${theme}`,
      outDir: OUT,
      settleMs: 2200,
      count: 1,
    });
    setGrilles(false);
    const off = await captureViz(HiFiDeck, {
      id: `hifi-bare-${theme}`,
      outDir: OUT,
      settleMs: 2200,
      count: 1,
    });

    const diff = motionIn(on.frames[0], off.frames[0], PANE, box);
    expect(diff, `${theme}: taking the covers off changed nothing over the woofer`).toBeGreaterThan(
      1.5,
    );
  }

  // The cloth is not opaque, so a covered cabinet is still a cabinet with something in it
  // rather than a flat panel — that faint ghost is the argument for drawing the woofer
  // under it at all.
  setGrilles(true);
  installTheme("dark");
});

test(
  "the light theme is the silver-faced era, not a washed-out copy",
  { timeout: 120000 },
  async () => {
    // Both finishes are real hardware: charcoal with a champagne stripe is the late golden
    // age, brushed silver with the same stripe is what the decade started in. So the light
    // theme has to be genuinely LIGHT — a dark chassis on a pale page is the failure mode
    // here, unlike the flip-dot board and the scroller, where a dark object is correct.
    await page.viewport(960, 560);
    vfdView.face = "spectrum";

    installTheme("dark");
    const dark = await captureViz(HiFiDeck, {
      id: "hifi-dark",
      outDir: OUT,
      settleMs: 2600,
      count: 2,
    });

    installTheme("light");
    const light = await captureViz(HiFiDeck, {
      id: "hifi-light",
      outDir: OUT,
      settleMs: 2600,
      count: 2,
    });

    const luma = (f: ImageData) => {
      let s = 0;
      for (let i = 0; i < f.data.length; i += 4) {
        s += 0.299 * f.data[i] + 0.587 * f.data[i + 1] + 0.114 * f.data[i + 2];
      }
      return s / (f.data.length / 4);
    };
    const dl = luma(dark.frames[0]);
    const ll = luma(light.frames[0]);
    expect(
      ll,
      `the light finish is not light (dark ${dl.toFixed(0)}, light ${ll.toFixed(0)})`,
    ).toBeGreaterThan(dl * 2.5);
    // …and the display is still a lit tube in a dark hole, whatever the room. A VFD that went
    // pale with the furniture would stop being a VFD.
    expect(light.contrast, "the light chassis lost its display").toBeGreaterThan(30);

    installTheme("dark");
  },
);

test("a portrait pane gets the personal stereo instead", { timeout: 120000 }, async () => {
  // A separates stack is a wide object. Drawn honestly in a tall frame it leaves most of the
  // frame empty with the cassette small in the middle of it — so a portrait pane gets the
  // machine that IS this shape, with the same cassette stood on its short edge.
  const PANE: [number, number] = [420, 720];
  await page.viewport(...PANE);
  installTheme("dark");
  vfdView.face = "spectrum";

  expect(chassisMode(...PANE), "a portrait pane did not get the walkman").toBe("walkman");
  expect(chassisMode(960, 560), "a landscape pane lost the stack").toBe("stack");

  const l = layoutWalkman(...PANE);
  // The body keeps its proportions rather than filling the pane — a personal stereo
  // stretched to a pane is a slab, not an object.
  expect(l.body.w / l.body.h).toBeCloseTo(BODY_ASPECT, 2);
  // The cassette has to fill the lid in BOTH directions: a lid the tape only part-fills
  // leaves it floating between bands of dark — the thing this layout exists to avoid.
  expect(l.cass.w / l.well.h, "the cassette does not fill the lid lengthways").toBeGreaterThan(
    0.88,
  );
  expect(l.cass.h / l.well.w, "the cassette does not fill the lid across").toBeGreaterThan(0.88);
  expect(l.cass.w / l.cass.h).toBeCloseTo(100.5 / 63.8, 2);
  // And it has to be worth looking at: turned, it should be most of the body's width and
  // most of its height. The door is where the tape is.
  expect(l.cass.h / l.body.w, "the cassette came out narrow").toBeGreaterThan(0.6);
  expect(l.cass.w / l.body.h, "the door does not dominate the face").toBeGreaterThan(0.68);

  // The transport was a rocker on the machine's EDGE, so the front carries no key row.
  // What is left is the plate itself (pressing it changes what it shows), HOLD, and the lid
  // latch — three real switches doing three real jobs.
  const ids = l.buttons.map((b) => b.id).sort();
  expect(ids, `the walkman's face carries ${ids.join(",")}`).toEqual(["display", "eject", "hold"]);
  // The display's button IS the glass, so pressing the plate and reaching it from a keyboard
  // are the same control rather than two.
  const display = l.buttons.find((b) => b.id === "display")!.rect;
  expect(display).toEqual(l.glass);

  // HOLD sits evenly in the band above the door. Measured against the door's RECESS, not its
  // opening: centring on the opening ignores the chamfer around it and leaves the switch one
  // lip closer to the door than to the top of the machine — small enough to look like drift
  // rather than a margin, and too small to be sure of by eye, which is why it is arithmetic.
  const lip = Math.max(2, l.well.w * 0.02);
  const holdAbove = l.hold.y - l.face.y;
  const holdBelow = l.well.y - lip - (l.hold.y + l.hold.h);
  expect(
    Math.abs(holdAbove - holdBelow),
    `HOLD sits ${holdAbove.toFixed(1)} above, ${holdBelow.toFixed(1)} below`,
  ).toBeLessThan(0.75);

  // The display is wider than the door, centred on the face, and sits level in the band
  // below the door.
  //
  // Its vertical margins are LARGER than its side ones and that is correct: the glass is
  // locked to the plate's 5.2:1, so once the width is set the height is not free — the
  // leftover has to go somewhere, and splitting it evenly above and below is what keeps the
  // strip from looking dropped. Only the two gaps it does control have to match.
  const left = l.glass.x - lip - l.face.x;
  const right = l.face.x + l.face.w - (l.glass.x + l.glass.w + lip);
  const above = l.glass.y - lip - (l.well.y + l.well.h + lip);
  const under = l.face.y + l.face.h - (l.glass.y + l.glass.h + lip);
  expect(Math.abs(left - right), "the display is not centred on the face").toBeLessThan(0.75);
  expect(Math.abs(above - under), "the display sits off-centre in its band").toBeLessThan(0.75);
  expect(l.glass.w, "the display is no wider than the door").toBeGreaterThan(l.well.w);

  for (const b of [l.body, l.well, l.glass, l.sideKeys, l.hold, ...l.buttons.map((x) => x.rect)]) {
    expect(b.x).toBeGreaterThanOrEqual(-0.5);
    expect(b.y).toBeGreaterThanOrEqual(-0.5);
    expect(b.x + b.w).toBeLessThanOrEqual(PANE[0] + 0.5);
    expect(b.y + b.h).toBeLessThanOrEqual(PANE[1] + 0.5);
  }

  const shot = await captureViz(HiFiDeck, {
    id: "hifi-walkman",
    outDir: OUT,
    settleMs: 2600,
    count: 4,
  });
  expect.soft(shot.fill, "the walkman drew almost nothing").toBeGreaterThan(15);
  // Measured over the LID, not the whole pane. A portrait pane is mostly dark room, and the
  // only two things moving on this machine are the reels and a display strip a twentieth of
  // its height — so a whole-frame number is small enough to sit near any threshold you pick,
  // which makes it a measure of the threshold rather than of the machine.
  const wellMotion = (() => {
    const diffs: number[] = [];
    for (let i = 1; i < shot.frames.length; i++) {
      diffs.push(motionIn(shot.frames[i - 1], shot.frames[i], PANE, l.well));
    }
    return diffs.reduce((a, b) => a + b, 0) / diffs.length;
  })();
  expect.soft(wellMotion, "the walkman's reels are frozen").toBeGreaterThan(0.2);

  // The lid opening. The whole top plate swings up and over to the LEFT on two hinges, which
  // is how you get a tape into one of these — so the bay is uncovered from the right, and at
  // the top of the travel the tape is out and the mechanism underneath is showing.
  const eject = await captureViz(HiFiDeck, {
    id: "hifi-walkman-eject",
    outDir: OUT,
    settleMs: 2600,
    count: 8,
    onReady: async () => {
      playback.current = {
        hash: "0badcafe12345678",
        filename: "next.mod",
        title: "Next Tape",
        artist: "Someone",
        duration: 180,
      };
      await new Promise((r) => setTimeout(r, 260));
    },
  });
  const peak = Math.max(
    ...eject.frames.slice(1).map((f, i) => motionIn(eject.frames[i], f, PANE, l.well)),
  );
  expect(peak, "the walkman's lid did not visibly open").toBeGreaterThan(1.5);

  // In silver too. Worth capturing separately: this painter was written before the palette
  // existed and then converted in bulk, which is exactly how one hardcoded charcoal survives
  // into a light chassis and nobody notices.
  installTheme("light");
  const light = await captureViz(HiFiDeck, {
    id: "hifi-walkman-light",
    outDir: OUT,
    settleMs: 2600,
    count: 2,
  });
  const luma = (f: ImageData) => {
    let s = 0;
    for (let i = 0; i < f.data.length; i += 4) {
      s += 0.299 * f.data[i] + 0.587 * f.data[i + 1] + 0.114 * f.data[i + 2];
    }
    return s / (f.data.length / 4);
  };
  expect(luma(light.frames[0]), "the silver walkman came out dark").toBeGreaterThan(
    luma(shot.frames[0]) * 2.5,
  );
  installTheme("dark");
});

test(
  "the stack fills a narrow landscape pane once the speakers drop out",
  { timeout: 120000 },
  async () => {
    // Landscape, but below ~1.5:1 there is no width to stand a cabinet either side that
    // still reads as a cabinet, so the stack takes the whole pane — and must not keep its
    // wide proportions, leaving two empty columns where the speakers would stand.
    const PANE: [number, number] = [520, 400];
    await page.viewport(...PANE);
    installTheme("dark");
    vfdView.face = "spectrum";

    expect(chassisMode(...PANE)).toBe("stack");
    const { speakers, amp, deck, cass, ctl } = layoutHifi(...PANE);
    expect(speakers, "speakers were kept on a portrait pane").toBeNull();
    expect(
      amp.w / PANE[0],
      "the stack did not take the width the speakers gave up",
    ).toBeGreaterThan(0.9);
    expect(deck.y + deck.h, "the stack overflows the pane").toBeLessThanOrEqual(PANE[1]);
    // The components keep the proportions of components: an amplifier and a deck are both
    // much wider than they are tall, and a pane with height to spare must not stretch them.
    expect(amp.w / amp.h, "the amplifier is too deep to be an amplifier").toBeGreaterThan(3);
    expect(deck.w / deck.h, "the deck came out square").toBeGreaterThan(1.6);
    // And the whole deck layout is the same shape here as on a wide pane, which is the
    // point of capping it — one door/controls split to get right, not two.
    const wideL = layoutHifi(960, 560);
    expect(cass.w / ctl.w).toBeCloseTo(wideL.cass.w / wideL.ctl.w, 2);

    const shot = await captureViz(HiFiDeck, {
      id: "hifi-narrow",
      outDir: OUT,
      settleMs: 2600,
      count: 3,
    });
    expect.soft(shot.fill, "the narrow layout drew almost nothing").toBeGreaterThan(20);
  },
);

test("the pane can shrink in BOTH directions inside a flex host", { timeout: 120000 }, async () => {
  // The bug this pins followed the window's height and ignored its width entirely.
  //
  // A flex item defaults to `min-size: auto` on the main axis, flooring it at its content's
  // min-content size. The app's viz stage is a ROW flex, so that floor is a WIDTH — and the
  // content is a canvas the chassis sizes with an explicit inline `width: NNNpx`. Laid out
  // once at 960 it could never be narrower than 960, so the ResizeObserver never saw a width
  // change and the stack never gave way to the walkman however small the window got.
  //
  // Reproduced in a ROW flex host: in a COLUMN flex `min-width: auto` does not apply and
  // the pane shrinks happily in both directions, hiding the bug.
  await page.viewport(960, 560);
  installTheme("dark");
  const feed = startVizFeed();

  const outer = document.createElement("div");
  outer.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column;overflow:hidden";
  const stage = document.createElement("div");
  // .vizstage: a row flex. .vizbody: min-height zeroed, min-width left at auto — which is
  // what a host sets out of habit, and why the fix belongs in the component.
  stage.style.cssText = "flex:1;min-height:0;display:flex;overflow:hidden";
  const body = document.createElement("div");
  body.style.cssText = "flex:1;min-height:0";
  stage.append(body);
  outer.append(stage);
  document.body.appendChild(outer);
  const app = mount(HiFiDeck, { target: body, props: { active: true } });
  await new Promise((r) => setTimeout(r, 1200));

  try {
    for (const [w, h] of [
      [420, 760],
      [960, 560],
      [380, 900],
    ] as [number, number][]) {
      await page.viewport(w, h);
      await new Promise((r) => setTimeout(r, 700));
      const r = body.getBoundingClientRect();
      expect(r.width, `pane stuck at ${r.width}px wide for a ${w}px viewport`).toBeLessThan(w + 2);
      expect(r.height, `pane stuck at ${r.height}px tall for a ${h}px viewport`).toBeLessThan(
        h + 2,
      );
    }
  } finally {
    unmount(app);
    outer.remove();
    feed.stop();
    await page.viewport(960, 560);
  }
});

test(
  "it redraws when the pane changes shape or theme, even while stopped",
  { timeout: 120000 },
  async () => {
    // The frame driver tears its rAF loop down entirely once the music stops (raf.ts), and a
    // resize sets the canvas's backing store, which CLEARS it — so a stopped pane must
    // repaint on resize, and on a theme switch too, because the cached layers bake the palette.
    await page.viewport(960, 560);
    installTheme("dark");
    vfdView.face = "spectrum";

    const feed = startVizFeed();
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;overflow:hidden;background:#0f0f0f";
    document.body.appendChild(host);
    const app = mount(HiFiDeck, { target: host, props: { active: false } });

    try {
      // Stop everything and wait out the settle window, so the loop is genuinely frozen.
      playback.playing = false;
      playback.paused = false;
      await new Promise((r) => setTimeout(r, 3000));

      const loc = (page as unknown as { elementLocator: (e: Element) => unknown }).elementLocator(
        host,
      );
      // Which machine the COMPONENT thinks it is drawing, read off the controls it
      // published rather than off the pure `chassisMode`.
      const machine = () => {
        const ids = [...host.querySelectorAll<HTMLButtonElement>("button.hw")]
          .map((b) => b.getAttribute("aria-label") ?? "")
          .join("|");
        return ids.includes("Hold") ? "walkman" : "stack";
      };
      expect(machine(), "did not start on the stack").toBe("stack");

      await page.viewport(520, 760);
      await new Promise((r) => setTimeout(r, 800));
      const afterResize = await grab(loc, null);
      expect(fill(afterResize), "the pane went blank after a resize while stopped").toBeGreaterThan(
        10,
      );
      expect(chassisMode(520, 760)).toBe("walkman");
      expect(machine(), "a portrait pane did not switch to the walkman").toBe("walkman");

      // …and back the other way, which is the direction that was broken: it went to the stack
      // and stayed there.
      await page.viewport(960, 560);
      await new Promise((r) => setTimeout(r, 800));
      expect(machine(), "widening did not switch back to the stack").toBe("stack");
      await page.viewport(520, 760);
      await new Promise((r) => setTimeout(r, 800));
      expect(machine(), "narrowing again did not switch back to the walkman").toBe("walkman");

      installTheme("light");
      await new Promise((r) => setTimeout(r, 600));
      const afterTheme = await grab(loc, null);
      const luma = (f: ImageData) => {
        let s = 0;
        for (let i = 0; i < f.data.length; i += 4) {
          s += 0.299 * f.data[i] + 0.587 * f.data[i + 1] + 0.114 * f.data[i + 2];
        }
        return s / (f.data.length / 4);
      };
      expect(luma(afterTheme), "the theme switch repainted nothing while stopped").toBeGreaterThan(
        luma(afterResize) * 1.6,
      );
    } finally {
      unmount(app);
      host.remove();
      feed.stop();
      installTheme("dark");
      await page.viewport(960, 560);
    }
  },
);

test("HOLD locks the walkman's one gesture", { timeout: 120000 }, async () => {
  // HOLD locked the transport so nothing happened while the machine was in a pocket. Here
  // it locks the only gesture this face has — pressing the plate to change what the display
  // shows — which on a phone, where the viz pane is something you touch by accident, is the
  // same protection it always was. A switch that does nothing would be a moulding.
  await page.viewport(420, 720);
  installTheme("dark");
  vfdView.face = "spectrum";

  const feed = startVizFeed();
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;overflow:hidden;background:#0f0f0f";
  document.body.appendChild(host);
  const app = mount(HiFiDeck, { target: host, props: { active: true } });
  await new Promise((r) => setTimeout(r, 1200));

  try {
    const named = (label: string) =>
      host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    const display = named("Change what the display shows")!;
    const hold = named("Hold — lock the display")!;
    expect(display, "no display control on the walkman").toBeTruthy();
    expect(hold, "no HOLD switch").toBeTruthy();

    const order = VFD_FACES.map((f) => f.id);
    const start = order.indexOf(vfdView.face);
    display.click();
    expect(vfdView.face, "pressing the plate did not change the face").toBe(
      order[(start + 1) % order.length],
    );

    // `tick()` between the click and the read: the state flips synchronously but the
    // attribute is written on Svelte's next flush, so reading it straight after the click
    // sees the old value and the assertion is about timing rather than about HOLD.
    hold.click();
    await tick();
    expect(hold.getAttribute("aria-pressed"), "HOLD does not report its state").toBe("true");
    const locked = vfdView.face;
    display.click();
    display.click();
    expect(vfdView.face, "HOLD did not lock the plate").toBe(locked);

    hold.click();
    await tick();
    expect(hold.getAttribute("aria-pressed")).toBe("false");
    display.click();
    expect(vfdView.face, "the plate stayed locked after HOLD was released").not.toBe(locked);
  } finally {
    unmount(app);
    host.remove();
    feed.stop();
    await page.viewport(960, 560);
  }
});

test("the faceplate's buttons are real controls", { timeout: 120000 }, async () => {
  // This visualiser has no chip row: it drew a DISPLAY button, so the DISPLAY button is the
  // control. That only holds up if the drawn buttons are reachable the way any button is —
  // by name, by keyboard, and at the coordinates the picture puts them.
  await page.viewport(960, 560);
  installTheme("dark");
  vfdView.face = "spectrum";

  const feed = startVizFeed();
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;overflow:hidden;background:#0f0f0f";
  document.body.appendChild(host);
  const app = mount(HiFiDeck, { target: host, props: { active: true } });
  await new Promise((r) => setTimeout(r, 1200));

  try {
    const named = (label: string) =>
      host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

    const display = named("Change what the display shows");
    expect(display, "no DISPLAY button on the faceplate").toBeTruthy();
    // It sits on the hardware it is pretending to be, not somewhere convenient.
    const { buttons } = layoutHifi(960, 560);
    const drawn = buttons.find((b) => b.id === "display")!.rect;
    const box = display!.getBoundingClientRect();
    expect(Math.abs(box.x - drawn.x), "the control is not over the button").toBeLessThan(2);
    expect(Math.abs(box.y - drawn.y), "the control is not over the button").toBeLessThan(2);

    // Pressing it cycles the window's job, which is what the real momentary button did.
    const order = VFD_FACES.map((f) => f.id);
    const start = order.indexOf(vfdView.face);
    display!.click();
    expect(vfdView.face, "DISPLAY did not change the face").toBe(order[(start + 1) % order.length]);
    display!.click();
    expect(vfdView.face).toBe(order[(start + 2) % order.length]);

    // Each key reaches the call it is labelled for — and only that one, so a key row where
    // two keys do the same thing fails here rather than in someone's hands.
    for (const [label, fn] of [
      ["Pause", wired.togglePause],
      ["Play", wired.transportToggle],
      ["Stop", wired.stop],
      ["Previous track", wired.playPrev],
      ["Next track", wired.playNext],
    ] as const) {
      Object.values(wired).forEach((f) => f.mockClear());
      named(label)!.click();
      expect(fn, `the ${label} key is not wired`).toHaveBeenCalledTimes(1);
      const others = Object.values(wired).filter((f) => f !== fn);
      expect(
        others.reduce((n, f) => n + f.mock.calls.length, 0),
        `the ${label} key also fired something else`,
      ).toBe(0);
    }

    // DIMMER walks the panel's three real duty-cycle positions and wraps; POWER switches
    // the display off and back on, which on a VFD is not blank — the undriven anodes and
    // the silkscreen stay behind the glass. Both go through the panel handle, so what is
    // being checked here is that a run of presses doesn't take it down.
    for (let i = 0; i < 5; i++) named("Dim the display")!.click();
    named("Switch the display off")!.click();
    await new Promise((r) => setTimeout(r, 120));
    named("Switch the display off")!.click();
    await new Promise((r) => setTimeout(r, 400));
    expect(host.querySelector("canvas.vfd"), "the display canvas is gone").toBeTruthy();

    // The volume knob is a real control, and it drives the shared player's master level —
    // the same state the transport's slider does, not a copy of it. A range rather than a
    // button, because a knob takes a drag.
    const vol = host.querySelector<HTMLInputElement>('input[aria-label="Volume"]');
    expect(vol, "the volume knob has no control over it").toBeTruthy();
    expect(vol!.type).toBe("range");
    const knob = layoutHifi(960, 560).volume;
    const vbox = vol!.getBoundingClientRect();
    expect(
      Math.abs(vbox.x + vbox.width / 2 - knob.x),
      "the control is not over the knob",
    ).toBeLessThan(2);
    vol!.value = "0.4";
    vol!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(playback.volume, "the knob did not set the master level").toBeCloseTo(0.4, 2);
    setVolume(1);

    // REC is on the faceplate because a deck has one, and is unpressable because nothing
    // here records — disabled rather than absent, so the key row is still a key row.
    const rec = host.querySelector<HTMLButtonElement>('button[aria-label^="Record"]');
    expect(rec, "no REC key").toBeTruthy();
    expect(rec!.disabled, "REC is pressable and has nothing to record").toBe(true);

    // Every control is reachable from a keyboard: these are the only way to work the
    // transport without a pointer.
    for (const b of host.querySelectorAll<HTMLButtonElement>("button.hw:not([disabled])")) {
      b.focus();
      expect(document.activeElement, `${b.getAttribute("aria-label")} cannot take focus`).toBe(b);
    }
  } finally {
    unmount(app);
    host.remove();
    feed.stop();
  }
});

test("EJECT takes the tape out and PLAY puts it back", { timeout: 120000 }, async () => {
  // The player has no "nothing selected" — there is always a current track — so an EJECT
  // that only ran an animation and put the same tape back was a button that did nothing.
  // The deck supplies the missing state itself: the track stays selected, it is just not in
  // the machine.
  const PANE: [number, number] = [960, 560];
  await page.viewport(...PANE);
  installTheme("dark");
  vfdView.face = "spectrum";

  const feed = startVizFeed();
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;overflow:hidden;background:#0f0f0f";
  document.body.appendChild(host);
  const app = mount(HiFiDeck, { target: host, props: { active: true } });
  await new Promise((r) => setTimeout(r, 1400));

  try {
    const named = (label: string) =>
      host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    const shot = async (name: string | null = null) =>
      grab(host.querySelector("canvas.chassis"), name && `${OUT}/${name}.png`);
    const { cass } = layoutHifi(...PANE);
    // The reels' half of the shell — empty, this is bare mechanism; loaded, it is tape.
    const box = { x: cass.x, y: cass.y + cass.h * 0.35, w: cass.w, h: cass.h * 0.4 };

    const withTape = await shot();

    Object.values(wired).forEach((f) => f.mockClear());
    named("Eject").click();
    // Long enough for the door to fall and the well to be shown empty.
    await new Promise((r) => setTimeout(r, 1400));
    const empty = await shot("hifi-open");

    expect(wired.stop, "EJECT did not stop playback").toHaveBeenCalledTimes(1);
    expect(
      motionIn(withTape, empty, PANE, box),
      "the well looks the same with the tape out as with it in",
    ).toBeGreaterThan(3);

    // …and PLAY loads it again and starts the same track.
    Object.values(wired).forEach((f) => f.mockClear());
    named("Play").click();
    await new Promise((r) => setTimeout(r, 1400));
    const back = await shot();

    expect(wired.transportToggle, "PLAY did not start the tape").toHaveBeenCalledTimes(1);
    expect(
      motionIn(empty, back, PANE, box),
      "the tape did not come back when PLAY was pressed",
    ).toBeGreaterThan(3);
  } finally {
    unmount(app);
    host.remove();
    feed.stop();
  }
});

test("a track change ejects, swaps the tape and closes the door", { timeout: 120000 }, async () => {
  await page.viewport(960, 560);
  installTheme("dark");
  vfdView.face = "spectrum";

  const shot = await captureViz(HiFiDeck, {
    id: "hifi-eject",
    outDir: OUT,
    settleMs: 2600,
    count: 8,
    onReady: async () => {
      // A different hash is what the component watches, and a different title/artist is
      // what has to end up on the label afterwards.
      playback.current = {
        hash: "beefcafebabe0001",
        filename: "second.mod",
        title: "The Second Tape",
        artist: "Somebody Else",
        duration: 180,
      };
      // Caught mid-travel: the door is ~0.42s each way with a hold at the bottom.
      await new Promise((r) => setTimeout(r, 280));
    },
  });
  // The door moving is a large, low-frequency change across the well — much bigger than
  // the reels or the analyser produce on their own.
  const peak = Math.max(...shot.frames.slice(1).map((f, i) => motion(shot.frames[i], f)));
  expect(peak, "nothing visibly happened on a track change").toBeGreaterThan(0.6);
});
