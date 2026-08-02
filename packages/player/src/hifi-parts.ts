// The pieces both hi-fi chassis are made of: the drawing primitives, the compact
// cassette itself, and the transport keys.
//
// Two chassis, because a viz pane can be either shape and a stereo stack is the wrong object
// for a tall one. hifi-chassis.ts draws the separates stack; hifi-walkman.ts draws the
// personal stereo that portrait panes get instead. What they share is everything below —
// most importantly the cassette, which is the point of the visualiser and has to be exactly
// the same object in both, turned on its side in one of them.
import { type DeckState, GUIDE_R, HUB_R, reelState } from "./cassette";

export type Rect = { x: number; y: number; w: number; h: number };

/** Every control on the front that does something when you press it. */
export type HifiButtonId =
  | "power"
  | "display"
  | "dimmer"
  | "hold"
  | "eject"
  | "rec"
  | "rew"
  | "ff"
  | "pause"
  | "play"
  | "stop";

export type HifiButton = {
  id: HifiButtonId;
  /** Where it is, in CSS pixels — the component parks a real focusable control here. */
  rect: Rect;
  /** What it does, for the accessible name. */
  label: string;
  /** REC is on the faceplate because a deck has one; nothing here records. It stays,
   *  unpressable, rather than being left off — a five-key transport is not a deck. */
  inert?: boolean;
};

// Charcoal brushed aluminium with a champagne trim line: the late-golden-age look, when
// the silver-faced separates had gone black but the gold anodising stayed on as a stripe.
/**
 * The two finishes this hardware came in.
 *
 * Not a light-mode tint of a dark-mode palette: they are the two eras. Black-faced charcoal
 * with a champagne stripe is the late-golden-age separates look; brushed silver with the
 * same gold stripe is what the decade started in, and what a light room wants. Both are
 * real, so both get real colours rather than one being a washed-out copy of the other.
 *
 * Two things do NOT follow the theme, on purpose:
 *   - the display recess, because a vacuum-fluorescent tube is a dark hole behind smoked
 *     plastic in any room;
 *   - the speaker drivers, because cones were black on silver cabinets too. Their shading
 *     is fixed as well, not just their colour — see DRIVER in hifi-chassis.ts.
 *
 * The cassette DOES follow it. "A cassette is a cassette" holds for any single tape and not
 * for the shelf: smoke-grey and ivory shells were both ordinary, and a black one lying in
 * the well of a silver deck is the last thing on screen still lit for the other room. So the
 * shell changes with the finish and the label does not, because the label was printed by
 * whoever owned the tape.
 */
const PALETTES = {
  dark: {
    room: "#08090b",
    roomHi: "#15171b",
    face: "#2b2d32",
    faceLo: "#191b1f",
    trim: "#8a7647",
    trimHi: "#c8ae6a",
    print: "#8b9099",
    printDim: "#5b6068",
    glassWell: "#050607",
    /** Cabinet, and the recessed baffle the drivers bolt to. */
    cabTop: "#1c1d21",
    cabBot: "#0b0c0e",
    baffle: "#121316",
    /** Grille cloth, and the two thread tones its weave is made of. */
    cloth: "#0e0f12",
    threadHi: "rgba(255,255,255,0.055)",
    threadLo: "rgba(0,0,0,0.55)",
    /** The cassette's shell, top to bottom, and the bulkier bottom moulding under it. */
    shellHi: "#3c3e46",
    shellMid: "#25272d",
    shellLo: "#15161a",
    mouldHi: "#33353c",
    mouldMid: "#2a2c33",
    mouldLo: "#191a1e",
    /** Key caps and small buttons. */
    keyTop: "#3a3d44",
    keyMid: "#23262b",
    keyBot: "#14161a",
    btn: "#262930",
    notch: "#1b1d21",
    /** Holes: the cassette well and the door surround. */
    recess: "#0d0e11",
    /** The floor of the well, behind the cassette, and the hole a VU meter's dial sits in.
     *  Both are openings in the FACEPLATE rather than driver hardware, so unlike the cones
     *  they do follow the finish — a silver deck's well was pale grey plastic, and painting
     *  it black put two holes cut out of the middle of a lit panel. */
    wellFloor: "#08090a",
    meterWell: "#08090a",
    /** The smoked acrylic door, top to bottom — the walkman's lid is the same plastic. */
    doorTop: "rgba(14,20,26,0.62)",
    doorMid: "rgba(8,12,17,0.44)",
    doorBot: "rgba(4,6,9,0.66)",
    /** A lit top edge and a dark bottom one — which way round depends on the finish. */
    edgeHi: "rgba(255,255,255,0.10)",
    edgeLo: "rgba(0,0,0,0.80)",
    vfdSpill: "rgba(120, 255, 214, 0.09)",
    ledRed: "#ff3a20",
    ledGreen: "#48ff92",
  },
  light: {
    room: "#b9bcc2",
    roomHi: "#dcdee2",
    face: "#cdd0d6",
    faceLo: "#aeb2ba",
    trim: "#8a7647",
    trimHi: "#c8ae6a",
    print: "#3d4148",
    printDim: "#6a6f77",
    glassWell: "#0a0c0f",
    cabTop: "#c4c7cd",
    cabBot: "#a3a8b0",
    baffle: "#2b2e33",
    // Grey cloth on a silver cabinet, which is what the silver-faced systems came wearing —
    // the drivers stayed black behind it, but the cloth itself matched the box.
    cloth: "#8d9199",
    threadHi: "rgba(255,255,255,0.30)",
    threadLo: "rgba(0,0,0,0.22)",
    // An ivory shell. Smoke-grey is the cassette everyone pictures, but the white-bodied
    // tapes were just as real — TDK's D, BASF's ferro, the Maxell URs — and a black one in
    // the well of a silver deck was the last object still lit for the other room.
    shellHi: "#f2efe7",
    shellMid: "#dedbd2",
    shellLo: "#c3c0b7",
    mouldHi: "#dbd8cf",
    mouldMid: "#c9c6bd",
    mouldLo: "#a9a69d",
    keyTop: "#e2e5ea",
    keyMid: "#c6cad1",
    keyBot: "#a7acb4",
    btn: "#c9cdd4",
    notch: "#9ea3ab",
    recess: "#6e737a",
    // A shade under the chamfer around them, so each still reads as a recess rather than as
    // a patch of the same grey.
    wellFloor: "#5c616a",
    meterWell: "#787d86",
    // Barely tinted. The door is the same smoked acrylic in either room, but a tint heavy
    // enough to read as smoke against a black deck simply put the ivory cassette back in
    // the dark — the shell is what you are meant to be looking at, and the door is in front
    // of it. A lit room does not push that much grey through a window either.
    doorTop: "rgba(74,82,92,0.26)",
    doorMid: "rgba(64,72,82,0.14)",
    doorBot: "rgba(54,62,72,0.3)",
    // Inverted: on a pale panel the highlight is the strong one and the shadow is soft.
    edgeHi: "rgba(255,255,255,0.65)",
    edgeLo: "rgba(0,0,0,0.32)",
    // The display's spill barely registers on silver, and pretending otherwise puts a green
    // haze on a metal panel in a lit room.
    vfdSpill: "rgba(120, 255, 214, 0.035)",
    ledRed: "#ff3a20",
    ledGreen: "#22e178",
  },
} as const;

/**
 * The live palette.
 *
 * A mutable object rather than a swapped reference, so every `INK.face` in the two chassis
 * modules keeps working and there is exactly one place the theme is held. There is only ever
 * one theme on a page, which is what makes module-level state the right shape here.
 */
export const INK: Record<keyof (typeof PALETTES)["dark"], string> = { ...PALETTES.dark };

export type ChassisTheme = keyof typeof PALETTES;

/** What the app is currently showing. Matches how the other 2D visualisers read it. */
export function currentTheme(): ChassisTheme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function setChassisTheme(t: ChassisTheme) {
  Object.assign(INK, PALETTES[t]);
}

/** Label paper, in the off-whites blank inlays were printed on. A tape's identity was its
 *  label, so these still vary per track — but only in the paper, since the band that carries
 *  the colour now comes from the app's accent (see `labelStock`). */
export const PAPERS = [
  { paper: "#ece6d8", ink: "#2a2320" },
  { paper: "#e8e9ec", ink: "#1c232e" },
  { paper: "#eae7dc", ink: "#26241f" },
  { paper: "#e6ead9", ink: "#22291f" },
  { paper: "#efe6d4", ink: "#2e2418" },
];

type RGB = [number, number, number];

function parseHex(s: string): RGB {
  const t = s.trim();
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(t);
  if (m) {
    const h = m[1].length === 3 ? m[1].replace(/./g, (ch) => ch + ch) : m[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = /rgba?\(([^)]+)\)/i.exec(t);
  if (rgb) {
    const n = rgb[1].split(",").map((v) => parseFloat(v));
    return [n[0] || 0, n[1] || 0, n[2] || 0];
  }
  return [247, 143, 8]; // the family's warm orange
}

const css = (c: RGB) => `rgb(${c.map((v) => Math.round(Math.max(0, Math.min(255, v)))).join(",")})`;
const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** The app's accent, as the visualisers read it. */
export function accentColor(): RGB {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
    return [247, 143, 8];
  }
  return parseHex(getComputedStyle(document.documentElement).getPropertyValue("--accent"));
}

