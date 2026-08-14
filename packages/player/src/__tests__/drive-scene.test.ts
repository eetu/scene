// The night drive's world, weather and moon — all pure arithmetic, so all of it
// is checkable without a canvas. What's asserted here is what could otherwise
// only be caught by watching the visualiser for two minutes and hoping.
import { describe, expect, test } from "vitest";

import {
  BRIDGE_TOWER_GAP,
  buildProps,
  buildRoute,
  buildSkyline,
  DWELL_MAX,
  DWELL_MIN,
  dwellFor,
  hashSeed,
  MOODS,
  moonLit,
  moonLitFraction,
  moonPhaseAt,
  MOON_PERIOD,
  moonWaxing,
  type Mood,
  mixSky,
  nextMood,
  nextOther,
  rng,
  ROUTE_SPAN,
  routeAt,
  SKY,
} from "../drive-scene";
import {
  CAR_CONTACTS,
  CROWN_NAMES,
  LAMP_RAISE,
  LANDMARK_NAMES,
  SIGN_NAMES,
  SPRITES,
} from "../drive-sprites";
import { isPartBody, isPartRef, type SpriteBody, variantNames } from "../sprite-file";

const skyline = (seed: number) =>
  buildSkyline(rng(seed), {
    span: 520,
    minW: 9,
    maxW: 22,
    minH: 22,
    maxH: 74,
    windows: true,
    signs: 0.4,
  });

describe("the city", () => {
  test("the same track gets the same city, a different one does not", () => {
    const a = skyline(hashSeed("abc123"));
    const b = skyline(hashSeed("abc123"));
    const c = skyline(hashSeed("def456"));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  test("towers fit inside the strip they tile, so the seam never splits one", () => {
    const layer = skyline(hashSeed("seam"));
    expect(layer.towers.length).toBeGreaterThan(10);
    for (const t of layer.towers) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.x + t.w).toBeLessThanOrEqual(layer.span);
    }
  });

  test("windows sit inside their tower and address a real channel", () => {
    const layer = skyline(hashSeed("windows"));
    const windows = layer.towers.flatMap((t) => t.windows.map((win) => ({ t, win })));
    expect(windows.length).toBeGreaterThan(100);
    for (const { t, win } of windows) {
      expect(win.dx).toBeGreaterThan(0);
      expect(win.dx).toBeLessThan(t.w);
      expect(win.dy).toBeGreaterThan(0);
      expect(win.dy).toBeLessThan(t.h);
      expect(win.ch).toBeGreaterThanOrEqual(0);
      expect(win.ch).toBeLessThan(8);
    }
  });

  test("crowns and signs only ever name a sprite the sheet has", () => {
    const layer = skyline(hashSeed("sprites"));
    for (const t of layer.towers) {
      expect(t.crown).toBeGreaterThanOrEqual(-1);
      expect(t.crown).toBeLessThan(3);
      expect([0, 1, 2]).toContain(t.hue);
      for (const s of t.signs) {
        expect(s.sprite).toBeGreaterThanOrEqual(0);
        expect(s.sprite).toBeLessThan(3);
      }
    }
  });

  test("some towers are dark, and towers keep one hue", () => {
    const layer = skyline(hashSeed("dark-towers"));
    const dark = layer.towers.filter((t) => t.windows.length === 0);
    expect(dark.length).toBeGreaterThan(0);
    expect(dark.length).toBeLessThan(layer.towers.length);
  });

  test("a street may carry one filling station, and nothing stands in its forecourt", () => {
    // Seeds vary, so look across several: the station is a per-street coin toss and
    // a single seed can legitimately have none.
    let stations = 0;
    for (const seed of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      const rnd = rng(hashSeed(seed));
      const route = buildRoute(rnd);
      const props = buildProps(rnd, route);
      for (const s of props.filter((p) => p.kind === "station")) {
        stations++;
        // Its light and its canopy own the ground around it.
        for (const other of props) {
          if (other === s) continue;
          expect(Math.abs(other.x - s.x)).toBeGreaterThan(24);
        }
      }
      // One per street at most — never two in a row.
      const xs = props.filter((p) => p.kind === "station").map((p) => p.x);
      expect(new Set(xs).size).toBe(xs.length);
    }
    expect(stations).toBeGreaterThan(0);
  });

  test("props are spaced out — this layer is close enough to strobe", () => {
    const rnd = rng(hashSeed("props"));
    const route = buildRoute(rnd);
    const props = buildProps(rnd, route);
    expect(props.length).toBeGreaterThan(8);
    for (let i = 1; i < props.length; i++) {
      expect(props[i].x - props[i - 1].x).toBeGreaterThanOrEqual(24);
    }
  });
});

