// The night-drive visualiser's pure half: the seeded world it drives through.
//
// Everything here is arithmetic over a seed, so the city, the weather it rolls
// through and the moon hanging over it can be checked without a canvas — the
// half of a scene that otherwise can only be verified by staring at it.
//
// The scene is a side-on parallax: the car holds its place and the world scrolls
// past it right-to-left in layers. Distances are expressed in the low-resolution
// buffer's pixels (see NeonDrive.svelte), because that buffer *is* the picture —
// the visible canvas only magnifies it.

export type RGB = [number, number, number];

const TAU = Math.PI * 2;

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Linear blend, used for every crossfade in the scene. */
export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

const mixRgb = (a: RGB, b: RGB, t: number): RGB => [
  mix(a[0], b[0], t),
  mix(a[1], b[1], t),
  mix(a[2], b[2], t),
];

export const rgb = (c: RGB, alpha = 1): string =>
  alpha >= 1
    ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`
    : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${alpha})`;

/** FNV-1a over a track's hash/filename — the scene's seed. */
export function hashSeed(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Mulberry32. Seeded so a tune always gets the same city, and so the tests can
 *  assert on a layout rather than on "something was generated". */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A stateless 0..1 hash of two integers — the scene's dither: snow lying on a
 * world cell rather than on a screen column, so a patch stays with its patch of
 * road while it scrolls.
 *
 * Fully avalanched rather than "multiply and take the top bits": consecutive
 * cells walk a multiplier's high bits by a fixed step, so that cheaper trick
 * dithers into visible diagonal banding instead of grain.
 */
export function noise(a: number, b: number): number {
  let n = Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1);
  n ^= n >>> 15;
  n = Math.imul(n, 0x2545f491);
  n ^= n >>> 13;
  return (n >>> 0) / 4294967296;
}

// ---------- weather ----------

export type Mood = "clear" | "drizzle" | "rain" | "storm" | "snow";

export const MOODS = ["clear", "drizzle", "rain", "storm", "snow"] as const;

/** Every knob the weather owns, all 0..1 except the two sky colours. A mood is
 *  just a point in this space, so a transition is one lerp and no layer has to
 *  know a change is happening. */
export type Sky = {
  /** How much of the star field shows through the cloud. */
  stars: number;
  /** Cloud cover — dims the skyline and softens every light. */
  haze: number;
  /** Moon brightness. Its phase is independent (see moonPhaseAt). */
  moon: number;
  /** Precipitation *intensity*, not just presence: it sets how many drops fall,
   *  how long each streak is and how fast it comes down, so a drizzle and a
   *  downpour are the same code at two settings. */
  rain: number;
  snow: number;
  /** How hard it is blowing, 0 straight down to 1 nearly sideways. Gusts ride
   *  on top of this in the scene; the mood only sets the average. */
  wind: number;
  /** Road wetness: how far the neon bleeds down the asphalt. */
  wet: number;
  /** Lightning enable, and the flash's ceiling. */
  bolt: number;
  top: RGB;
  horizon: RGB;
};

/** The five skies. Always night — these differ in weather, never in hour.
 *
 *  The three wet ones are deliberately a progression rather than one "raining"
 *  state: a still drizzle you can see the moon through, a windy rain coming in
 *  at an angle, and a downpour with the storm behind it. */
export const SKY: Record<Mood, Sky> = {
  clear: {
    stars: 1,
    haze: 0.05,
    moon: 1,
    rain: 0,
    snow: 0,
    wind: 0.1,
    wet: 0.18,
    bolt: 0,
    top: [8, 4, 26],
    horizon: [96, 16, 88],
  },
  drizzle: {
    stars: 0.32,
    haze: 0.42,
    moon: 0.55,
    rain: 0.3,
    snow: 0,
    wind: 0.05,
    wet: 0.7,
    bolt: 0,
    top: [12, 8, 32],
    horizon: [78, 18, 82],
  },
  rain: {
    stars: 0.12,
    haze: 0.62,
    moon: 0.34,
    rain: 0.68,
    snow: 0,
    wind: 0.55,
    wet: 1,
    bolt: 0,
    top: [10, 8, 28],
    horizon: [66, 14, 74],
  },
  storm: {
    stars: 0.04,
    haze: 0.88,
    moon: 0.14,
    rain: 1,
    snow: 0,
    wind: 0.9,
    wet: 1,
    bolt: 1,
    top: [8, 6, 20],
    horizon: [56, 10, 64],
  },
  snow: {
    stars: 0.34,
    haze: 0.5,
    moon: 0.62,
    rain: 0,
    snow: 1,
    wind: 0.3,
    wet: 0.45,
    bolt: 0,
    top: [16, 12, 38],
    horizon: [84, 30, 96],
  },
};

