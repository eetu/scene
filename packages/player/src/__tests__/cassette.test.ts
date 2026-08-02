// The cassette's mechanics. Pure maths, so the parts that are physics can be checked
// without rendering anything — and they are worth checking, because every one of these
// properties is invisible in a still frame and wrong in the obvious implementation.
import { describe, expect, it } from "vitest";

import {
  counterText,
  DOOR_S,
  FULL_R,
  HUB_R,
  initialDeck,
  reelState,
  startSwap,
  stepDeck,
  stepSwap,
  SWAP_S,
  swapOpen,
  tapeCounter,
} from "../cassette";

describe("reelState", () => {
  it("puts all the tape on the supply hub at the head of a side", () => {
    const r = reelState(0);
    expect(r.supplyR).toBeCloseTo(FULL_R, 6);
    expect(r.takeupR).toBeCloseTo(HUB_R, 6);
  });

  it("has swapped them by the end", () => {
    const r = reelState(1);
    expect(r.supplyR).toBeCloseTo(HUB_R, 6);
    expect(r.takeupR).toBeCloseTo(FULL_R, 6);
  });

  it("conserves tape: r² + r² is the same at every position", () => {
    // The invariant the whole thing rests on. A linear interpolation between hub and full
    // radius — the obvious wrong implementation — fails this everywhere but the ends.
    const total = HUB_R ** 2 + FULL_R ** 2;
    for (let f = 0; f <= 1.0001; f += 0.05) {
      const r = reelState(f);
      expect(r.supplyR ** 2 + r.takeupR ** 2, `at frac ${f.toFixed(2)}`).toBeCloseTo(total, 6);
    }
  });

  it("never lets the two packs collide, without being told not to", () => {
    // Hub centres are 42mm apart and a full pack is 48mm across, so a naive drawing WILL
    // overlap them. It never happens here because the tape has to be somewhere: the sum of
    // the radii peaks at the halfway point and is still comfortably under the spacing.
    const HUB_SPACING = 42;
    let worst = 0;
    for (let f = 0; f <= 1.0001; f += 0.01) {
      const r = reelState(f);
      worst = Math.max(worst, r.supplyR + r.takeupR);
    }
    expect(worst).toBeLessThan(HUB_SPACING);
    // …and it peaks in the middle, not at an end.
    expect(reelState(0.5).supplyR + reelState(0.5).takeupR).toBeCloseTo(worst, 3);
  });

  it("turns the empty hub faster than the full one", () => {
    // Constant linear tape speed over unequal radii. Two reels turning at one rate is the
    // tell that a cassette was drawn from memory.
    const head = reelState(0.05);
    expect(head.takeupW).toBeGreaterThan(head.supplyW * 1.9);
    const tail = reelState(0.95);
    expect(tail.supplyW).toBeGreaterThan(tail.takeupW * 1.9);
    // They cross exactly once, in the middle.
    const mid = reelState(0.5);
    expect(mid.supplyW).toBeCloseTo(mid.takeupW, 6);
  });

  it("clamps rather than producing nonsense for a nonsense position", () => {
    for (const bad of [NaN, Infinity, -Infinity, -5, 12]) {
      const r = reelState(bad);
      expect(Number.isFinite(r.supplyR), `${bad}`).toBe(true);
      expect(r.supplyR).toBeGreaterThanOrEqual(HUB_R - 1e-9);
      expect(r.supplyR).toBeLessThanOrEqual(FULL_R + 1e-9);
    }
  });
});