describe("the route", () => {
  test("segments tile the span exactly, with no gap at the seam", () => {
    const route = buildRoute(rng(42));
    expect(route[0].start).toBe(0);
    for (let i = 1; i < route.length; i++) {
      expect(route[i].start).toBe(route[i - 1].start + route[i - 1].len);
    }
    const last = route[route.length - 1];
    expect(last.start + last.len).toBe(ROUTE_SPAN);
    // …and the lookup wraps: one span later is the same stretch of road.
    expect(routeAt(route, ROUTE_SPAN, 100).kind).toBe(
      routeAt(route, ROUTE_SPAN, 100 + ROUTE_SPAN).kind,
    );
    expect(routeAt(route, ROUTE_SPAN, -50).kind).toBe(
      routeAt(route, ROUTE_SPAN, ROUTE_SPAN - 50).kind,
    );
  });

  test("no stretch repeats its kind, and bridges carry towers on the cable grid", () => {
    for (const seed of [1, 7, 99, 12345]) {
      const rnd = rng(seed);
      const route = buildRoute(rnd);
      for (let i = 1; i < route.length; i++) {
        expect(route[i].kind).not.toBe(route[i - 1].kind);
      }
      const props = buildProps(rnd, route);
      for (const pr of props) {
        if (pr.kind !== "pylonTower") continue;
        const seg = routeAt(route, ROUTE_SPAN, pr.x);
        expect(seg.kind).toBe("bridge");
        // On the grid the cable painter derives from — a tower off it would
        // leave a cable saddling thin air.
        expect((pr.x - seg.start) % BRIDGE_TOWER_GAP).toBe(0);
      }
    }
  });
});