/** Seconds a mood holds before the next one is picked. Long on purpose: the
 *  weather should have changed while you weren't looking, not perform for you. */
export const DWELL_MIN = 45;
export const DWELL_MAX = 90;
/** Seconds a transition takes. Slower than any single effect in the scene, so
 *  rain thins out rather than stopping. */
export const FADE = 6;

export const dwellFor = (rnd: () => number): number => DWELL_MIN + rnd() * (DWELL_MAX - DWELL_MIN);

/** Never the mood we're already in — a "change" that changes nothing reads as a
 *  stall, and with four moods there is always somewhere else to go. */
export function nextMood(current: Mood, rnd: () => number): Mood {
  const others = MOODS.filter((m) => m !== current);
  return others[Math.min(others.length - 1, (rnd() * others.length) | 0)];
}

export function mixSky(a: Sky, b: Sky, t: number): Sky {
  const f = clamp01(t);
  return {
    stars: mix(a.stars, b.stars, f),
    haze: mix(a.haze, b.haze, f),
    moon: mix(a.moon, b.moon, f),
    rain: mix(a.rain, b.rain, f),
    snow: mix(a.snow, b.snow, f),
    wind: mix(a.wind, b.wind, f),
    wet: mix(a.wet, b.wet, f),
    bolt: mix(a.bolt, b.bolt, f),
    top: mixRgb(a.top, b.top, f),
    horizon: mixRgb(a.horizon, b.horizon, f),
  };
}

// ---------- moon ----------

/** Seconds for a full synodic cycle. A real month is unwatchable and a fast
 *  cycle looks like an animation, so it is compressed to twenty minutes: over a
 *  listening session the moon visibly waxes, but never inside one glance. */
export const MOON_PERIOD = 1200;

/** Phase angle in radians: 0 new, π full, wrapping at 2π. */
export const moonPhaseAt = (clock: number, offset: number): number =>
  ((((clock / MOON_PERIOD) * TAU + offset) % TAU) + TAU) % TAU;

/** Illuminated fraction of the disc, 0 at new and 1 at full. */
export const moonLitFraction = (phase: number): number => (1 - Math.cos(phase)) / 2;

/** Waxing halves light from the right limb, waning from the left. */
export const moonWaxing = (phase: number): boolean => phase < Math.PI;

/**
 * Is this point of the disc lit?
 *
 * `nx`,`ny` are normalised to the disc (−1..1 from its centre). The terminator
 * is the projection of a great circle, i.e. a half-ellipse whose half-width is
 * `cos(phase)` — so at a quarter it is a straight line, it bows away from the
 * lit limb for a crescent and over the dark side for a gibbous. Testing per
 * pixel rather than compositing two arcs is what keeps the edge crisp at this
 * resolution (and it is what makes the geometry testable).
 */
export function moonLit(nx: number, ny: number, phase: number): boolean {
  if (nx * nx + ny * ny > 1) return false;
  const term = Math.cos(phase) * Math.sqrt(Math.max(0, 1 - ny * ny));
  return moonWaxing(phase) ? nx > term : nx < -term;
}

/** Maria, in disc coordinates (x, y, radius). Fixed: the moon always shows the
 *  same face, and a randomised one reads as a golf ball. */
export const MARIA: ReadonlyArray<readonly [number, number, number]> = [
  [-0.28, -0.3, 0.3],
  [0.16, -0.42, 0.2],
  [0.3, 0.06, 0.26],
  [-0.34, 0.34, 0.22],
  [0.02, 0.3, 0.16],
];

// ---------- city ----------

export type Window = {
  /** Offsets from the tower's left/base, in buffer pixels. */
  dx: number;
  dy: number;
  /** Which mixer channel lights it — the skyline is the level meter. */
  ch: number;
  /** How readily it lights at all, so the city isn't uniformly busy. */
  bias: number;
};

export type Sign = {
  dx: number;
  dy: number;
  /** Index into the sheet's sign sprites. */
  sprite: number;
  /** 0 magenta, 1 cyan — the scene's two colours, nothing else. */
  hue: 0 | 1;
  /** Blink rate in radians/second; the flicker frame rides on top of it. */
  rate: number;
  phase: number;
};