/**
 * One tape's label colours.
 *
 * The band used to be a fixed set of the real brands' own colours — TDK burgundy, Sony blue,
 * BASF green. Handsome, but it left the cassette as the one object in the visualiser that
 * ignored the app's accent, and it is the object the eye goes to.
 *
 * So the band is the accent now, and the per-track variety that made every module arrive on
 * its own tape moved into two places that can carry it without fighting the theme: five
 * treatments of that one colour, and the paper it is printed on. A re-themed accent takes the
 * whole tape library with it, which is the point.
 */
export function labelStock(seed: number) {
  const i = Math.abs(seed) % PAPERS.length;
  const a = accentColor();
  const black: RGB = [16, 16, 18];
  const white: RGB = [255, 252, 246];
  // Five ways the same colour was printed: full strength, two depths of ink, one knocked
  // back toward the paper, one deepened almost to black.
  const band = [
    a,
    mix(a, black, 0.34),
    mix(a, black, 0.58),
    mix(a, white, 0.18),
    mix(a, black, 0.75),
  ][i];
  return {
    paper: PAPERS[i].paper,
    ink: PAPERS[i].ink,
    band: css(band),
    // The hairline and the side-letter box: the band lifted toward the paper so it reads as
    // a second printing rather than a shadow of the first.
    accent: css(mix(band, white, 0.55)),
  };
}

export const TAU = Math.PI * 2;