describe("tapeCounter", () => {
  it("starts at zero and rises the whole way", () => {
    expect(tapeCounter(0)).toBe(0);
    let last = -1;
    for (let f = 0; f <= 1.0001; f += 0.02) {
      const n = tapeCounter(f);
      expect(n, `at ${f.toFixed(2)}`).toBeGreaterThanOrEqual(last);
      last = n;
    }
    expect(last).toBeGreaterThan(5000);
  });

  it("runs fast at the head of a side and slow at the end", () => {
    // Geared off the take-up hub, not off a clock — which is exactly why nobody could ever
    // find a song again by its counter number. The first tenth of the tape is worth about
    // twice as many counts as the last, because the hub is turning twice as fast there.
    const firstTenth = tapeCounter(0.1) - tapeCounter(0);
    const lastTenth = tapeCounter(1) - tapeCounter(0.9);
    expect(firstTenth / lastTenth).toBeGreaterThan(1.8);
    expect(firstTenth / lastTenth).toBeLessThan(2.2);
  });

  it("always gives a display four characters wide", () => {
    for (const f of [0, 0.001, 0.5, 0.9999, 1]) {
      expect(counterText(f)).toHaveLength(4);
    }
    expect(counterText(0)).toBe("0000");
  });
});

describe("stepDeck", () => {
  it("turns both hubs the same way, anticlockwise, and the guides with them", () => {
    // Direction is a fact about the tape path, not a preference — see the SPIN note in
    // cassette.ts. The tape leaves each pack on its OUTER edge, because the guide rollers
    // are in the shell's bottom corners, outboard of the hubs; that puts the left pack's
    // left edge moving down and the right pack's right edge moving up, which on a screen
    // (y down) is anticlockwise for both.
    //
    // The check that matters is that they AGREE: one tape cannot drive two hubs in
    // opposite directions, and getting that wrong is invisible in a still frame.
    const s = initialDeck();
    const TAU = Math.PI * 2;
    // Unwrapped travel, so the modulo can't hide the sign.
    let supply = 0;
    let takeup = 0;
    let guide = 0;
    let prev = { s: s.supplyAngle, t: s.takeupAngle, g: s.guideAngle };
    for (let i = 0; i < 60; i++) {
      stepDeck(s, 1 / 60, "play", 0.5);
      const d = (now: number, was: number) => {
        let delta = now - was;
        if (delta > Math.PI) delta -= TAU;
        if (delta < -Math.PI) delta += TAU;
        return delta;
      };
      supply += d(s.supplyAngle, prev.s);
      takeup += d(s.takeupAngle, prev.t);
      guide += d(s.guideAngle, prev.g);
      prev = { s: s.supplyAngle, t: s.takeupAngle, g: s.guideAngle };
    }
    expect(supply, "the supply hub turns the wrong way").toBeLessThan(0);
    expect(takeup, "the take-up hub turns the wrong way").toBeLessThan(0);
    expect(guide, "the guide rollers turn against the tape").toBeLessThan(0);
    // The guides are a couple of millimetres across against the packs' twenty, so they run
    // several times faster — which is the whole reason they are worth drawing.
    expect(Math.abs(guide)).toBeGreaterThan(Math.abs(takeup) * 4);
    // Angles stay wrapped into [0, 2π) whichever way they went.
    for (const a of [s.supplyAngle, s.takeupAngle, s.guideAngle]) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(TAU);
    }
  });

  it("spins up while playing and coasts to a stop, rather than freezing", () => {
    const s = initialDeck();
    stepDeck(s, 0.05, "play", 0.3);
    // Spin-up is damped, so the first frames move a little; run a second of it.
    for (let i = 0; i < 20; i++) stepDeck(s, 0.05, "play", 0.3);
    expect(s.supplyAngle).not.toBe(0);
    expect(s.takeupAngle).not.toBe(0);
    expect(s.spin).toBeGreaterThan(0.9);

    const before = s.supplyAngle;
    for (let i = 0; i < 60; i++) stepDeck(s, 0.05, "stop", 0.3);
    expect(s.spin).toBe(0);
    const after = s.supplyAngle;
    for (let i = 0; i < 20; i++) stepDeck(s, 0.05, "stop", 0.3);
    // Coasted to a stop and stayed there, rather than freezing the instant STOP was hit.
    expect(after).not.toBe(before);
    expect(s.supplyAngle).toBe(after);
  });

  it("holds the tape still but keeps the door shut on pause", () => {
    const s = initialDeck();
    for (let i = 0; i < 40; i++) stepDeck(s, 0.05, "play", 0.5);
    for (let i = 0; i < 60; i++) stepDeck(s, 0.05, "pause", 0.5);
    expect(s.spin).toBe(0);
    expect(s.door).toBe(0);
  });

  it("opens and closes the door over its travel time", () => {
    // Stepped at frame size, because that is the only size stepDeck accepts: it clamps dt
    // to 50ms so a tab coming back from the background cannot teleport the mechanism.
    const s = initialDeck();
    const run = (secs: number, mode: "eject" | "stop") => {
      for (let t = 0; t < secs; t += 1 / 60) stepDeck(s, 1 / 60, mode, 0);
    };
    run(DOOR_S / 2, "eject");
    expect(s.door).toBeGreaterThan(0.4);
    expect(s.door).toBeLessThan(0.62);
    run(DOOR_S, "eject");
    expect(s.door).toBe(1);
    run(DOOR_S * 1.5, "stop");
    expect(s.door).toBe(0);
  });

  it("survives a hostile dt", () => {
    const s = initialDeck();
    for (const dt of [NaN, -1, Infinity, 1e9, 0]) {
      expect(() => stepDeck(s, dt, "play", 0.5)).not.toThrow();
      expect(Number.isFinite(s.supplyAngle), `dt ${dt}`).toBe(true);
      expect(Number.isFinite(s.door), `dt ${dt}`).toBe(true);
    }
  });

  it("throws the head carriage in on play and out on stop", () => {
    // One carriage, one solenoid: the head and the pinch roller are on the same plate, so
    // they go in and come out together. Pause holds them in — the tape stops because the
    // capstan stops driving it, not because anything let go of it.
    const s = initialDeck();
    const run = (mode: Parameters<typeof stepDeck>[2], seconds: number) => {
      for (let t = 0; t < seconds; t += 0.02) stepDeck(s, 0.02, mode, 0.5);
    };

    run("play", 1);
    expect(s.engage, "the carriage never went in on play").toBe(1);

    run("pause", 1);
    expect(s.engage, "pause pulled the carriage out").toBe(1);

    run("stop", 1);
    expect(s.engage, "stop left the carriage in").toBe(0);

    run("play", 1);
    run("eject", 1);
    expect(s.engage, "eject left the carriage in").toBe(0);
  });

  it("does not oscillate once the carriage is home", () => {
    // The door had exactly this bug: clamping to 0/1 instead of to the target means the
    // frame that lands ON the target steps back off it next time, and the part sits there
    // vibrating by one frame of travel. Same clamp, so the same test.
    const s = initialDeck();
    for (let t = 0; t < 2; t += 0.02) stepDeck(s, 0.02, "play", 0.5);
    for (let i = 0; i < 20; i++) {
      stepDeck(s, 0.02, "play", 0.5);
      expect(s.engage, `the carriage moved off its stop on frame ${i}`).toBe(1);
    }
  });
});