describe("the weather", () => {
  test("a change is always a change, and every mood is reachable", () => {
    const rnd = rng(1234);
    const seen = new Set<Mood>();
    let mood: Mood = "clear";
    for (let i = 0; i < 400; i++) {
      const next = nextMood(mood, rnd);
      expect(next).not.toBe(mood);
      seen.add(next);
      mood = next;
    }
    expect([...seen].sort()).toEqual([...MOODS].sort());
  });

  test("picking from a short list never repeats, and reaches all of it", () => {
    // The landmarks use this: three of them, one at a time, minutes apart. Drawing
    // the same one twice running is the whole thing it exists to prevent — that reads
    // as the picker having stalled rather than as chance.
    const rnd = rng(77);
    const seen = new Set<number>();
    let pick = -1; // nothing chosen yet, so the first roll may be anything
    for (let i = 0; i < 300; i++) {
      const next = nextOther(pick, 3, rnd);
      expect(next).toBeGreaterThanOrEqual(0);
      expect(next).toBeLessThan(3);
      if (pick >= 0) expect(next).not.toBe(pick);
      seen.add(next);
      pick = next;
    }
    expect([...seen].sort()).toEqual([0, 1, 2]);
    // A list of one has nowhere else to go, and must not spin looking for it.
    expect(nextOther(0, 1, rnd)).toBe(0);
  });

  test("moods hold for the best part of a minute or more", () => {
    const rnd = rng(99);
    for (let i = 0; i < 200; i++) {
      const d = dwellFor(rnd);
      expect(d).toBeGreaterThanOrEqual(DWELL_MIN);
      expect(d).toBeLessThanOrEqual(DWELL_MAX);
    }
  });

  test("a transition is a blend of its ends, never an overshoot", () => {
    const mid = mixSky(SKY.clear, SKY.storm, 0.5);
    expect(mid.rain).toBeCloseTo(0.5, 5);
    expect(mid.bolt).toBeCloseTo(0.5, 5);
    // Lightning is gated on the *settled* mood, so a half-faded storm cannot
    // flash: the scene tests bolt > 0.5 against SKY[mood], not against the blend.
    const ends = mixSky(SKY.clear, SKY.storm, 1);
    const KNOBS = ["stars", "haze", "moon", "rain", "snow", "wind", "wet", "bolt"] as const;
    for (const key of KNOBS) {
      expect(mixSky(SKY.clear, SKY.storm, 0)[key]).toBeCloseTo(SKY.clear[key], 6);
      expect(ends[key]).toBeCloseTo(SKY.storm[key], 6);
    }
    for (const key of KNOBS) {
      expect(mid[key]).toBeGreaterThanOrEqual(0);
      expect(mid[key]).toBeLessThanOrEqual(1);
    }
  });

  test("only the storm carries lightning, and the wet moods soak the road", () => {
    expect(SKY.storm.bolt).toBeGreaterThan(0.5);
    for (const m of ["clear", "drizzle", "rain", "snow"] as const) expect(SKY[m].bolt).toBe(0);
    expect(SKY.rain.wet).toBeGreaterThan(SKY.clear.wet);
    expect(SKY.snow.snow).toBe(1);
    expect(SKY.snow.rain).toBe(0);
  });

  test("the wet moods are a progression, not one state repeated", () => {
    // Each step up is heavier AND windier, so drizzle → rain → downpour reads as
    // one weather getting worse rather than three unrelated skies.
    expect(SKY.drizzle.rain).toBeLessThan(SKY.rain.rain);
    expect(SKY.rain.rain).toBeLessThan(SKY.storm.rain);
    expect(SKY.drizzle.wind).toBeLessThan(SKY.rain.wind);
    expect(SKY.rain.wind).toBeLessThan(SKY.storm.wind);
    // …and you can still see the sky through a drizzle.
    expect(SKY.drizzle.moon).toBeGreaterThan(SKY.storm.moon);
    expect(SKY.drizzle.stars).toBeGreaterThan(SKY.rain.stars);
  });
});

describe("the moon", () => {
  // Sample the disc the way the scene bakes it: an even grid at pixel centres,
  // so there is no column sitting exactly on the terminator.
  const lit = (phase: number, R = 30) => {
    let on = 0;
    let total = 0;
    for (let iy = -R; iy < R; iy++) {
      for (let ix = -R; ix < R; ix++) {
        const nx = (ix + 0.5) / R;
        const ny = (iy + 0.5) / R;
        if (nx * nx + ny * ny > 1) continue;
        total++;
        if (moonLit(nx, ny, phase)) on++;
      }
    }
    return on / total;
  };

  test("the phase cycles once per period and wraps", () => {
    expect(moonPhaseAt(0, 0)).toBeCloseTo(0, 6);
    expect(moonPhaseAt(MOON_PERIOD / 2, 0)).toBeCloseTo(Math.PI, 5);
    expect(moonPhaseAt(MOON_PERIOD, 0)).toBeCloseTo(0, 5);
    expect(moonPhaseAt(-MOON_PERIOD / 4, 0)).toBeGreaterThan(0); // no negative angles
  });

  test("new is dark, full is whole, and a quarter is half a disc", () => {
    expect(lit(0)).toBe(0);
    expect(lit(Math.PI)).toBe(1);
    // Literally half a disc, both quarters — the terminator at a quarter is a
    // straight line through the centre, and the even pixel grid splits on it.
    // A half moon that renders 47% or 52% lit is the classic tell of an odd
    // grid with a column stuck on the boundary.
    expect(lit(Math.PI / 2)).toBeCloseTo(0.5, 3);
    expect(lit((3 * Math.PI) / 2)).toBeCloseTo(0.5, 3);
    // …and every other phase matches the illuminated fraction it should have.
    for (const p of [0.25, 0.75, 1.25, 1.75]) {
      expect(lit(Math.PI * p)).toBeCloseTo(moonLitFraction(Math.PI * p), 2);
    }
    expect(moonLitFraction(Math.PI)).toBe(1);
    expect(moonLitFraction(0)).toBe(0);
  });

  test("the lit limb swaps sides at full — waxing lights the right, waning the left", () => {
    const waxingQuarter = Math.PI / 2;
    const waningQuarter = (3 * Math.PI) / 2;
    expect(moonWaxing(waxingQuarter)).toBe(true);
    expect(moonWaxing(waningQuarter)).toBe(false);
    expect(moonLit(0.6, 0, waxingQuarter)).toBe(true);
    expect(moonLit(-0.6, 0, waxingQuarter)).toBe(false);
    expect(moonLit(0.6, 0, waningQuarter)).toBe(false);
    expect(moonLit(-0.6, 0, waningQuarter)).toBe(true);
  });

  test("the terminator bows the right way: crescent away from the limb, gibbous over it", () => {
    // A crescent lights less than half; a gibbous more. If the ellipse's sign
    // were flipped these two would swap, which is the classic way to draw a
    // moon that looks almost right and reads as wrong.
    expect(lit(0.6)).toBeLessThan(0.35);
    expect(lit(Math.PI - 0.6)).toBeGreaterThan(0.65);
    // The crescent hugs the lit limb: near the outer edge, not the middle.
    expect(moonLit(0.95, 0, 0.4)).toBe(true);
    expect(moonLit(0.2, 0, 0.4)).toBe(false);
  });

  test("nothing outside the disc is ever lit", () => {
    expect(moonLit(1.2, 0, Math.PI)).toBe(false);
    expect(moonLit(0, -1.01, Math.PI)).toBe(false);
  });
});