/** What a sign is assumed to measure when the caller did not say — the box signs
 *  the city started with. */
const DEFAULT_SIGN_SIZE = { w: 6, h: 8 };

export type Tower = {
  x: number;
  w: number;
  h: number;
  /** 0..1 into the layer's near→far shade ramp. */
  shade: number;
  /** Roof furniture: -1 flat, else an index into the sheet's crown sprites. */
  crown: number;
  /** The tower's window colour: 0 cyan, 1 magenta, 2 mixed. One hue per tower —
   *  a building's lights come from one kind of tube, and per-window random hues
   *  are exactly what made the skyline read as noise. */
  hue: 0 | 1 | 2;
  windows: Window[];
  signs: Sign[];
};

export type Layer = {
  /** Width of the generated strip. It tiles, so the scroll can run forever. */
  span: number;
  towers: Tower[];
};

export type SkylineOpts = {
  span: number;
  minW: number;
  maxW: number;
  minH: number;
  maxH: number;
  /** Lit windows, and how many channels they spread over. */
  windows: boolean;
  channels?: number;
  /** Chance per tower of carrying a neon sign. */
  signs?: number;
  /** How many sign sprites the sheet offers. */
  signSprites?: number;
  /** What each of those sprites measures, so a sign is only ever put on a face
   *  big enough to hold it. Sizes rather than the sheet itself: this module
   *  generates a city without knowing anything about an atlas. */
  signSizes?: ReadonlyArray<{ w: number; h: number }>;
  /** How many crown sprites the sheet offers. */
  crowns?: number;
  gapMax?: number;
};

/**
 * A tiling strip of towers.
 *
 * Generated to `span` and drawn twice, offset by a span, so the city repeats
 * instead of ending. Towers are packed left to right with small gaps; the last
 * one is trimmed rather than allowed to straddle the seam, which would show as a
 * tower that changes width every time it wraps.
 */
export function buildSkyline(rnd: () => number, opts: SkylineOpts): Layer {
  const {
    span,
    minW,
    maxW,
    minH,
    maxH,
    windows,
    channels = 8,
    signs = 0,
    signSprites = 3,
    signSizes,
    crowns = 3,
    gapMax = 3,
  } = opts;
  const towers: Tower[] = [];
  let x = 0;
  while (x < span) {
    const w = Math.round(minW + rnd() * (maxW - minW));
    if (x + w > span) break;
    const h = Math.round(minH + rnd() * (maxH - minH));
    // Most roofs are flat — furniture on every one of them turns a skyline into
    // a comb.
    const roll = rnd();
    const hueRoll = rnd();
    const tower: Tower = {
      x,
      w,
      h,
      shade: rnd(),
      crown: roll < 0.45 ? -1 : Math.min(crowns - 1, ((roll - 0.45) / 0.55 / (1 / crowns)) | 0),
      hue: hueRoll < 0.42 ? 0 : hueRoll < 0.8 ? 1 : 2,
      windows: [],
      signs: [],
    };
    // A fifth of the towers are dark. The gaps are what make the lit ones read:
    // a skyline where every building glows is a texture, not a city.
    if (windows && rnd() >= 0.2) {
      // A 3×3 cell — a window, two of wall, and a floor between rows. Sparser
      // than the real thing on purpose; density reads as noise at this scale.
      for (let dy = 3; dy < h - 2; dy += 3) {
        for (let dx = 2; dx < w - 1; dx += 3) {
          if (rnd() < 0.35) continue; // dark flats break up the grid
          tower.windows.push({
            dx,
            dy,
            ch: (rnd() * channels) | 0,
            bias: rnd(),
          });
        }
      }
    }
    // Hang a sign in a band of the tower's face, if the face can hold one at all.
    // Only sprites that FIT are candidates: a kana column is three times the
    // height of a box sign and twice the height of the heart, and one of those
    // hung off the corner of a tower too small for it is worse than a bare tower.
    const hang = (from: number, to: number) => {
      const fits: number[] = [];
      for (let i = 0; i < signSprites; i++) {
        const s = signSizes?.[i] ?? DEFAULT_SIGN_SIZE;
        if (s.w <= w - 2 && s.h <= to - from) fits.push(i);
      }
      if (!fits.length) return;
      const sprite = fits[Math.min(fits.length - 1, (rnd() * fits.length) | 0)];
      const s = signSizes?.[sprite] ?? DEFAULT_SIGN_SIZE;
      tower.signs.push({
        dx: 1 + Math.round(rnd() * (w - s.w - 2)),
        dy: from + Math.round(rnd() * (to - from - s.h)),
        sprite,
        hue: rnd() < 0.5 ? 0 : 1,
        rate: 0.6 + rnd() * 3.4,
        phase: rnd() * TAU,
      });
    };
    if (signs > 0 && rnd() < signs && w >= 9 && h >= 18) {
      // A tower with the height for it carries two, stacked: one sign per building
      // is a high street, and this city is meant to be plastered. They get a band
      // of the face each, so the second can never land on top of the first.
      const stacked = h >= 46 && rnd() < 0.45;
      const split = Math.round(h * 0.55);
      hang(3, stacked ? split : h - 3);
      if (stacked) hang(split, h - 3);
    }
    towers.push(tower);
    x += w + Math.round(rnd() * gapMax);
  }
  return { span, towers };
}

