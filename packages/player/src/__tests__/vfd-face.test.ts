// The faceplate as data. Runs in node: `compilePanel` is documented as pure and headless,
// and the layout is a pure function of the face, so none of this needs a canvas.
//
// What @glowbox/vfd itself promises is checked in vfd-shakedown.svelte.test.ts, not here.
// This file is part of `yarn test`, so it may only assert things we control; the library's
// own claims belong in the suite that is allowed to be a to-do list.
import { describe, expect, it } from "vitest";

import { compilePanel } from "@glowbox/vfd";

import { layoutHifi } from "../hifi-chassis";
import {
  createTicker,
  isVfdFace,
  PANEL_FRAME,
  panelLayout,
  stereoLevels,
  VFD_FACES,
} from "../vfd-face";

describe("the faceplate's layout", () => {
  // A handful of pane shapes: wide desktop, short-and-wide, portrait phone, and the
  // degenerate one an async pane genuinely produces before it has been measured.
  const PANES: [number, number][] = [
    [960, 560],
    [1400, 300],
    [420, 620],
    [320, 240],
    [200, 120],
  ];

  it("never overlaps the lamps with each other", () => {
    // At 0.03 apart with a 0.032 diameter the two peak lamps ran into each other and read
    // as one smeared blob rather than as L and R. Two circles touching is arithmetic, and
    // arithmetic is exactly what a screenshot assertion is bad at.
    for (const pane of PANES) {
      const { lamps } = layoutHifi(...pane);
      for (let i = 0; i < lamps.length; i++) {
        for (let j = i + 1; j < lamps.length; j++) {
          const gap = Math.hypot(lamps[i].x - lamps[j].x, lamps[i].y - lamps[j].y);
          expect(gap, `lamps ${i}/${j} overlap at ${pane[0]}x${pane[1]}`).toBeGreaterThan(
            lamps[i].r + lamps[j].r,
          );
        }
      }
    }
  });

  it("never overlaps the pressable controls with each other", () => {
    // These carry invisible buttons, so an overlap is not just ugly: whichever one is later
    // in the DOM silently eats the other's clicks.
    for (const pane of PANES) {
      const { buttons } = layoutHifi(...pane);
      for (let i = 0; i < buttons.length; i++) {
        for (let j = i + 1; j < buttons.length; j++) {
          const a = buttons[i].rect;
          const b = buttons[j].rect;
          const hit =
            a.x < b.x + b.w - 0.5 &&
            b.x < a.x + a.w - 0.5 &&
            a.y < b.y + b.h - 0.5 &&
            b.y < a.y + a.h - 0.5;
          expect(hit, `${buttons[i].id} overlaps ${buttons[j].id} at ${pane[0]}x${pane[1]}`).toBe(
            false,
          );
        }
      }
    }
  });

  it("keeps every part of the stack inside the pane", () => {
    for (const pane of PANES) {
      const l = layoutHifi(...pane);
      const boxes = [l.amp, l.glass, l.deck, l.well, l.cass, l.ctl, l.keys, ...l.meters];
      for (const b of [...boxes, ...l.buttons.map((x) => x.rect)]) {
        expect(b.x, `off the left at ${pane[0]}x${pane[1]}`).toBeGreaterThanOrEqual(-0.5);
        expect(b.y, `off the top at ${pane[0]}x${pane[1]}`).toBeGreaterThanOrEqual(-0.5);
        expect(b.x + b.w, `off the right at ${pane[0]}x${pane[1]}`).toBeLessThanOrEqual(
          pane[0] + 0.5,
        );
        expect(b.y + b.h, `off the bottom at ${pane[0]}x${pane[1]}`).toBeLessThanOrEqual(
          pane[1] + 0.5,
        );
        expect(b.w, `zero width at ${pane[0]}x${pane[1]}`).toBeGreaterThan(0);
        expect(b.h, `zero height at ${pane[0]}x${pane[1]}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("the plate", () => {
  it("compiles on every face", () => {
    for (const f of VFD_FACES) {
      const p = compilePanel(PANEL_FRAME, panelLayout(f.id));
      expect(p.anodes.length, `${f.id}: no anodes`).toBeGreaterThan(100);
      expect(p.driven, `${f.id}: nothing drivable`).toBeGreaterThan(50);
    }
  });

  it("keeps the printed furniture identical across faces", () => {
    // Drive state is carried through a `setLayout` by element NAME, so the readouts and
    // annunciators only survive a face change if they are declared the same way on every
    // face. A rename here goes dark rather than throwing, which is why it is pinned.
    const names = VFD_FACES.map((f) => new Set(panelLayout(f.id).map((e) => e.name)));
    const shared = [...names[0]].filter((n) => names.every((s) => s.has(n)));
    for (const n of ["main", "time", "count", "play", "pause", "stop", "st", "dolby", "rpt"]) {
      expect(shared, `"${n}" is not on every face`).toContain(n);
    }
  });

  it("uses every element kind the plate has a job for", () => {
    // Not for its own sake: each kind is a different anode compiler, and this visualiser is
    // the app's coverage of them.
    //
    // Six of the seven. `scale` went with the FM dial, which came off because a tuning
    // cursor is a readout of nothing on a machine playing a cassette — and a kind kept on
    // the plate only to keep this list at seven would be the test wagging the product. The
    // compiler still gets exercised: vfd-shakedown drives all seven directly, which is what
    // that suite is for.
    const kinds = new Set(VFD_FACES.flatMap((f) => panelLayout(f.id).map((e) => e.kind)));
    for (const k of ["digits", "legend", "bars", "icon", "dots", "rule"]) {
      expect([...kinds], `no ${k} anywhere on the plate`).toContain(k);
    }
  });

  it("puts nothing outside the design frame", () => {
    for (const f of VFD_FACES) {
      const p = compilePanel(PANEL_FRAME, panelLayout(f.id));
      for (const el of p.elements) {
        expect(el.bounds.x, `${f.id}/${el.name} off the left`).toBeGreaterThanOrEqual(-0.01);
        expect(el.bounds.y, `${f.id}/${el.name} off the top`).toBeGreaterThanOrEqual(-0.01);
        expect(el.bounds.x + el.bounds.w, `${f.id}/${el.name} off the right`).toBeLessThanOrEqual(
          PANEL_FRAME[0] + 0.01,
        );
        expect(el.bounds.y + el.bounds.h, `${f.id}/${el.name} off the bottom`).toBeLessThanOrEqual(
          PANEL_FRAME[1] + 0.01,
        );
      }
    }
  });

  it("does not overlap the window's element with the furniture", () => {
    // The plate is crowded and the window is re-declared per face; an element landing on
    // top of a neighbour reads as a rendering fault rather than as a layout mistake.
    for (const f of VFD_FACES) {
      const p = compilePanel(PANEL_FRAME, panelLayout(f.id));
      const boxes = p.elements
        .filter((e) => e.kind !== "rule" && e.kind !== "icon")
        .map((e) => ({ n: e.name, b: e.bounds }));
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i].b;
          const b = boxes[j].b;
          const hit =
            a.x < b.x + b.w - 0.5 &&
            b.x < a.x + a.w - 0.5 &&
            a.y < b.y + b.h - 0.5 &&
            b.y < a.y + a.h - 0.5;
          expect(hit, `${f.id}: ${boxes[i].n} overlaps ${boxes[j].n}`).toBe(false);
        }
      }
    }
  });

  it("recognises its own face ids and nothing else", () => {
    expect(isVfdFace("spectrum")).toBe(true);
    for (const v of ["", "SPECTRUM", null, undefined, 0, {}]) expect(isVfdFace(v)).toBe(false);
  });
});

describe("the ticker", () => {
  it("is six dot columns per character", () => {
    const t = createTicker();
    t.setText("AB");
    expect(t.length).toBe(12);
  });

  it("lights something for a printable character and nothing for a space", () => {
    const t = createTicker();
    t.setText("H");
    let lit = 0;
    for (let x = 0; x < 6; x++) for (let y = 0; y < 9; y++) lit += t.sample(x, y, 9) > 0.5 ? 1 : 0;
    expect(lit).toBeGreaterThan(6);
    t.setText("  ");
    let blank = 0;
    for (let x = 0; x < 12; x++) for (let y = 0; y < 9; y++) blank += t.sample(x, y, 9);
    expect(blank).toBe(0);
  });

  it("leaves the padding rows dark", () => {
    // A 7-tall font in a 9-tall window: row 0 and row 8 belong to nobody.
    const t = createTicker();
    t.setText("MMMM");
    for (let x = 0; x < 24; x++) {
      expect(t.sample(x, 0, 9), `top row lit at ${x}`).toBe(0);
      expect(t.sample(x, 8, 9), `bottom row lit at ${x}`).toBe(0);
    }
  });

  it("blends between columns rather than stepping", () => {
    // The whole reason the text face is a dot area: fractional brightness is honest on a
    // multiplexed anode, so a half-column offset half-lights both neighbours and the text
    // glides. Stepping would give only 0s and 1s.
    const t = createTicker();
    t.setText("HELLO WORLD");
    t.advance(3.5);
    let fractional = 0;
    for (let x = 0; x < 30; x++) {
      for (let y = 0; y < 9; y++) {
        const v = t.sample(x, y, 9);
        if (v > 0.01 && v < 0.99) fractional++;
      }
    }
    expect(fractional, "the ticker is stepping whole columns").toBeGreaterThan(4);
  });

  it("wraps rather than running off the end", () => {
    const t = createTicker();
    t.setText("ABC");
    t.advance(1e6);
    expect(() => t.sample(0, 3, 9)).not.toThrow();
    t.advance(-1e6);
    expect(Number.isFinite(t.sample(0, 3, 9))).toBe(true);
  });

  it("survives an empty message", () => {
    const t = createTicker();
    t.setText("");
    t.advance(5);
    expect(t.sample(0, 3, 9)).toBe(0);
  });
});

describe("stereoLevels", () => {
  it("splits channels the way Paula panned them", () => {
    // L-R-R-L, repeating. Four channels hard-panned is the layout this music was written
    // for, and it is what keeps the two meters from always agreeing.
    const [l, r] = stereoLevels([1, 0, 0, 1]);
    expect(l).toBe(1);
    expect(r).toBe(0);
    const [l2, r2] = stereoLevels([0, 1, 1, 0]);
    expect(l2).toBe(0);
    expect(r2).toBe(1);
  });

  it("copes with any channel count, including none", () => {
    expect(stereoLevels([])).toEqual([0, 0]);
    expect(stereoLevels([0.5])).toEqual([0.5, 0]);
    const [l, r] = stereoLevels(new Array(32).fill(0.4));
    expect(l).toBeCloseTo(0.4, 6);
    expect(r).toBeCloseTo(0.4, 6);
  });
});