describe("the eject cycle", () => {
  it("swaps the cassette exactly once, at the bottom of the door's travel", () => {
    const sw = startSwap();
    let swaps = 0;
    let openAtSwap = false;
    for (let t = 0; t < SWAP_S * 2; t += 0.02) {
      const before = swapOpen(sw);
      if (stepSwap(sw, 0.02)) {
        swaps++;
        openAtSwap = before;
      }
    }
    expect(swaps, "the tape was exchanged more than once, or not at all").toBe(1);
    // The exchange must happen while the door is still down, or you watch the label change
    // in the open.
    expect(openAtSwap, "the tape was exchanged with the door already closing").toBe(true);
    expect(sw.left).toBe(0);
  });

  it("resumes from wherever it got to if the loop was frozen mid-cycle", () => {
    // The frame driver tears its rAF loop down on a paused pane (see raf.ts), so a cycle
    // can genuinely be interrupted and picked up later.
    const sw = startSwap();
    stepSwap(sw, 0.05);
    const mid = sw.left;
    expect(mid).toBeLessThan(SWAP_S);
    for (let i = 0; i < 200; i++) stepSwap(sw, 0.02);
    expect(sw.left).toBe(0);
    expect(sw.swapped).toBe(true);
    // And a finished cycle stays finished.
    expect(stepSwap(sw, 0.02)).toBe(false);
  });
});