export function rr(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const k = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

/** A vertical two-stop fill, the shape of light falling on a horizontal brushed panel. */
export function vgrad(ctx: CanvasRenderingContext2D, r: Rect, top: string, bottom: string) {
  const g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  return g;
}

/** Brushed metal: fine horizontal streaks over a gradient. Only ever drawn into a cached
 *  offscreen — per frame this would be thousands of strokes for a texture that never
 *  changes. */
export function brushed(ctx: CanvasRenderingContext2D, r: Rect, top: string, bottom: string) {
  ctx.fillStyle = vgrad(ctx, r, top, bottom);
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.globalAlpha = 0.05;
  // Deterministic streaks: a fixed hash rather than Math.random, so a resize redraws the
  // same panel instead of re-rolling the grain.
  let h = 0x9e3779b9;
  for (let y = r.y; y < r.y + r.h; y += 1) {
    h = (Math.imul(h ^ (y * 2654435761), 2246822519) >>> 0) % 1000;
    ctx.fillStyle = h > 620 ? "#ffffff" : h > 300 ? "#000000" : "transparent";
    ctx.fillRect(r.x, y, r.w, 1);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

/** The champagne hairline that separated the sections on every faceplate of the era. */
export function trimLine(ctx: CanvasRenderingContext2D, x: number, y: number, w: number) {
  ctx.fillStyle = INK.trim;
  ctx.fillRect(x, y, w, 1);
  ctx.fillStyle = INK.edgeHi;
  ctx.fillRect(x, y + 1, w, 1);
}

export function label(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  px: number,
  color = INK.print,
  align: CanvasTextAlign = "left",
) {
  ctx.fillStyle = color;
  ctx.font = `${px}px ui-monospace, monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
}

/** Shrink to fit, then clip with an ellipsis — a label has a fixed amount of paper on it. */
export function fitted(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  px: number,
): string {
  ctx.font = `${px}px ui-monospace, monospace`;
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
  return `${s}…`;
}

// ─── grille covers ─────────────────────────────────────────────────────────────────────
//
// The cloth-covered frames that clip onto the front of the cabinets. Drawn every frame
// rather than baked into the static layer, because they are the one thing here that sits
// IN FRONT of something moving: the woofer breathes underneath and shows faintly through
// the weave, which is exactly what a real grille does and the reason people take them off.
//
// The weave is a repeat pattern built once, so the per-frame cost of all that texture is a
// single fillRect. Rebuilt when the device pixel ratio or the finish changes, since the
// tile is authored in device pixels to keep the threads a crisp pixel wide.

let clothTile: { key: string; pattern: CanvasPattern } | null = null;

/** The pitch of the weave, in CSS pixels — one warp thread and one weft thread this far
 *  apart. Fine enough to read as cloth rather than as a grid at any size the cabinets get. */
const THREAD_PITCH = 3;

function clothPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const dpr = Math.max(1, Math.round(ctx.getTransform().a));
  const key = `${dpr}:${currentTheme()}`;
  if (clothTile?.key === key) return clothTile.pattern;

  const n = THREAD_PITCH * 2 * dpr;
  const tile = document.createElement("canvas");
  tile.width = n;
  tile.height = n;
  const g = tile.getContext("2d");
  if (!g) return null;
  g.fillStyle = INK.cloth;
  g.fillRect(0, 0, n, n);
  // Two warp threads and two weft threads to a tile — the smallest unit that can carry an
  // over-under, which is what separates cloth from graph paper.
  g.fillStyle = INK.threadHi;
  for (let i = 0; i < 2; i++) {
    g.fillRect(i * THREAD_PITCH * dpr, 0, dpr, n);
    g.fillRect(0, i * THREAD_PITCH * dpr, n, dpr);
  }
  // At two of the four crossings the warp dips under the weft, so its highlight is knocked
  // out there. Alternating crossings is the whole weave.
  g.fillStyle = INK.threadLo;
  for (let i = 0; i < 2; i++) {
    g.fillRect(i * THREAD_PITCH * dpr, i * THREAD_PITCH * dpr, dpr, dpr);
  }

  const pattern = ctx.createPattern(tile, "repeat");
  if (!pattern) return null;
  // Authored in device pixels, drawn into a context already scaled by the ratio — so the
  // pattern has to be scaled back down or the threads come out DPR times too coarse.
  pattern.setTransform(new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, 0, 0]));
  clothTile = { key, pattern };
  return pattern;
}

/** Where a cabinet's cover sits: nearly the whole front, with the cabinet's own edge showing
 *  round it the way a clip-on frame leaves a margin. */
export function grilleOf(r: Rect): Rect {
  return { x: r.x + r.w * 0.05, y: r.y + r.h * 0.035, w: r.w * 0.9, h: r.h * 0.93 };
}

/** The cover, over whatever has already been drawn on the baffle. */
export function paintGrille(ctx: CanvasRenderingContext2D, r: Rect) {
  const c = grilleOf(r);
  const rad = Math.max(2, r.w * 0.02);

  ctx.save();
  // It stands off the baffle, so it casts.
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = Math.max(2, r.w * 0.03);
  ctx.shadowOffsetY = Math.max(1, r.h * 0.004);

  const weave = clothPattern(ctx);
  // Not quite opaque: the woofer under it stays a ghost, which is what you actually see.
  ctx.globalAlpha = 0.93;
  ctx.fillStyle = weave ?? INK.cloth;
  rr(ctx, c.x, c.y, c.w, c.h, rad);
  ctx.fill();
  ctx.restore();

  ctx.save();
  rr(ctx, c.x, c.y, c.w, c.h, rad);
  ctx.clip();
  // Cloth stretched on a frame: lit where it faces the room's light, falling off into the
  // corners where it wraps round the edge.
  const sheen = ctx.createLinearGradient(c.x, c.y, c.x + c.w * 0.6, c.y + c.h);
  sheen.addColorStop(0, "rgba(255,255,255,0.07)");
  sheen.addColorStop(0.45, "rgba(255,255,255,0)");
  sheen.addColorStop(1, "rgba(0,0,0,0.14)");
  ctx.fillStyle = sheen;
  ctx.fillRect(c.x, c.y, c.w, c.h);
  const vig = ctx.createRadialGradient(
    c.x + c.w / 2,
    c.y + c.h / 2,
    Math.min(c.w, c.h) * 0.2,
    c.x + c.w / 2,
    c.y + c.h / 2,
    Math.max(c.w, c.h) * 0.62,
  );
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(1, "rgba(0,0,0,0.3)");
  ctx.fillStyle = vig;
  ctx.fillRect(c.x, c.y, c.w, c.h);
  ctx.restore();

  // The frame's own edge, lit on top and dark underneath.
  ctx.lineWidth = Math.max(1, r.w * 0.008);
  ctx.strokeStyle = INK.edgeLo;
  rr(ctx, c.x, c.y, c.w, c.h, rad);
  ctx.stroke();
  ctx.strokeStyle = INK.edgeHi;
  ctx.lineWidth = 1;
  rr(ctx, c.x + 0.5, c.y + 0.5, c.w - 1, c.h - 1, rad);
  ctx.stroke();

  paintGrilleBadge(ctx, c);
}

/** The badge on the cloth: bottom centre, the way every one of these had the maker's mark
 *  sitting just above the bottom edge of the grille. */
function paintGrilleBadge(ctx: CanvasRenderingContext2D, c: Rect) {
  const size = Math.max(9, Math.min(c.w * 0.17, c.h * 0.1));
  paintWordmark(ctx, c.x + c.w / 2, c.y + c.h - Math.max(3, c.h * 0.05), size);
}

// ─── the maker's mark ──────────────────────────────────────────────────────────────────

const MARK_FONT = `"Snell Roundhand", "Apple Chancery", "Segoe Script", "Brush Script MT", cursive`;

/**
 * A gold script E — the one piece of branding on the whole system, and it lives on the
 * grille covers and nowhere else. A badge on the cloth is where a maker's mark belongs on a
 * system like this; repeating it on every faceplate would turn a detail into livery.
 *
 * Stamped rather than printed: a dark impression under the metal, then the metal over it
 * with its own fall from polished at the top to shadowed at the bottom. That is what makes
 * it sit ON the cloth instead of in it, and it is why the shadow stays dark on the silver
 * finish too — a gold badge on grey cloth still casts.
 */
function paintWordmark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  align: CanvasTextAlign = "center",
) {
  ctx.save();
  ctx.font = `italic ${size}px ${MARK_FONT}`;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillText("E", x, y + Math.max(1, size * 0.05));
  const gold = ctx.createLinearGradient(0, y - size * 0.72, 0, y + size * 0.1);
  gold.addColorStop(0, "#f6e3ab");
  gold.addColorStop(0.42, "#d4ab4c");
  gold.addColorStop(0.72, "#a3781f");
  gold.addColorStop(1, "#dcbb6b");
  ctx.fillStyle = gold;
  ctx.fillText("E", x, y);
  ctx.restore();
}

// ─── the cassette ──────────────────────────────────────────────────────────────────────
//
// Everything below is in the cassette's own 0..1 space, so the geometry reads as fractions
// of a real shell rather than as pixel numbers that mean nothing.

/** A cassette's own proportions: 100.5 × 63.8 mm. */
export const CASS_ASPECT = 100.5 / 63.8;

/** Hub centres: 42 mm apart on a 100.5 mm shell. Vertically they have to clear a full
 *  24 mm pack at the top and leave the tape path room along the bottom, which lands them
 *  a little above the middle of the shell — 42 mm apart and 30 mm down. */
export const HUB_X = [0.5 - 21 / 100.5, 0.5 + 21 / 100.5];
export const HUB_Y = 28 / 63.8;
/** Pack radii as a fraction of shell WIDTH (the units cassette.ts works in are mm). */
export const R_SCALE = 1 / 100.5;
/** The window cut through the front. It clips the packs top and bottom, as a real one
 *  does — the label covers their crowns and the bottom edge is the moulding below.
 *
 *  Only `x`, `y` and `w` are the window's own: its bottom edge belongs to `BAND`, because the
 *  window is a cutout in the thin front face and that face stops where the moulding starts. */
export const WIN = { x: 0.035, y: 0.3, w: 0.93 };
/** The bulkier bottom moulding's top edge — see the note in `paintCassette`.
 *
 *  Not a straight line across, which is why the window is no longer a rectangle. Only the
 *  MIDDLE of the shell is bulkier — that is where the head, the capstan and the pinch roller
 *  press in and the shell needs the material. Out at the sides there is no thick section at
 *  all: the face runs straight down to the bottom wall, so the window does too and the corner
 *  guide rollers and the run of tape into them stay in plain sight. The window bends around
 *  the raised centre between them.
 *
 *  `side` stops a hair short of 1 for the shell's own bottom wall — the aperture is a cutout
 *  in a face, not a bite out of its edge.
 *
 *  A TRAPEZOID, not a step: `foot0`/`foot1` are where its walls meet the shell's bottom edge
 *  and `x0`/`x1` where they arrive at the flat top, so the flanks splay outward on the way
 *  down. It is a moulding drafted for release from a tool, which is why every one of these
 *  has that shape — straight walls read as a slab dropped on the shell. */
export const BAND = { side: 0.96, mid: 0.8, x0: 0.2, x1: 0.8, foot0: 0.155, foot1: 0.845 };

/** The guide lugs on the shell's two short sides: how far down they start, how tall they
 *  are as a fraction of the shell's height, and how far they stand proud of its width.
 *
 *  Their bottom edge lands 5mm up from the shell's own bottom — 5/63.8 of the height, which
 *  is where it is on the real part: down near the mechanism they locate the shell into,
 *  rather than adrift in the middle of the side. */
export const LUG = { y: 1 - 5 / 63.8 - 0.22, h: 0.22, w: 0.011 };

/**
 * The openings through the moulding, as fractions of the shell.
 *
 * The outer pair is ROUND — the holes the deck's guide posts come up through — and sits
 * lower, out at the tape line. The inner pair is SQUARE and sits a little higher.
 *
 * Small, and they stay small. It is tempting to open them out into one window per transport
 * part, on the theory that a part needs a hole to come through — it does, but that hole is in
 * the shell's bottom EDGE and this is the label face, so the windows buy nothing except
 * gouges out of the moulding. The parts are drawn in the bay below the cassette instead; see
 * `drawTransport`.
 */
export const OPENINGS = {
  postX: [0.26, 0.74],
  postY: 0.925,
  postR: 0.02,
  slotX: [0.37, 0.63],
  slotY: 0.9,
  slotW: 0.028,
  slotH: 0.02,
};

/**
 * Where the transport's three parts sit across the cassette, as fractions of its width.
 *
 * Deliberately NOT the same thing as `OPENINGS`. These are the mechanism's own layout — what
 * is bolted to the head carriage under the tape — and the moulding's holes are the shell's.
 * Tying them together is what produced the three-window version.
 */
/** The strip of bay under the cassette's bottom edge, as a fraction of the shell's HEIGHT —
 *  where the head carriage is seen. One number, because the empty well and the loaded one
 *  have to agree about it or the mechanism jumps as the tape comes out. */
export const BAY = 0.045;

/** How far the pinch roller's arm swings between released and engaged, in radians. Small,
 *  because the arm is long — but far enough that the tyre finishes ON the rod coming up
 *  through the guide hole rather than a hair short of it. Stopping short is invisible as
 *  geometry and obvious as a picture: a roller not touching anything is not pinching. */
const PINCH_SWING = 0.46;

export const TRANSPORT = {
  // Out on the guide-post holes, both of them, and that is mechanics rather than spacing.
  // A steel rod comes up through each of those holes — the capstan on the right — and the
  // pinch roller traps the tape against it. So the roller has to be ON that hole, not
  // inboard of it: pinching against nothing is what it was doing before. The erase head
  // mirrors it about the centre, on its own pivot, because that is where its rod is.
  erase: { x: 0.26, w: 0.07 },
  // Widths are fractions of the shell's 100.5mm, so this head is a hair under 12mm across.
  head: { x: 0.5, w: 0.117 },
  // A shade narrower than the head — the roller's DIAMETER is about a head's width, which is
  // what makes it read as a wheel of a believable size. Sizing it off its own slot got a
  // tyre half that big.
  pinch: { x: 0.74, w: 0.092 },
};

/** Where a flank crosses the window's side run, i.e. the x at which the aperture's bottom
 *  edge stops running level and starts climbing the moulding. */
function bandFoot(c: Rect, left: boolean): number {
  const s = (1 - BAND.side) / (1 - BAND.mid);
  const foot = left ? BAND.foot0 : BAND.foot1;
  const top = left ? BAND.x0 : BAND.x1;
  return c.x + (foot + (top - foot) * s) * c.w;
}
/** The paper inlay above it, inset far enough to leave the corner screws showing — the
 *  label never covered them, because you had to be able to get the shell apart. */
export const LBL = { x: 0.09, y: 0.04, w: 0.82, h: 0.225 };
/** The corner guide rollers.
 *
 *  Right out at the shell's bottom corners, which is where they are on a real cassette and
 *  is the whole reason the tape leaves the packs from their OUTER edges: the rollers sit
 *  outboard of the hubs, so the tape has to clear each pack's widest point to reach one.
 *  Tucked in beside the reels instead, the path reads as tape falling off the bottom of a
 *  hub rather than being carried around a corner.
 *
 *  Measured off the Wikimedia playback-path schematic
 *  (Cassette_playback_mode_-_2head_1capstan_ITA.svg): 10.4mm in from each side and 59.2mm
 *  down, i.e. tucked right against the bottom edge, well below the hubs and only a little
 *  inboard of the corners.
 *
 *  Measured off the RENDERED diagram, note, not off its source coordinates. Reading the SVG's
 *  numbers gave a confident-looking 6.5mm × 52.5mm that was wrong in the vertical, because
 *  the file has no shell rectangle to anchor against and the arithmetic ended up hanging off
 *  this drawing's own hub position rather than the diagram's. Rendering it and measuring the
 *  shell's four edges has nothing to assume.
 *
 *  Clearance is worth checking in millimetres rather than by eye. A full 24mm pack on a hub
 *  29.25mm from the left edge leaves very little room: an early pass had the roller 1.9mm off
 *  the pack, which is touching at any size that matters. These positions give 9.8mm.
 *
 *  The vertical is then cheated up by about a millimetre off the measured 59.2mm, which is
 *  the one liberty taken with this drawing. At the true height the roller's bottom edge is
 *  clipped by the window and you get most of a circle with a flat on it — and half a roller
 *  reads as a rendering fault rather than as a part, which defeats the point of having gone
 *  and measured it. A millimetre buys the whole part. */
export const GUIDE = { x: 0.103, y: 0.908 };

/** Traces the moulding's top edge, left to right, as a path — the shallow run at each side and
 *  the raised centre between them, with every turn rounded. Plastic has no sharp inside
 *  corners, and the aperture that follows this line is a moulded edge, not a cut one. */
function bandCrest(ctx: CanvasRenderingContext2D, c: Rect) {
  const cx = (f: number) => c.x + f * c.w;
  const cy = (f: number) => c.y + f * c.h;
  const rB = c.w * 0.02;
  const yMid = cy(BAND.mid);
  const bottom = c.y + c.h;
  // Up the splayed left flank, over the flat top, down the right — and nothing across the
  // sides, because out there the moulding does not exist. Its walls run all the way DOWN to
  // the shell's bottom edge rather than tapering off into a full-width strip. Filling the
  // thin band beside them would put the bulky section back out to the corners, which is the
  // whole thing this shape exists to avoid.
  ctx.moveTo(cx(BAND.foot0), bottom);
  ctx.arcTo(cx(BAND.x0), yMid, cx(BAND.x1), yMid, rB);
  ctx.arcTo(cx(BAND.x1), yMid, cx(BAND.foot1), bottom, rB);
  ctx.lineTo(cx(BAND.foot1), bottom);
}

/** The window aperture. Square across the top, and along the bottom it follows `bandCrest` —
 *  the moulding is opaque, so the opening bends around it rather than being covered by it. */
export function windowPath(ctx: CanvasRenderingContext2D, c: Rect) {
  ctx.beginPath();
  windowOutline(ctx, c);
}

/** The same outline as a subpath, for when it has to share a path with something else. */
function windowOutline(ctx: CanvasRenderingContext2D, c: Rect) {
  const cx = (f: number) => c.x + f * c.w;
  const cy = (f: number) => c.y + f * c.h;
  const rT = c.w * 0.02;
  const rB = c.w * 0.02;
  const l = cx(WIN.x);
  const rt = cx(WIN.x + WIN.w);
  const t = cy(WIN.y);
  const ySide = cy(BAND.side);
  const yMid = cy(BAND.mid);

  ctx.moveTo(l + rT, t);
  ctx.lineTo(rt - rT, t);
  ctx.quadraticCurveTo(rt, t, rt, t + rT);
  ctx.lineTo(rt, ySide - rT);
  ctx.quadraticCurveTo(rt, ySide, rt - rT, ySide);
  // The moulding's own outline again, right to left this time — level out at the sides,
  // then up the splayed flank from wherever it crosses that level, over the top, and back
  // down the other one.
  ctx.lineTo(bandFoot(c, false), ySide);
  ctx.arcTo(cx(BAND.x1), yMid, cx(BAND.x0), yMid, rB);
  ctx.arcTo(cx(BAND.x0), yMid, bandFoot(c, true), ySide, rB);
  ctx.lineTo(bandFoot(c, true), ySide);
  ctx.lineTo(l + rT, ySide);
  ctx.quadraticCurveTo(l, ySide, l, ySide - rT);
  ctx.lineTo(l, t + rT);
  ctx.quadraticCurveTo(l, t, l + rT, t);
  ctx.closePath();
}

/** The moulding itself: the raised centre and nothing else, closed along the shell's bottom
 *  edge. Filled clipped to the shell, so its square bottom corners never show. */
function bandPath(ctx: CanvasRenderingContext2D, c: Rect) {
  ctx.beginPath();
  bandCrest(ctx, c);
  ctx.closePath();
}

/** The tape packs, hubs and the tape between them — the only part of the cassette that
 *  moves, and therefore the only part drawn every frame. */
/**
 * The transport itself — what is under a cassette, and what you see when the lid is open and
 * the well is empty.
 *
 * Drawn in the CASSETTE's own coordinates, so a caller hands it exactly the rect it hands
 * `drawReels` and the spindles come out where the hubs will sit. That is the whole reason it
 * lives here rather than in the walkman: the two have to line up, and a second set of
 * fractions in another file would drift out of register the first time either moved.
 */
export function drawMechanism(ctx: CanvasRenderingContext2D, c: Rect) {
  const px = (v: number) => v * c.w;
  const cx = (f: number) => c.x + f * c.w;
  const cy = (f: number) => c.y + f * c.h;

  // The bay floor: a dark moulding, lighter than the cavity so the parts read against it.
  ctx.fillStyle = "#1a1c20";
  rr(ctx, c.x, c.y, c.w, c.h, px(0.02));
  ctx.fill();

  // Two drive spindles, splined, standing proud of the floor.
  for (const fx of HUB_X) {
    const x = cx(fx);
    const y = cy(HUB_Y);
    const r = px(HUB_R * R_SCALE) * 0.62;
    ctx.fillStyle = "#0d0e10";
    ctx.beginPath();
    ctx.arc(x, y + r * 0.18, r * 1.25, 0, TAU);
    ctx.fill();
    // Dark grey, not brass. Gold made them the brightest, warmest thing in an otherwise
    // black bay, so the eye went straight to two ornaments instead of to the mechanism.
    const g = ctx.createRadialGradient(x - r * 0.4, y - r * 0.4, 0, x, y, r);
    g.addColorStop(0, "#6b7079");
    g.addColorStop(0.6, "#3c4046");
    g.addColorStop(1, "#171a1e");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "#101216";
    for (let k = 0; k < 6; k++) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate((k / 6) * TAU);
      ctx.fillRect(r * 0.3, -r * 0.11, r * 0.62, r * 0.22);
      ctx.restore();
    }
  }

  // The compartment lamp, and here it is the one place you see the whole of it: with the lid
  // open there is no tape in front of it and no shell edge cutting it off. Same panel as the
  // one behind the reels, brighter, because nothing is standing between it and you.
  wellLamp(ctx, c, 0.44);

  // The capstan: a thin polished rod up through the bay floor, standing exactly where the
  // cassette's right guide hole will be. It is not near that hole, it is IN it — the hole is
  // moulded for this rod to pass through, and the pinch roller closes on the far side to trap
  // the tape between the two. Both come off `OPENINGS` for that reason: a position of its own
  // puts the rod through solid plastic and leaves the roller pinching against nothing.
  const capX = cx(OPENINGS.postX[1]);
  const capY = cy(OPENINGS.postY);
  ctx.fillStyle = "#0f1114";
  ctx.beginPath();
  ctx.arc(capX, capY, px(OPENINGS.postR), 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#9aa0a9";
  ctx.beginPath();
  ctx.arc(capX, capY, px(OPENINGS.postR * 0.5), 0, TAU);
  ctx.fill();
  // Its twin on the left: the other guide post, which is a plain pin rather than a driven
  // shaft — the tape runs past it, nothing pinches against it.
  ctx.fillStyle = "#0f1114";
  ctx.beginPath();
  ctx.arc(cx(OPENINGS.postX[0]), capY, px(OPENINGS.postR), 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#6d737c";
  ctx.beginPath();
  ctx.arc(cx(OPENINGS.postX[0]), capY, px(OPENINGS.postR * 0.42), 0, TAU);
  ctx.fill();

  // The head carriage, at rest on the bay floor. It does not come forward until play is
  // pressed, but it is bolted to this plate the whole time — and an empty bay is the one view
  // in which the parts can be seen properly rather than as tips at the edge of a window,
  // which is what "idle with the lid open" looks like.
  //
  // Same floor and same gap as the loaded view, which is what BAY exists for: give this one a
  // fatter gap and the carriage jumps as the tape comes out. Only `reveal` differs — with no
  // cassette in front of it you see the parts' bodies rather than their tips, but they have
  // not moved a pixel.
  const bay = c.h * BAY;
  drawTransport(ctx, c, c.y + c.h + bay, bay, 0, c.h * 0.3);
}

/**
 * The compartment lamp: a frosted panel behind the tape, which every deck with a window had.
 *
 * Feathered by stacking the panel several times, each one a little larger and a little
 * fainter, because canvas has no blur for a fill and the alternatives all failed:
 *
 *   - a radial gradient inside a rounded rect leaves a hard rectangular edge wherever the
 *     falloff has not reached zero by the time it meets the rect;
 *   - a shadow drawn behind a visible rect softens only the outside — the panel itself stays
 *     a pasted rectangle;
 *   - casting ONLY a shadow, with the shape that throws it pushed off-screen and the offset
 *     bringing it back, does give a properly soft panel — but `shadowOffsetX/Y` are in canvas
 *     coordinates and are NOT put through the current transform. Under the walkman's quarter
 *     turn the caster moved one way and its shadow the other, and the lamp landed somewhere
 *     off in the chassis — correct on the deck, wrong on the walkman, from one code path.
 *
 * Stacking is transform-safe, which is what this has to be: both machines draw this through
 * their own matrix.
 */
export function wellLamp(ctx: CanvasRenderingContext2D, c: Rect, strength = 0.4) {
  const px = (v: number) => v * c.w;
  const lw = px(0.25);
  const lh = c.h * 0.34;
  const lx = c.x + c.w / 2 - lw / 2;
  const ly = c.y + HUB_Y * c.h - lh / 2;
  // A wide feather relative to the panel, so most of what you see is falloff. Tight, the
  // stack piles up to near-opaque in the middle and the lamp reads as a beige tile rather
  // than as something glowing.
  const feather = px(0.1);
  const rad = px(0.02);
  const N = 9;
  for (let i = N; i >= 0; i--) {
    const t = i / N; // 1 at the outermost, faintest ring
    const grow = feather * t;
    ctx.fillStyle = `rgba(255,236,203,${(strength / N) * (1 - t * 0.72)})`;
    rr(ctx, lx - grow, ly - grow, lw + grow * 2, lh + grow * 2, rad + grow);
    ctx.fill();
  }
}

export function drawReels(
  ctx: CanvasRenderingContext2D,
  c: Rect,
  s: DeckState,
  radii: {
    supplyR: number;
    takeupR: number;
  },
) {
  const px = (v: number) => v * c.w;
  const cx = (f: number) => c.x + f * c.w;
  const cy = (f: number) => c.y + f * c.h;

  ctx.save();
  // Everything the reels do is seen through the window; the shell hides the rest.
  windowPath(ctx, c);
  ctx.clip();

  // The cavity behind the tape. Squared off down to the lowest the aperture reaches — the
  // clip above is the real shape, so there is nothing to be gained by tracing it twice.
  const winH = (BAND.side - WIN.y) * c.h;
  ctx.fillStyle = "#0a0a0c";
  ctx.fillRect(cx(WIN.x), cy(WIN.y), px(WIN.w), winH);

  // The slip sheets — the pale antistatic liners between the tape packs and the shell walls.
  // They are the reason a cassette's window is never simply black behind the reels, and they
  // are creased on purpose: the ripples act as tiny springs that hold the packs steady, so
  // they catch light in bands rather than lying flat.
  const sheetTop = cy(WIN.y);
  const sheetH = winH;
  //
  // Kept dark. The first pass used paper white at 20% and turned the whole window into a
  // pale field the tape packs could barely be picked out of — but the liner is graphitized
  // film BEHIND the reels, so what it should do is lift the black slightly and catch a couple
  // of edges, not light the place up. Lighting the compartment is the lamp's job, below.
  const sheet = ctx.createLinearGradient(0, sheetTop, 0, sheetTop + sheetH);
  sheet.addColorStop(0, "rgba(150,148,140,0.13)");
  sheet.addColorStop(0.5, "rgba(120,119,114,0.08)");
  sheet.addColorStop(1, "rgba(86,86,84,0.10)");
  ctx.fillStyle = sheet;
  ctx.fillRect(cx(WIN.x), sheetTop, px(WIN.w), sheetH);
  ctx.strokeStyle = "rgba(226,222,210,0.07)";
  ctx.lineWidth = Math.max(0.6, px(0.004));
  for (const f of [0.22, 0.46, 0.72]) {
    ctx.beginPath();
    ctx.moveTo(cx(WIN.x), sheetTop + sheetH * f);
    ctx.lineTo(cx(WIN.x + WIN.w), sheetTop + sheetH * (f + 0.05));
    ctx.stroke();
  }

  // The compartment lamp: a small diffuser panel behind the tape, which every deck with a
  // window had and this one was missing. It is what the window is FOR — an unlit cavity
  // behind a smoked shell is a black rectangle, and the reels were being read off their own
  // shading alone. Warm, because it is a filament bulb behind frosted plastic.
  //
  // Drawn here rather than on the well floor because the cavity fill above would bury it,
  // and it belongs behind the packs: they are opaque, so the light comes through the gaps
  // around and between them, which is exactly how a lit compartment reads.
  wellLamp(ctx, c);

  const packs = [radii.supplyR, radii.takeupR];
  const angles = [s.supplyAngle, s.takeupAngle];

  for (let i = 0; i < 2; i++) {
    const x = cx(HUB_X[i]);
    const y = cy(HUB_Y);
    const rPack = px(packs[i] * R_SCALE);
    const rHub = px(HUB_R * R_SCALE);
    const ang = angles[i];

    // The tape pack: oxide brown, darker at the rim where it curves away.
    const g = ctx.createRadialGradient(x - rPack * 0.3, y - rPack * 0.35, rHub * 0.6, x, y, rPack);
    g.addColorStop(0, "#6b4a32");
    g.addColorStop(0.55, "#4a3122");
    g.addColorStop(1, "#241811");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, rPack, 0, TAU);
    ctx.fill();

    // No witness mark across the pack. There was a radial line here, added because a smooth
    // annulus turning is indistinguishable from a still one and something had to carry the
    // rotation. The hub's anchor slot does that job now — it is a real part, it turns with
    // everything else, and it is far more legible than a hairline drawn over the oxide.
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    // Wound tape has a visible grain: a few faint concentric bands catch the light and
    // sell the pack as a spiral rather than a disc.
    ctx.strokeStyle = "rgba(0,0,0,0.22)";
    ctx.lineWidth = Math.max(0.5, px(0.003));
    for (let k = 1; k <= 3; k++) {
      const rr2 = rHub + ((rPack - rHub) * k) / 4;
      ctx.beginPath();
      ctx.arc(0, 0, rr2, ang * 0.2, ang * 0.2 + Math.PI * 1.3);
      ctx.stroke();
    }
    ctx.restore();
  }

  // The tape leaving each pack. It comes off the BOTTOM of the pack heading outward, to a
  // guide roller in the shell's corner that turns it back the other way — which is why
  // both hubs turn clockwise even though the tape's net travel is left to right, and why
  // there is no tape visible spanning the middle of the window.
  // The tape path. It comes off the OUTER edge of each pack — the guides are in the bottom
  // corners, outboard of the hubs, so the tape has to clear the pack's widest point to
  // reach them — drops to a corner roller, and runs left-to-right along the bottom past the
  // head. That outer-edge departure is what makes both hubs turn anticlockwise; see the
  // note on SPIN in cassette.ts.
  //
  // The line to each roller is a real TANGENT to the pack, so it stands almost vertical
  // against a full pack and slants inward as that pack empties. A fixed line would have the
  // tape leaving the middle of the reel.
  const gx = [cx(GUIDE.x), cx(1 - GUIDE.x)];
  const gy = cy(GUIDE.y);
  const gr = px(GUIDE_R * R_SCALE);
  const tapeW = Math.max(1, px(0.008));

  ctx.strokeStyle = "#1d130d";
  ctx.lineWidth = tapeW;
  ctx.beginPath();
  for (let i = 0; i < 2; i++) {
    const cxi = cx(HUB_X[i]);
    const cyi = cy(HUB_Y);
    const r = px((i ? radii.takeupR : radii.supplyR) * R_SCALE);
    const dx = gx[i] - cxi;
    const dy = gy - cyi;
    const dist = Math.hypot(dx, dy);
    if (dist <= r) continue; // roller inside the pack — nothing sensible to draw
    // Two tangent points; take the outer one (leftmost for the supply, rightmost for the
    // take-up), which is the side the tape actually leaves from.
    const base = Math.atan2(dy, dx);
    const half = Math.acos(Math.min(1, r / dist));
    const cands = [base + half, base - half];
    const pick = cands.reduce((best, a) =>
      i === 0 ? (Math.cos(a) < Math.cos(best) ? a : best) : Math.cos(a) > Math.cos(best) ? a : best,
    );
    ctx.moveTo(cxi + Math.cos(pick) * r, cyi + Math.sin(pick) * r);
    ctx.lineTo(gx[i], gy);
    // The run past the head, at the rollers' underside. Its ends disappear under the rollers,
    // which is also what hides the corners the straight segments cut.
    ctx.moveTo(gx[0], gy + gr * 0.9);
    ctx.lineTo(gx[1], gy + gr * 0.9);
    ctx.stroke();

    // The rollers themselves: ivory nylon wheels, and the fastest thing in the mechanism —
    // a couple of millimetres of radius against the pack's twenty, so they blur along at
    // roughly three turns a second while the hubs creep round.
    for (const x of gx) {
      const g = ctx.createRadialGradient(x - gr * 0.4, gy - gr * 0.4, 0, x, gy, gr);
      g.addColorStop(0, "#f2efe6");
      g.addColorStop(0.7, "#cbc7ba");
      g.addColorStop(1, "#8e8b80");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, gy, gr, 0, TAU);
      ctx.fill();
      ctx.save();
      ctx.translate(x, gy);
      ctx.rotate(s.guideAngle);
      ctx.strokeStyle = "rgba(60,54,44,0.75)";
      ctx.lineWidth = Math.max(0.6, gr * 0.22);
      ctx.beginPath();
      ctx.moveTo(-gr * 0.75, 0);
      ctx.lineTo(gr * 0.75, 0);
      ctx.stroke();
      ctx.restore();
    }
  }

  // The hubs and their leader, in a SECOND pass — after the tape path, so they sit on top.
  //
  // The tape leaves a nearly-empty pack from a tangent point millimetres off the hub, so a
  // line of tape-thickness drawn afterwards crossed the hub's rim and its teeth. Drawing
  // the reel over the tape is both the easy fix and the true one: the flange stands proud
  // of the pack, so the tape passes BEHIND it.
  //
  // The LEADER belongs in this pass too: it is wound a whisker outside the hub, so moving
  // only the hub leaves a ring of pale polyester for the tape to cross instead — the same
  // defect a millimetre further out.
  for (let i = 0; i < 2; i++) {
    const x = cx(HUB_X[i]);
    const y = cy(HUB_Y);
    const rHub = px(HUB_R * R_SCALE);
    const ang = angles[i];
    // The leader: the clear polyester spliced onto both ends of the magnetic tape, which is
    // what gets anchored to the hub — so the innermost wraps on BOTH reels are leader, not
    // oxide, and they read as a pale ring at the core whatever the pack is doing.
    ctx.strokeStyle = "rgba(226,222,210,0.5)";
    ctx.lineWidth = Math.max(0.8, rHub * 0.13);
    ctx.beginPath();
    ctx.arc(x, y, rHub * 1.07, 0, TAU);
    ctx.stroke();
    // The hub: a splined plastic ring. Six teeth, and they are what the eye actually
    // tracks — the pack is nearly uniform, the teeth are not.
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    const hg = ctx.createRadialGradient(-rHub * 0.3, -rHub * 0.3, 0, 0, 0, rHub);
    hg.addColorStop(0, "#dfe3ea");
    hg.addColorStop(0.7, "#a7adb8");
    hg.addColorStop(1, "#767c88");
    ctx.fillStyle = hg;
    ctx.beginPath();
    ctx.arc(0, 0, rHub, 0, TAU);
    ctx.fill();
    // The spindle bore, with the drive teeth standing into it.
    ctx.fillStyle = "#141519";
    ctx.beginPath();
    ctx.arc(0, 0, rHub * 0.62, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "#9aa0ab";
    for (let k = 0; k < 6; k++) {
      ctx.save();
      ctx.rotate((k / 6) * TAU);
      ctx.fillRect(rHub * 0.34, -rHub * 0.09, rHub * 0.3, rHub * 0.18);
      ctx.restore();
    }
    // The anchor slot: the C-clamp that pins the leader's end into the hub. One notch in the
    // rim, and it turns with everything else — a second thing on the hub for the eye to
    // track, which is worth having when the pack itself is nearly featureless.
    ctx.fillStyle = "#2b2f36";
    ctx.fillRect(rHub * 0.66, -rHub * 0.16, rHub * 0.34, rHub * 0.32);
    ctx.restore();
  }

  ctx.restore();
}

/**
 * The head carriage coming up into the cassette.
 *
 * WHERE it is drawn is the whole problem. The openings the head goes through are cut into
 * the shell's BOTTOM EDGE, and this view is of the label face — so a head rising into a
 * window drawn on that face is a head coming up through the plastic, which could never touch
 * the tape. Same trap as the pressure pad; see the note in `paintCassette`.
 *
 * What a front-loading deck actually shows you is the strip of bay between the bottom of the
 * cassette and the floor of the well. The carriage rises in THAT, and its tips vanish into
 * the shell's bottom edge — so this is drawn BEFORE the cassette is blitted over the well,
 * and the shell occluding the parts is what sells them as going inside it rather than
 * sitting in front of it.
 *
 * Three parts, and only two of them move:
 *
 *   - the ERASE head is left of centre and stays parked. It comes up to record, and nothing
 *     here records — the same reason the REC key is inert. Drawn all the same: the one that
 *     stays down is what makes the other two read as having moved.
 *   - the RECORD/PLAY head rises in the middle.
 *   - the PINCH ROLLER rises on the right, and is a WHEEL, not a post. Its axle points at
 *     you, so what you see below the cassette is the bottom of a rubber tyre — the first
 *     version drew it as a rod, which is the capstan's shape, not the roller's.
 */
export function drawTransport(
  ctx: CanvasRenderingContext2D,
  c: Rect,
  /** The bottom of the strip the parts are seen in, and how tall it is. Given rather than
   *  derived, because the two views of this mechanism disagree about both: with a cassette
   *  loaded the strip is the sliver between the shell and the well's floor, and with the lid
   *  open it is a generous band of empty bay with nothing standing in front of it. */
  floor: number,
  gap: number,
  engage: number,
  /** How far ABOVE the floor the parts may be seen, when that differs from `gap`.
   *
   *  `gap` is geometry — it sizes the parts and sets where they sit — and must be identical
   *  in both views or the carriage jumps when the tape comes out. This is only how much of
   *  the result is visible: with a cassette loaded the shell hides everything above the bay,
   *  and with the well empty there is nothing to hide it, so the same parts in the same
   *  places simply show more of themselves. */
  reveal = gap,
) {
  const up = Number.isFinite(engage) ? Math.min(1, Math.max(0, engage)) : 0;
  const top = floor - gap;
  if (gap <= 1) return; // no bay showing — nothing to rise in

  const parts: [{ x: number; w: number }, number, "erase" | "head" | "pinch"][] = [
    [TRANSPORT.erase, 0, "erase"],
    [TRANSPORT.head, up, "head"],
    [TRANSPORT.pinch, up, "pinch"],
  ];

  ctx.save();
  // Down to the bay's floor and no further; the shell above will do the other end.
  ctx.beginPath();
  ctx.rect(c.x - c.w, floor - reveal, c.w * 3, reveal);
  ctx.clip();

  const mix = (a: number, b: number, t: number) => a + (b - a) * t;

  for (const [o, lift, kind] of parts) {
    const w = c.w * o.w * 0.92;
    const x = c.x + o.x * c.w - w / 2;
    // Parked, the crown just clears the bay's floor; engaged, it has gone up past the
    // shell's bottom edge and is cut off by it — which is what "into the cassette" looks
    // like from the front.
    //
    // A few millimetres, which is all a real carriage moves — but it has to END somewhere
    // past the shell's bottom edge, or the head goes up, stops in the open bay and touches
    // nothing. That is a constraint on the WELL rather than on the travel: with a bay only a
    // couple of millimetres deep, a couple of millimetres of throw puts the head inside the
    // cassette where it belongs.
    //
    // The head slides. The ROLLER does not — see below.
    //
    // The block runs a long way past the bay's floor so its own bottom edge is never in
    // shot. At exactly a bay's height it rises to reveal a rectangle with daylight under it,
    // which reads as a tile floating in the opening rather than as the top of something
    // standing up out of the machine.
    const h = gap * 3.2;
    const y = floor - gap * 0.22 - gap * 1.05 * lift;

    if (kind === "pinch") {
      // A rubber tyre on a pressed-steel yoke. A circle, because the axle points at the
      // viewer — a rod would be the capstan's shape, not this one's.
      const rad = Math.max(2, w / 2);
      const ccx = x + w / 2;
      // Parked, the tyre is nearly all below the bay's floor with its crown just breaking
      // it — the same story as the head, and for the same reason.
      const ccy = floor + rad * 0.85;

      // The roller PIVOTS. It is pinned to the end of an arm and the arm turns on a bearing
      // off to its right, so the tyre comes up on an arc and the yoke visibly tilts as it
      // goes. Slid straight up it reads as a wheel pushed AT the capstan rather than swung
      // onto it, and the tilt is most of what says there is a lever in there at all.
      ctx.save();
      const pivotX = ccx + rad * 2.4;
      const pivotY = ccy + rad * 0.5;
      ctx.translate(pivotX, pivotY);
      ctx.rotate(lift * PINCH_SWING);
      ctx.translate(-pivotX, -pivotY);

      // The yoke first, so the tyre sits in it. It is a plate the roller is pinned through,
      // carrying on to the right as the arm that swings it against the capstan — and that
      // arm is why the part reads as sprung against something rather than as a loose wheel.
      ctx.fillStyle = "#767c86";
      rr(ctx, ccx, ccy - rad * 0.62, rad * 2.1, rad * 1.24, rad * 0.3);
      ctx.fill();
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      rr(ctx, ccx + rad * 1.05, ccy - rad * 0.16, rad * 0.7, rad * 0.34, rad * 0.1);
      ctx.fill();

      const rg = ctx.createRadialGradient(
        ccx - rad * 0.35,
        ccy - rad * 0.4,
        rad * 0.05,
        ccx,
        ccy,
        rad,
      );
      rg.addColorStop(0, "#33363c");
      rg.addColorStop(0.55, "#141619");
      rg.addColorStop(1, "#08090b");
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(ccx, ccy, rad, 0, TAU);
      ctx.fill();
      // A lit crescent on the tyre's shoulder, then the pin it turns on.
      ctx.strokeStyle = "rgba(255,255,255,0.13)";
      ctx.lineWidth = Math.max(1, rad * 0.09);
      ctx.beginPath();
      ctx.arc(ccx, ccy, rad * 0.86, Math.PI * 1.05, Math.PI * 1.75);
      ctx.stroke();
      ctx.fillStyle = "#8f959f";
      ctx.beginPath();
      ctx.arc(ccx, ccy, Math.max(1, rad * 0.17), 0, TAU);
      ctx.fill();
      ctx.restore();
    } else {
      // The erase head is on a swing arm too, mirrored about the deck's centre — the same
      // linkage as the pinch roller's, reaching the other way. Drawn even though nothing
      // moves it here: a part on a pivot that has no pivot looks like it was glued on.
      if (kind === "erase") {
        ctx.fillStyle = "#767c86";
        rr(ctx, x + w * 0.5 - w * 2.1, y + gap * 0.1, w * 2.1, gap * 1.2, w * 0.3);
        ctx.fill();
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        rr(ctx, x - w * 1.75, y + gap * 0.45, w * 0.7, gap * 0.34, w * 0.1);
        ctx.fill();
      }

      // A head: a chromed block with a polished face and, down its middle, the gap between
      // the two pole pieces. That hairline IS the head — it is the gap the tape's field
      // crosses — so it is drawn even at sizes where it comes out one pixel wide.
      // Kept well down the scale: a head is polished, but it is polished metal at the bottom
      // of an unlit bay behind a smoked door. At its true chrome it is the brightest thing on
      // the deck, which is not where the eye belongs.
      const hg = ctx.createLinearGradient(x, 0, x + w, 0);
      hg.addColorStop(0, "#4e535c");
      hg.addColorStop(0.28, "#8d939f");
      hg.addColorStop(0.62, "#5b606a");
      hg.addColorStop(1, "#35393f");
      ctx.fillStyle = hg;
      rr(ctx, x, y, w, h, w * 0.16);
      ctx.fill();
      ctx.fillStyle = "rgba(18,20,24,0.85)";
      ctx.fillRect(x + w * 0.47, y, Math.max(1, w * 0.06), h);
      // The erase head is the odd one out in colour too: ferrite in a moulded holder rather
      // than a polished block, which on these machines was usually a coloured plastic.
      if (kind === "erase") {
        ctx.fillStyle = "rgba(40,86,120,0.55)";
        rr(ctx, x, y + gap * 0.16, w, h, w * 0.16);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

/** The shell and its paper, baked to an offscreen: this changes only when the tape does.
 *  The window is left TRANSPARENT so the reels drawn underneath show through it, and the
 *  body is drawn at less than full opacity so they also ghost faintly through the smoked
 *  plastic — which is what a 90s premium shell actually looked like. */
export function paintCassette(
  ctx: CanvasRenderingContext2D,
  c: Rect,
  title: string,
  artist: string,
  side: "A" | "B",
  seed: number,
) {
  const stock = labelStock(seed);
  const px = (v: number) => v * c.w;
  const cx = (f: number) => c.x + f * c.w;
  const cy = (f: number) => c.y + f * c.h;
  const r = px(0.022);

  // The body. Drawn as a single path with the window as a counter-wound hole, so one fill
  // leaves the window clear instead of needing a punch-out pass.
  //
  // Not quite opaque on the smoke shell, which is what makes it smoke: the packs sitting
  // behind it ghost through the plastic outside the window. The ivory one is opaque, and
  // has to be — white plastic with the reels showing through it does not read as
  // translucent, it reads as dirty.
  ctx.save();
  ctx.globalAlpha = currentTheme() === "light" ? 1 : 0.9;
  const bg = ctx.createLinearGradient(0, c.y, 0, c.y + c.h);
  bg.addColorStop(0, INK.shellHi);
  bg.addColorStop(0.45, INK.shellMid);
  bg.addColorStop(1, INK.shellLo);
  ctx.fillStyle = bg;

  // The guide lugs first, so the body's own edge lands on top of them and they read as part
  // of the moulding rather than as two things stuck to it.
  //
  // These are what actually locates a cassette in a deck: the shell is a loose fit in the
  // well, and it is these two ribs on the short sides that the mechanism's jaws close on to
  // pull it square and hold it there. Drawn a shade darker because they are a side face
  // turned away from the room's light.
  const lugY = c.y + c.h * LUG.y;
  const lugH = c.h * LUG.h;
  const lugW = px(LUG.w);
  ctx.save();
  ctx.globalAlpha *= 0.86;
  rr(ctx, c.x - lugW, lugY, lugW + r, lugH, lugW * 0.5);
  ctx.fill();
  rr(ctx, c.x + c.w - r, lugY, lugW + r, lugH, lugW * 0.5);
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  rr(ctx, c.x, c.y, c.w, c.h, r);
  ctx.fill();
  ctx.restore();

  // Punch the window back out. Its bottom edge is the moulding's crest, so the moulding is
  // left standing as solid shell rather than being painted back over the opening afterwards.
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  windowPath(ctx, c);
  ctx.fill();
  ctx.restore();

  // Shell edge: a lit top-left bevel and a dark bottom-right one.
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = Math.max(1, px(0.004));
  rr(ctx, c.x + 0.5, c.y + 0.5, c.w - 1, c.h - 1, r);
  ctx.stroke();

  // The window's own rim, so the opening reads as a moulded aperture.
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.lineWidth = Math.max(1, px(0.006));
  windowPath(ctx, c);
  ctx.stroke();
  // A hairline of light just OUTSIDE it. The aperture is not a rectangle any more, so this is
  // the outline stroked double-width and clipped to the shell side of itself — an outward
  // offset that follows the bends, which nudging a copy of the path by a pixel would not.
  ctx.save();
  ctx.beginPath();
  ctx.rect(c.x, c.y, c.w, c.h);
  windowOutline(ctx, c);
  ctx.clip("evenodd");
  ctx.strokeStyle = INK.edgeHi;
  ctx.lineWidth = 2;
  windowPath(ctx, c);
  ctx.stroke();
  ctx.restore();

  // ── the paper inlay ──
  const lx = cx(LBL.x);
  const ly = cy(LBL.y);
  const lw = px(LBL.w);
  const lh = LBL.h * c.h;
  ctx.fillStyle = stock.paper;
  rr(ctx, lx, ly, lw, lh, px(0.006));
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Brand band across the top of the label, with the grade printed in it — the part of a
  // blank tape that was already filled in when you bought it.
  const bandH = lh * 0.3;
  ctx.fillStyle = stock.band;
  ctx.fillRect(lx, ly, lw, bandH);
  ctx.fillStyle = stock.accent;
  ctx.fillRect(lx, ly + bandH - Math.max(1, px(0.004)), lw, Math.max(1, px(0.004)));

  // Side letter, in its box at the left of the band.
  const sideW = bandH * 0.85;
  ctx.fillStyle = stock.accent;
  rr(ctx, lx + lh * 0.09, ly + bandH * 0.12, sideW, bandH * 0.76, px(0.004));
  ctx.fill();
  label(
    ctx,
    side,
    lx + lh * 0.09 + sideW / 2,
    ly + bandH * 0.5,
    bandH * 0.56,
    stock.band,
    "center",
  );

  label(
    ctx,
    "TYPE II  HIGH POSITION",
    lx + lw - lh * 0.09,
    ly + bandH * 0.5,
    Math.max(4, bandH * 0.34),
    stock.accent,
    "right",
  );

  // The two ruled lines, and what somebody wrote on them.
  const wx = lx + lw * 0.045;
  const ww = lw * 0.91;
  const row1 = ly + bandH + (lh - bandH) * 0.34;
  const row2 = ly + bandH + (lh - bandH) * 0.74;
  ctx.strokeStyle = "rgba(0,0,0,0.14)";
  ctx.lineWidth = 1;
  for (const ry of [row1, row2]) {
    ctx.beginPath();
    ctx.moveTo(wx, ry + (lh - bandH) * 0.2);
    ctx.lineTo(wx + ww, ry + (lh - bandH) * 0.2);
    ctx.stroke();
  }
  const titlePx = Math.max(6, (lh - bandH) * 0.46);
  const artistPx = Math.max(5, (lh - bandH) * 0.32);
  label(ctx, fitted(ctx, title || "—", ww, titlePx), wx, row1, titlePx, stock.ink);
  ctx.globalAlpha = 0.72;
  label(ctx, fitted(ctx, artist || "", ww, artistPx), wx, row2, artistPx, stock.ink);
  ctx.globalAlpha = 1;

  // Nothing along the bottom edge.
  //
  // There were three dark openings here for the erase head, the record/playback head and the
  // capstan to reach through — correctly placed, as it happens: mapping the Wikimedia
  // schematic put the capstan at 74.8mm across, right where the third one was. They came out
  // for the same reason as the pressure pad and the write-protect tabs. Those openings are
  // cut into the shell's bottom EDGE, this view is of the label face, and the plastic in
  // front of them is not transparent — so three dark rectangles sitting on it were three
  // holes painted onto a solid surface.
  //
  // The mechanism they exist for is still drawn, in drawMechanism, where it belongs: visible
  // through the door when the lid is up and the tape is out.

  // No pressure pad. It was drawn here — felt on a copper leaf spring, in the centre
  // opening — because it is one of the parts the article lists and one the sound genuinely
  // depends on. It came out because it cannot be seen from this angle: these openings are
  // cut into the shell's bottom EDGE, and this view is of the label face, so what is behind
  // them here is opaque plastic. A part drawn where it could not be looked at reads as a
  // sticker, which is the opposite of what all this detail is for. (The spring was also
  // bowing the wrong way, which is how it got noticed.)

  // No write-protect tabs either, and for the same reason as the pressure pad: they are
  // recesses in the shell's REAR top edge, and this is the label face. Drawn on the front
  // they were two marks on opaque plastic with nothing behind them.

  // The bulkier bottom moulding.
  //
  // A cassette is not one flat slab: the label face is a thin front panel, and below it the
  // shell thickens into a separate, deeper section that the deck's mechanism presses into —
  // the head, the capstan and pinch roller, the guide pins, the sensors. On a real one it
  // stands visibly proud of the label face, with a shoulder where the two meet and a row of
  // round holes through it for the posts to pass.
  //
  // It is opaque and solid — no window over it — so the aperture bends around it instead of
  // being covered by it: straight down at the shell's corners, where there is no thick
  // section at all, and up over the trapezoid across the middle. That is `BAND`, and
  // `windowPath` shares the same outline, so the two edges are one edge and cannot drift.
  const bandTop = cy(BAND.mid);
  const bandDepth = c.y + c.h - bandTop;
  ctx.save();
  rr(ctx, c.x, c.y, c.w, c.h, r);
  ctx.clip();
  const bandG = ctx.createLinearGradient(0, bandTop, 0, c.y + c.h);
  bandG.addColorStop(0, INK.mouldHi);
  bandG.addColorStop(0.35, INK.mouldMid);
  bandG.addColorStop(1, INK.mouldLo);
  ctx.fillStyle = bandG;
  bandPath(ctx, c);
  ctx.fill();
  // The shoulder: a shadow outside the moulding and a lit edge on the moulding itself, which
  // is what makes one read as standing in front of the other rather than as a painted line.
  // Both follow the crest, so they turn its corners and run down its flanks with it.
  ctx.lineWidth = Math.max(1, px(0.004));
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.beginPath();
  bandCrest(ctx, c);
  ctx.stroke();
  // Clipped to the moulding rather than nudged down by a pixel: the crest turns two right
  // angles now, and a translate only offsets the horizontal part of it correctly.
  ctx.save();
  bandPath(ctx, c);
  ctx.clip();
  ctx.strokeStyle = "rgba(255,255,255,0.13)";
  ctx.lineWidth = Math.max(2, px(0.006));
  ctx.beginPath();
  bandCrest(ctx, c);
  ctx.stroke();
  ctx.restore();
  ctx.restore();

  // The openings through it — see OPENINGS. Round holes for the guide posts, out at the tape
  // line, and three rectangular windows for the transport itself.
  ctx.fillStyle = "#08090b";
  for (const fx of OPENINGS.postX) {
    ctx.beginPath();
    ctx.arc(cx(fx), cy(OPENINGS.postY), px(OPENINGS.postR), 0, TAU);
    ctx.fill();
  }
  for (const fx of OPENINGS.slotX) {
    const sw = px(OPENINGS.slotW);
    const sh = px(OPENINGS.slotH);
    rr(ctx, cx(fx) - sw / 2, cy(OPENINGS.slotY) - sh / 2, sw, sh, px(0.004));
    ctx.fill();
  }
  // A lit lip along the top inside of each, so they read as holes through something thick
  // rather than as marks printed on it.
  ctx.strokeStyle = "rgba(255,255,255,0.09)";
  ctx.lineWidth = 1;
  for (const fx of OPENINGS.postX) {
    const hr = px(OPENINGS.postR);
    ctx.beginPath();
    ctx.arc(cx(fx), cy(OPENINGS.postY) - hr * 0.1, hr * 0.92, Math.PI * 1.1, Math.PI * 1.9);
    ctx.stroke();
  }
  for (const fx of OPENINGS.slotX) {
    const sw = px(OPENINGS.slotW);
    ctx.beginPath();
    ctx.moveTo(cx(fx) - sw * 0.4, cy(OPENINGS.slotY) - px(OPENINGS.slotH) * 0.34);
    ctx.lineTo(cx(fx) + sw * 0.4, cy(OPENINGS.slotY) - px(OPENINGS.slotH) * 0.34);
    ctx.stroke();
  }

  // A single soft specular running across the plastic.
  const sg = ctx.createLinearGradient(c.x, c.y, c.x + c.w * 0.7, c.y + c.h);
  sg.addColorStop(0, INK.edgeHi);
  sg.addColorStop(0.35, "rgba(255,255,255,0.02)");
  sg.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = sg;
  rr(ctx, c.x, c.y, c.w, c.h, r);
  ctx.fill();
}

export function paintKnob(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  angle: number,
) {
  const g = ctx.createLinearGradient(x, y - r, x, y + r);
  g.addColorStop(0, INK.keyTop);
  g.addColorStop(0.5, INK.keyMid);
  g.addColorStop(1, INK.keyBot);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.7)";
  ctx.lineWidth = Math.max(1, r * 0.06);
  ctx.stroke();
  // Knurled rim.
  ctx.strokeStyle = INK.edgeHi;
  ctx.lineWidth = 1;
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * TAU;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * r * 0.86, y + Math.sin(a) * r * 0.86);
    ctx.lineTo(x + Math.cos(a) * r * 0.98, y + Math.sin(a) * r * 0.98);
    ctx.stroke();
  }
  // The pointer dimple.
  ctx.fillStyle = INK.trimHi;
  ctx.beginPath();
  ctx.arc(x + Math.cos(angle) * r * 0.6, y + Math.sin(angle) * r * 0.6, r * 0.11, 0, TAU);
  ctx.fill();
  const hl = ctx.createRadialGradient(x - r * 0.35, y - r * 0.45, 0, x, y, r);
  hl.addColorStop(0, "rgba(255,255,255,0.16)");
  hl.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = hl;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
}

/** The six piano keys, in the order they sat on the front of every deck: REC, REW, FF,
 *  PAUSE, PLAY, STOP. Every one of them is wired to something the player can actually do
 *  — rewind and fast-forward reach the previous and next track, which is what they were
 *  for — except REC, which has nothing to record. */
export const KEYS: { id: HifiButtonId; glyph: string; label: string; inert?: boolean }[] = [
  { id: "rec", glyph: "⏺", label: "Record (not wired — nothing here records)", inert: true },
  { id: "rew", glyph: "◀◀", label: "Previous track" },
  { id: "ff", glyph: "▶▶", label: "Next track" },
  { id: "pause", glyph: "❚❚", label: "Pause" },
  { id: "play", glyph: "▶", label: "Play" },
  { id: "stop", glyph: "■", label: "Stop" },
];

/** Key rects inside the row, so the layout and the painter agree on where each one is. */
export function keyRects(r: Rect): Rect[] {
  const n = KEYS.length;
  const gap = r.w * 0.02;
  const kw = (r.w - gap * (n - 1)) / n;
  return KEYS.map((_, i) => ({ x: r.x + i * (kw + gap), y: r.y, w: kw, h: r.h }));
}

export function paintKeys(ctx: CanvasRenderingContext2D, r: Rect) {
  keyRects(r).forEach((k, i) => {
    const g = ctx.createLinearGradient(0, k.y, 0, k.y + k.h);
    g.addColorStop(0, INK.keyTop);
    g.addColorStop(0.55, INK.keyMid);
    g.addColorStop(1, INK.keyBot);
    ctx.fillStyle = g;
    rr(ctx, k.x, k.y, k.w, k.h, Math.max(1, k.w * 0.1));
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.75)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = INK.edgeHi;
    ctx.fillRect(k.x + k.w * 0.12, k.y + 1, k.w * 0.76, 1);
    ctx.globalAlpha = KEYS[i].inert ? 0.45 : 1;
    label(
      ctx,
      KEYS[i].glyph,
      k.x + k.w / 2,
      k.y + k.h * 0.55,
      Math.max(5, Math.min(k.w * 0.42, k.h * 0.42)),
      KEYS[i].id === "rec" ? "#b05248" : INK.print,
      "center",
    );
    ctx.globalAlpha = 1;
  });
}

/** A key that is being held down: the cap sinks and its lit top edge goes out. Drawn over
 *  the cached chassis rather than baked into it, since it changes per frame. */
export function paintPressed(ctx: CanvasRenderingContext2D, r: Rect) {
  ctx.save();
  const g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
  g.addColorStop(0, INK.keyBot);
  g.addColorStop(0.6, INK.keyMid);
  g.addColorStop(1, INK.keyTop);
  ctx.fillStyle = g;
  rr(ctx, r.x, r.y, r.w, r.h, Math.max(1, Math.min(r.w, r.h) * 0.1));
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

export function lamp(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
  on: number,
) {
  const v = Math.max(0, Math.min(1, on));
  ctx.save();
  ctx.globalAlpha = 0.25 + v * 0.75;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  if (v > 0.02) {
    const g = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 4);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = v * 0.35;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r * 4, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}
