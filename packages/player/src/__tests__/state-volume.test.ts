// The persisted master volume's initialiser. Pure, so it needs no Storage and no DOM —
// which is the point of it being a function rather than an IIFE inside the store: the
// interesting case is what an ABSENT key means, and that is exactly the case a test with a
// real localStorage has to fight to set up.
import { describe, expect, it } from "vitest";

import { initialVolume } from "../state.svelte";

describe("initialVolume", () => {
  it("is full volume when nothing has been saved", () => {
    // The regression, and it shipped. `Number(null)` is 0, 0 is a perfectly valid volume,
    // so a finite-and-in-range check waves it through — a first-ever load came up silent
    // with the knob and the slider both at zero, which reads as a broken player rather
    // than as a setting.
    expect(initialVolume(null)).toBe(1);
  });

  it("is full volume when the stored value is unusable", () => {
    // "" coerces to 0 exactly like null does. The rest is the ordinary garbage a
    // hand-edited or half-written key can hold.
    for (const raw of ["", "   ", "abc", "NaN", "-0.5", "2", "Infinity", "-Infinity"]) {
      expect(initialVolume(raw), `"${raw}" did not fall back`).toBe(1);
    }
  });

  it("restores a level that was actually saved, including silence", () => {
    // Zero survives when it was stored on purpose: this tells "no key" apart from "turned
    // down", it does not refuse to be quiet.
    expect(initialVolume("0")).toBe(0);
    expect(initialVolume("0.4")).toBeCloseTo(0.4, 6);
    expect(initialVolume("1")).toBe(1);
  });
});