describe("the sprite sheet", () => {
  // The files are art, drawn in ../dab, which validates the format itself and will
  // not save a file that fails it. What is checked here is narrower and is the
  // scene's own business: that every grid the scene will bake is rectangular and
  // that every character in it has a colour. A hole in either draws as a hole.
  test("every grid is rectangular and every character has a colour", () => {
    const bodies = (node: SpriteBody, at: string): [SpriteBody, string][] => [
      [node, at],
      ...(node.parts ?? []).filter(isPartBody).flatMap((p) => bodies(p, `${at}/${p.name}`)),
    ];
    for (const [key, sprite] of Object.entries(SPRITES)) {
      for (const [body, at] of bodies(sprite, key)) {
        const known = new Set([...Object.keys(body.palette), "."]);
        for (const [f, frame] of body.frames.entries()) {
          expect(frame.length, `${at} frame ${f} is ${frame.length} rows, not ${body.h}`).toBe(
            body.h,
          );
          for (const row of frame) {
            expect(row.length, `${at} frame ${f} has a row ${row.length} wide, not ${body.w}`).toBe(
              body.w,
            );
            for (const ch of row) {
              expect(known, `${at} frame ${f} uses ${ch}, which has no colour`).toContain(ch);
            }
          }
        }
      }
    }
  });

  test("every part that names a sprite names one the sheet has", () => {
    // A `use` is a link across files, so it is the one thing in a sprite that can
    // dangle — a renamed wheel would draw as nothing at all.
    for (const [key, sprite] of Object.entries(SPRITES)) {
      const names = (sprite.parts ?? []).map((p) => p.name);
      expect(new Set(names).size, `${key} has two parts with one name`).toBe(names.length);
      for (const p of sprite.parts ?? []) {
        if (isPartRef(p)) expect(Object.keys(SPRITES), `${key}/${p.name}`).toContain(p.use);
      }
    }
  });

  test("the sheet is the folder: the glob actually resolved", () => {
    // Globbed, not listed, so a new sprite file needs no code and a renamed one
    // cannot leave a dangling import. A glob that silently matched nothing would
    // otherwise surface much later, as holes in the scene.
    expect(Object.keys(SPRITES).length).toBeGreaterThanOrEqual(13);
  });

  test("the registry key and the file's own name agree", () => {
    // They are used interchangeably — the scene asks the atlas for "car", the
    // editor saves car.json — so a mismatch is a rename that only half landed.
    for (const [key, sprite] of Object.entries(SPRITES)) expect(sprite.name).toBe(key);
  });

  test("the sheet still has what the scene asks it for", () => {
    for (const name of [
      ...SIGN_NAMES,
      ...CROWN_NAMES,
      ...LANDMARK_NAMES,
      "car",
      "wheel",
      "lamp",
      "palm",
    ]) {
      expect(Object.keys(SPRITES)).toContain(name);
    }
    // Multi-frame sprites are the animated ones; a single-frame wheel would stop
    // the car's wheels dead without failing anything else.
    expect(SPRITES.wheel.frames.length).toBeGreaterThan(1);
    for (const name of SIGN_NAMES) expect(SPRITES[name].frames.length).toBeGreaterThan(1);
    // A landmark's second frame is the same building with its aircraft light out. One
    // frame means a beacon stuck on, which is the tell of a half-finished sprite.
    for (const name of LANDMARK_NAMES) expect(SPRITES[name].frames.length).toBe(2);
  });

  test("the landmarks stand clear of the city they pass behind", () => {
    // They are drawn at their own parallax with their feet just under the horizon, so
    // the only thing that decides whether one is visible at all is its height against
    // the near skyline — whose towers top out 62 above their base. Anything shorter
    // than that is a landmark nobody ever sees, and it is not a thing a screenshot
    // reliably shows: it depends which tower it happens to pass behind.
    for (const name of LANDMARK_NAMES) {
      expect(SPRITES[name].h, `${name} would hide behind the near towers`).toBeGreaterThan(64);
      // ...and short enough to survive the crop on a very wide pane, which takes its
      // rows off the top of the buffer.
      expect(SPRITES[name].h, `${name} would be cropped on a wide pane`).toBeLessThan(84);
    }
  });

  test("the car's wheels and lamps are read off its parts, not written down twice", () => {
    // The skid marks, the tyre smoke and the snow rut are all placed at a contact
    // patch, and the wheels are two placements of one sprite. Hardcoding those
    // offsets is how the art moving three pixels became a silent bug in three
    // effects, so the numbers come from the file.
    expect(CAR_CONTACTS.length).toBe(2);
    for (const wx of CAR_CONTACTS) {
      expect(wx).toBeGreaterThan(0);
      expect(wx).toBeLessThan(SPRITES.car.w);
    }
    // Front and rear, well apart: two contacts a few pixels apart would be one
    // wheel counted twice.
    expect(Math.abs(CAR_CONTACTS[0] - CAR_CONTACTS[1])).toBeGreaterThan(SPRITES.car.w / 3);

    // The pop-up lamps' raise is the clip the art declares, and it has to end
    // somewhere other than where it starts or nothing pops up.
    expect(LAMP_RAISE.length).toBeGreaterThan(1);
    expect(LAMP_RAISE[LAMP_RAISE.length - 1]).not.toBe(LAMP_RAISE[0]);
    const lamp = SPRITES.car.parts?.find((p) => p.name === "lights");
    expect(lamp && isPartBody(lamp)).toBe(true);
    for (const f of LAMP_RAISE) {
      expect(f).toBeLessThan(lamp && isPartBody(lamp) ? lamp.frames.length : 0);
    }
  });

  test("the two-colour sprites offer the scene's second colour as a variant", () => {
    // The signs and the roadside tubes are drawn magenta on one building and cyan on
    // the next, which the atlas does by baking a sprite once per look. A tube sprite
    // with no variant would bake one look and silently come out magenta everywhere.
    for (const name of [...SIGN_NAMES, "lamp", "gantry"]) {
      expect(variantNames(SPRITES[name]), `${name} offers the scene no second colour`).toEqual([
        "cyan",
      ]);
    }
  });

  test("a variant only ever recolours, never introduces", () => {
    // The whole reason the format needs no reserved characters: a variant is a
    // recolour of the palette, so every cell has a colour with no variant selected.
    for (const [key, sprite] of Object.entries(SPRITES)) {
      for (const [variant, colours] of Object.entries(sprite.variants ?? {})) {
        for (const ch of Object.keys(colours)) {
          expect(
            sprite.palette,
            `${key}/${variant} recolours ${ch}, which it has no colour for`,
          ).toHaveProperty(ch);
        }
      }
    }
  });
});