// ---------- the route ----------

/** What the road is passing through. The route is laid out along the scroll
 *  axis — you drive ONTO a bridge and off it again — rather than crossfaded in
 *  place, because a road that morphs under a stationary car reads as a glitch
 *  where a bridge joint sliding past reads as travel. */
export type RouteKind = "street" | "bridge" | "highway";

/** World-pixels of route before it tiles. Long enough that the repeat is not
 *  recognisable at the near layer's scroll rate. */
export const ROUTE_SPAN = 2560;

export type Segment = { start: number; len: number; kind: RouteKind };

/** Partition the route into stretches, street the most common, never the same
 *  kind twice in a row (two bridges with a joint between them is one bridge). */
export function buildRoute(rnd: () => number, span = ROUTE_SPAN): Segment[] {
  const segs: Segment[] = [];
  let x = 0;
  let last: RouteKind | null = null;
  while (x < span) {
    const roll = rnd();
    let kind: RouteKind = roll < 0.5 ? "street" : roll < 0.78 ? "bridge" : "highway";
    if (kind === last) kind = kind === "street" ? "bridge" : "street";
    const len = Math.min(Math.round(420 + rnd() * 520), span - x);
    segs.push({ start: x, len, kind });
    last = kind;
    x += len;
  }
  return segs;
}

/** The stretch under world-position x (wrapped into the span). */
export function routeAt(segs: Segment[], span: number, x: number): Segment {
  const u = ((x % span) + span) % span;
  for (const s of segs) if (u >= s.start && u < s.start + s.len) return s;
  return segs[segs.length - 1];
}

export type Prop = {
  x: number;
  /** Names a sprite on the sheet. */
  kind: "lamp" | "pylon" | "palm" | "pylonTower" | "gantry";
  hue: 0 | 1;
  /** Which animation frame this one starts on, so a row of palms doesn't sway
   *  in lockstep. */
  phase: number;
};

/** Spacing of the bridge's suspension towers — the cable painter needs the same
 *  number, so it is a constant rather than a roll. */
export const BRIDGE_TOWER_GAP = 240;

/** The near layer's furniture, laid along the route: streets get lamps and
 *  palms, bridges get their towers, highways get gantries. Sparse everywhere —
 *  this close to the camera anything dense turns into a strobe. */
export function buildProps(rnd: () => number, segs: Segment[]): Prop[] {
  const props: Prop[] = [];
  for (const seg of segs) {
    if (seg.kind === "bridge") {
      // Towers on a fixed grid from the segment's start, so the cables (drawn
      // per-column from the same arithmetic) always land on them.
      for (let x = seg.start; x < seg.start + seg.len; x += BRIDGE_TOWER_GAP) {
        props.push({ x, kind: "pylonTower", hue: rnd() < 0.5 ? 0 : 1, phase: rnd() * TAU });
      }
      continue;
    }
    if (seg.kind === "highway") {
      for (
        let x = seg.start + 60 + rnd() * 80;
        x < seg.start + seg.len - 30;
        x += 200 + rnd() * 120
      ) {
        props.push({
          x: Math.round(x),
          kind: "gantry",
          hue: rnd() < 0.5 ? 0 : 1,
          phase: rnd() * TAU,
        });
      }
      continue;
    }
    let x = seg.start + 10;
    while (x < seg.start + seg.len - 10) {
      const roll = rnd();
      const kind: Prop["kind"] = roll < 0.55 ? "lamp" : roll < 0.78 ? "palm" : "pylon";
      props.push({ x, kind, hue: rnd() < 0.5 ? 0 : 1, phase: rnd() * TAU });
      x += Math.round(30 + rnd() * 44);
    }
  }
  return props;
}
