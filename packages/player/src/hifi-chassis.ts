// The separates stack: an amplifier over a cassette deck, a speaker either side when the
// pane is wide enough to stand them there. The portrait alternative — a personal stereo with
// the same cassette stood on its short edge — lives in hifi-walkman.ts; what the two chassis
// have in common is in hifi-parts.ts.
//
// Only the cassette moves. Everything else is a machined object that sits there, so it is
// rendered ONCE into offscreen canvases and blitted: the chassis (cabinets, faceplates,
// silkscreen, knobs, keys, grilles) on resize, and the cassette's own shell and label when
// the track changes. Per frame this leaves the two tape packs, the door, two meter needles
// and a handful of lamps — which is what keeps a scene with this much surface detail in it
// affordable next to the shader visualisers.
import { accentColor } from "./accent";
import { type DeckState, reelState } from "./cassette";
import {
  brushed,
  CASS_ASPECT,
  type ChassisTheme,
  currentTheme,
  drawMechanism,
  drawReels,
  drawTransport,
  type HifiButton,
  type HifiButtonId,
  INK,
  KEYS,
  keyRects,
  label,
  lamp,
  paintCassette,
  paintGrille,
  paintKeys,
  paintKnob,
  paintPressed,
  type Rect,
  rr,
  setChassisTheme,
  TAU,
  trimLine,
} from "./hifi-parts";
import {
  drawWalkmanFrame,
  layoutWalkman,
  paintWalkmanStill,
  paintWalkmanTape,
  type WalkmanLayout,
} from "./hifi-walkman";
import type { PanelSize } from "./vfd-face";
import { drawVuMeter, vuEase } from "./vu-meter";

export type { HifiButton, HifiButtonId, Rect, WalkmanLayout };
export { layoutWalkman };

export type HifiLayout = {
  /** The amplifier's faceplate. */
  amp: Rect;
  /** The display cutout in it — where the VFD canvas is parked, in CSS pixels. */
  glass: Rect;
  /** The cassette deck's faceplate. */
  deck: Rect;
  /** The door opening. */
  well: Rect;
  /** The cassette behind it. */
  cass: Rect;
  /** The control column beside the door: knobs, the Dolby rule, the lamps, the keys. Kept
   *  level with the door rather than pinned to the faceplate, so a tall pane grows the
   *  margins instead of pulling the two halves apart. */
  ctl: Rect;
  /** The transport key row, inside `ctl`. */
  keys: Rect;
  /** The two VU meters, where a deck's twin dials went. */
  meters: [Rect, Rect];
  /** The volume knob: centre and radius. Turns with the master level, so it is drawn per
   *  frame and carries a real slider on top of it. */
  volume: { x: number; y: number; r: number };
  /** The lamp cluster on the deck's rule — L peak, R peak, play — as centre + radius.
   *  Here rather than in the painter because both passes need it (the dark bezels are
   *  cached, the light is not). */
  lamps: { x: number; y: number; r: number }[];
  /** Everything pressable, for the component to lay real controls over. */
  buttons: HifiButton[];
  /** Speaker cabinets, or null on a pane too narrow to stand them beside the stack. */
  speakers: [Rect, Rect] | null;
};

export type ChassisInput = {
  deck: DeckState;
  title: string;
  artist: string;
  /** Which side is up — flipped per queue position, like a tape you turn over. */
  side: "A" | "B";
  /** Picks the label's brand colours, so a track keeps its own tape between plays. */
  seed: number;
  bass: number;
  mid: number;
  treble: number;
  playing: boolean;
  paused: boolean;
  /** Meter deflection and peak lamps, 0..1 per channel. */
  peakL: number;
  peakR: number;
  /** Which control is being held down, so its cap can sink. */
  pressed: HifiButtonId | null;
  /** Master level, 0..1 — where the volume knob is pointing. */
  volume: number;
  /** The walkman's HOLD switch. Ignored by the stack, which has no such thing. */
  hold: boolean;
  /** Whether the speakers are wearing their grille covers. Only the stack has speakers. */
  grilles: boolean;
  /** Whether there is a cassette in the well at all. False between pressing EJECT and
   *  pressing PLAY again, which is the one state this machine has that the player doesn't:
   *  a track is still selected, it just isn't in the deck. */
  loaded: boolean;
  /** Whether the display is switched on. The chassis needs this as well as the panel does:
   *  the tube's light falls on the metal around it, and that metal is the chassis's to draw. */
  powered: boolean;
};

export function layoutHifi(w: number, h: number): HifiLayout {
  const pad = Math.max(6, Math.min(w, h) * 0.04);
  const inner: Rect = { x: pad, y: pad, w: Math.max(1, w - pad * 2), h: Math.max(1, h - pad * 2) };

  // Speakers only when there is width for them to read as cabinets rather than slivers.
  const wide = w / h >= 1.5 && w >= 560;
  const gap = inner.w * 0.022;
  const spkW = wide ? inner.w * 0.185 : 0;
  const stackW = wide ? inner.w - (spkW + gap) * 2 : inner.w;
  const stackX = inner.x + (wide ? spkW + gap : 0);

  // 34% amplifier, the rest deck — the ratio a tuner-amp over a single-well deck had.
  // Both heights are capped against the stack's WIDTH, so the stack's proportions stay
  // constant at any pane shape; a tall pane gets dark room above and below instead.
  const seam = Math.max(2, inner.h * 0.008);
  const ampH = Math.min((inner.h - seam) * 0.34, stackW * 0.26);
  const deckH = Math.min(inner.h - seam - ampH, stackW * 0.55);
  // Centred in whatever is left. Speakers still run the full height — a mini system's
  // cabinets standing taller than the stack between them is what one looked like.
  const stackY = inner.y + Math.max(0, (inner.h - (ampH + seam + deckH)) / 2);
  const amp: Rect = { x: stackX, y: stackY, w: stackW, h: ampH };
  const deck: Rect = { x: stackX, y: stackY + ampH + seam, w: stackW, h: deckH };

  // The display window keeps the panel's own ~4.6:1 proportion rather than filling
  // whatever space is going: the VFD core letterboxes its frame inside the canvas it is
  // given, so an over-tall cutout would just draw bezel above and below the plate.
  const glassW = amp.w * 0.55;
  const glassH = Math.min(amp.h * 0.62, glassW / 4.6);
  const glass: Rect = {
    // Clear of the power button and its legend on the left — a display recess overlapping
    // a silkscreen label is the one thing a real faceplate never does.
    x: amp.x + amp.w * 0.105,
    y: amp.y + (amp.h - glassH) / 2,
    w: glassW,
    h: glassH,
  };

  // The well takes the left of the deck, the controls the right, sized FROM the cassette
  // outward rather than as a fraction of the faceplate. The head band is reserved for the
  // model name and the foot band for the eject key; the door is centred in what is left.
  const deckHead = Math.min(deck.h * 0.14, deck.w * 0.05);
  const deckFoot = Math.min(deck.h * 0.1, deck.w * 0.04);
  const cw = Math.min(deck.w * 0.54 * 0.92, (deck.h - deckHead - deckFoot) * 0.92 * CASS_ASPECT);
  const ch = cw / CASS_ASPECT;
  // Working clearance around the shell, plus a bay strip below it where the head carriage
  // rises (see drawTransport). The bay stays shallow: the opening is what HIDES the
  // mechanism, and one deep enough to show a whole part leaves the deck's guts on show.
  const clear = cw * 0.032;
  const bayH = clear;
  const wellH = ch + clear + bayH;
  const well: Rect = {
    x: deck.x + deck.w * 0.05,
    y: deck.y + deckHead + (deck.h - deckHead - deckFoot - wellH) / 2,
    w: cw + clear * 2,
    h: wellH,
  };
  const cass: Rect = { x: well.x + clear, y: well.y + clear, w: cw, h: ch };

  const ctl: Rect = {
    x: deck.x + deck.w * 0.62,
    y: well.y,
    w: deck.w * 0.33,
    h: well.h,
  };
  const keys: Rect = {
    x: ctl.x,
    y: ctl.y + ctl.h * 0.62,
    w: ctl.w,
    h: Math.min(ctl.h * 0.3, ctl.w * 0.26),
  };

  const mH = ctl.h * 0.36;
  const mW = ctl.w * 0.47;
  const meters: [Rect, Rect] = [
    { x: ctl.x, y: ctl.y, w: mW, h: mH },
    { x: ctl.x + ctl.w - mW, y: ctl.y, w: mW, h: mH },
  ];
  // Radius capped against the spacing rather than floored at a fixed pixel size, so the
  // lamps cannot touch at any pane size.
  const lampGap = ctl.w * (LAMPS[1][0] - LAMPS[0][0]);
  const lampR = Math.max(0.8, Math.min(ctl.w * LAMP_R, lampGap * 0.45));
  const vr = Math.min(amp.h * 0.32, amp.w * 0.055);
  const volume = { x: amp.x + amp.w - vr * 1.5, y: amp.y + amp.h * 0.48, r: vr };

  const lamps = LAMPS.map(([fx]) => ({
    x: ctl.x + ctl.w * fx,
    y: ctl.y + ctl.h * LAMP_Y,
    r: lampR,
  }));

  // Amp controls, positioned here rather than in the painter so the pressable geometry has
  // exactly one definition and a real focusable control can be laid over each one.
  const pw = amp.w * 0.045;
  const bw = amp.w * 0.07;
  const bh = amp.h * 0.2;
  const bx = glass.x + glass.w * 1.06;
  const by = amp.y + amp.h * 0.4;
  const lip = Math.max(2, well.w * 0.018);
  const buttons: HifiButton[] = [
    {
      id: "power",
      rect: { x: amp.x + amp.w * 0.025, y: amp.y + amp.h * 0.3, w: pw, h: pw },
      label: "Switch the display off",
    },
    { id: "display", rect: { x: bx, y: by, w: bw, h: bh }, label: "Change what the display shows" },
    {
      id: "dimmer",
      rect: { x: bx + bw * 1.14, y: by, w: bw, h: bh },
      label: "Dim the display",
    },
    {
      id: "eject",
      rect: ejectRect(deck, well, lip),
      label: "Eject",
    },
    ...keyRects(keys).map((rect, i) => ({
      id: KEYS[i].id,
      rect,
      label: KEYS[i].label,
      inert: KEYS[i].inert,
    })),
  ];

  const speakers: [Rect, Rect] | null = wide
    ? [
        { x: inner.x, y: inner.y, w: spkW, h: inner.h },
        { x: inner.x + inner.w - spkW, y: inner.y, w: spkW, h: inner.h },
      ]
    : null;

  return { amp, glass, deck, well, cass, ctl, keys, meters, volume, lamps, buttons, speakers };
}

/** The lamp cluster on the deck's rule: L peak, R peak, play — as fractions of the control
 *  column's width, plus the colour each one's dark bezel is tinted. The spacing has to
 *  clear LAMP_R twice over, or the two peak lamps merge into one blob. */
const LAMP_R = 0.016;
const LAMPS: [number, string][] = [
  [0.85, "#140b0a"],
  [0.905, "#140b0a"],
  [0.96, "#0a1410"],
];
const LAMP_Y = 0.44;

/** The volume knob's travel: from lower-left round to lower-right, the ~270° a real one
 *  turns through, with the dead zone at the bottom where the pointer would be hidden by the
 *  hand holding it. */
const VOL_MIN = Math.PI * 0.75;
const VOL_MAX = Math.PI * 2.25;

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1);

/** EJECT, centred in the strip of faceplate between the door's recess and the deck's bottom
 *  edge, and sized to fit it rather than to a figure of its own. */
function ejectRect(deck: Rect, well: Rect, lip: number): Rect {
  const top = well.y + well.h + lip;
  const strip = Math.max(0, deck.y + deck.h - top);
  const h = Math.max(3, Math.min(lip * 3, strip * 0.62));
  const w = Math.min(well.w * 0.24, h * 3.4);
  return { x: well.x + (well.w - w) / 2, y: top + (strip - h) / 2, w, h };
}

/** The drivers' own shading, fixed rather than themed: black plastic is black in either
 *  finish, so the drivers do not follow the palette's edge colours. */
const DRIVER = {
  hi: "rgba(255,255,255,0.10)",
  lo: "rgba(0,0,0,0.80)",
  /** The hole behind the tweeter dome, and the rim the cone's edge falls away into. */
  throat: "#0b0c0e",
  cone: "#0d0e11",
  baffle: "#121316",
};

function paintSpeaker(ctx: CanvasRenderingContext2D, r: Rect) {
  rr(ctx, r.x, r.y, r.w, r.h, Math.max(2, r.w * 0.03));
  brushed(ctx, r, INK.cabTop, INK.cabBot);
  ctx.strokeStyle = INK.edgeHi;
  ctx.lineWidth = 1;
  rr(ctx, r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, Math.max(2, r.w * 0.03));
  ctx.stroke();
  // A recessed baffle, so the drivers sit in something; dark in either finish.
  const b: Rect = { x: r.x + r.w * 0.08, y: r.y + r.h * 0.05, w: r.w * 0.84, h: r.h * 0.9 };
  ctx.fillStyle = DRIVER.baffle;
  rr(ctx, b.x, b.y, b.w, b.h, Math.max(2, r.w * 0.02));
  ctx.fill();
  ctx.strokeStyle = DRIVER.lo;
  ctx.stroke();

  // Tweeter, up top: a small dome recessed into a square faceplate, which is what one
  // looked like and what distinguishes it from "a smaller woofer".
  const tr = Math.min(b.w * 0.15, b.h * 0.07);
  const tx = b.x + b.w / 2;
  const ty = b.y + b.h * 0.13;
  ctx.fillStyle = "#191a1e";
  rr(ctx, tx - tr * 1.8, ty - tr * 1.8, tr * 3.6, tr * 3.6, tr * 0.5);
  ctx.fill();
  ctx.strokeStyle = DRIVER.lo;
  ctx.lineWidth = 1;
  ctx.stroke();
  // The waveguide throat, then the dome sitting proud of it.
  ctx.fillStyle = DRIVER.throat;
  ctx.beginPath();
  ctx.arc(tx, ty, tr * 1.35, 0, TAU);
  ctx.fill();
  const tg = ctx.createRadialGradient(tx - tr * 0.4, ty - tr * 0.45, 0, tx, ty, tr);
  tg.addColorStop(0, "#b9bec8");
  tg.addColorStop(0.5, "#5e636d");
  tg.addColorStop(1, "#1d1f24");
  ctx.fillStyle = tg;
  ctx.beginPath();
  ctx.arc(tx, ty, tr, 0, TAU);
  ctx.fill();
  // Four mounting screws, the detail that says "bolted to a baffle".
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  for (const [sx, sy] of [
    [-1.35, -1.35],
    [1.35, -1.35],
    [-1.35, 1.35],
    [1.35, 1.35],
  ]) {
    ctx.beginPath();
    ctx.arc(tx + sx * tr, ty + sy * tr, Math.max(0.7, tr * 0.16), 0, TAU);
    ctx.fill();
  }

  // Bass port, bottom — the detail that says "reflex cabinet" rather than "box".
  const pr = Math.min(b.w * 0.11, b.h * 0.05);
  const py = b.y + b.h * 0.84;
  ctx.fillStyle = "#050506";
  ctx.beginPath();
  ctx.arc(tx, py, pr, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = DRIVER.hi;
  ctx.lineWidth = Math.max(1, pr * 0.18);
  ctx.stroke();

  // The badge, a clear port-diameter below the port rather than tucked under its lip.
  const badgePx = Math.max(4, b.w * 0.06);
  label(ctx, "2-WAY BASS REFLEX", tx, py + pr + badgePx * 1.8, badgePx, INK.printDim, "center");
}

/** Where the woofer sits — needed by both the static pass (its surround) and the frame
 *  pass (its cone, which moves). */
function wooferOf(r: Rect): { x: number; y: number; r: number } {
  const b = { x: r.x + r.w * 0.08, y: r.y + r.h * 0.05, w: r.w * 0.84, h: r.h * 0.9 };
  return {
    x: b.x + b.w / 2,
    y: b.y + b.h * 0.52,
    r: Math.min(b.w * 0.42, b.h * 0.24),
  };
}

export type Chassis = {
  /** Which object is on screen. Decided by the pane's shape, in `resize`. */
  readonly mode: "stack" | "walkman";
  /** Where the VFD canvas belongs, in CSS pixels. */
  readonly glass: Rect;
  /** Everything pressable, for the component to lay real controls over. */
  readonly buttons: HifiButton[];
  /** The speaker cabinets, when there are any — the component lays a control over each so
   *  the covers can be pulled off by touching the speaker rather than by a chip somewhere
   *  else. Null on a pane too narrow to stand them beside the stack. */
  readonly speakers: [Rect, Rect] | null;
  /** True while something the chassis animates on its OWN clock is still moving — the
   *  display's glow fading out of the faceplate. The component's frame driver freezes the
   *  loop on a stopped pane, so it has to be told to stay awake until this settles. */
  readonly settling: boolean;
  /** Which plate the display is — a personal stereo has room for one line. */
  readonly panelSize: PanelSize;
  /** The stack layout, when that is what is being drawn. Exposed for the tests, which
   *  measure the cassette's rect to isolate the reels from the rest of the frame. */
  readonly stack: HifiLayout;
  /** Re-measure and rebuild the cached chassis. */
  resize(w: number, h: number, dpr: number): void;
  /** Re-paint the cassette (its shell and label) — on a track change. */
  retape(input: Pick<ChassisInput, "title" | "artist" | "side" | "seed">): void;
  draw(input: ChassisInput): void;
};

/**
 * Which object suits a pane of this shape. The separates stack is a WIDE object, so the
 * walkman takes any pane that is taller than wide — and also narrow-landscape ones: below
 * ~480px the stack's amplifier, deck and control column stop reading as separate things,
 * whatever the height. The narrow case still asks for some height, because the walkman is
 * itself a tall object; a 460 × 200 letterbox suits neither machine and keeps the stack.
 */
export function chassisMode(w: number, h: number): "stack" | "walkman" {
  if (h > w * 1.02) return "walkman";
  return w < 480 && h > w * 0.9 ? "walkman" : "stack";
}

export function createChassis(canvas: HTMLCanvasElement): Chassis | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const still = document.createElement("canvas");
  const stillCtx = still.getContext("2d");
  const tape = document.createElement("canvas");
  const tapeCtx = tape.getContext("2d");
  if (!stillCtx || !tapeCtx) return null;

  let mode: "stack" | "walkman" = "stack";
  /** The finish the cached layers were painted in. Both offscreens bake the palette, so a
   *  theme switch has to repaint them — checked per frame because there is no event for it
   *  and a dataset read costs nothing next to what the frame does anyway. */
  let painted: ChassisTheme = currentTheme();
  /** The accent the cassette's label was printed in. Tracked separately from the theme
   *  because the two are independent: the app can re-accent without going light or dark. */
  let paintedAccent = accentColor().join();
  let layout = layoutHifi(1, 1);
  let wm = layoutWalkman(1, 1);
  let W = 1;
  let H = 1;
  let DPR = 1;
  let taped: Pick<ChassisInput, "title" | "artist" | "side" | "seed"> = {
    title: "",
    artist: "",
    side: "A",
    seed: 0,
  };
  /** Needle positions, carried across frames — see vuEase. */
  const needle: [number, number] = [0, 0];
  /** How much of the display's light is falling on the faceplate, 0..1. Carried across
   *  frames for the same reason the needles are: it eases toward POWER rather than
   *  following it. */
  let glow = 1;

  /**
   * A speaker's grille cover, baked once.
   *
   * It cannot go in `still` — it has to composite OVER the woofer, and the woofer moves — but
   * nothing about it changes between frames, and drawing it live is the most expensive thing
   * in the frame: a blurred drop shadow and two runs of cursive text, twice over. Cached to
   * its own offscreen and blitted, it is two `drawImage` calls.
   *
   * One canvas for both cabinets, because they are the same size.
   */
  const grille = document.createElement("canvas");
  const grilleCtx = grille.getContext("2d");

  function paintGrilleLayer() {
    const g = grilleCtx;
    const s = layout.speakers?.[0];
    if (!g || !s) return;
    grille.width = Math.max(1, Math.round(s.w * DPR));
    grille.height = Math.max(1, Math.round(s.h * DPR));
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.clearRect(0, 0, s.w, s.h);
    paintGrille(g, { x: 0, y: 0, w: s.w, h: s.h });
  }

  function paintStill() {
    const g = stillCtx!;
    still.width = Math.max(1, Math.round(W * DPR));
    still.height = Math.max(1, Math.round(H * DPR));
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.clearRect(0, 0, W, H);
    if (mode === "walkman") return paintWalkmanStill(g, wm, W, H);

    // The room: near-black with a little depth behind the stack, so the hardware sits in
    // something rather than floating on a flat field.
    const room = g.createRadialGradient(W / 2, H * 0.42, 0, W / 2, H * 0.5, Math.max(W, H) * 0.75);
    room.addColorStop(0, INK.roomHi);
    room.addColorStop(1, INK.room);
    g.fillStyle = room;
    g.fillRect(0, 0, W, H);

    const { amp, buttons, ctl, deck, glass, lamps, meters, well, keys, speakers } = layout;

    if (speakers) for (const s of speakers) paintSpeaker(g, s);

    rr(g, amp.x, amp.y, amp.w, amp.h, Math.max(2, amp.h * 0.06));
    brushed(g, amp, INK.face, INK.faceLo);
    g.strokeStyle = INK.edgeHi;
    g.lineWidth = 1;
    rr(g, amp.x + 0.5, amp.y + 0.5, amp.w - 1, amp.h - 1, Math.max(2, amp.h * 0.06));
    g.stroke();
    // No champagne rule across the foot of the amplifier: on the real thing that stripe
    // separated a button row from the panel below, and here there is nothing under it.

    // The display cutout: a black recess with a chrome lip. The VFD canvas is parked
    // exactly on `glass`, so nothing is drawn inside it here.
    g.fillStyle = INK.glassWell;
    rr(g, glass.x - glass.w * 0.02, glass.y - glass.h * 0.12, glass.w * 1.04, glass.h * 1.24, 3);
    g.fill();
    g.strokeStyle = "rgba(0,0,0,0.9)";
    g.lineWidth = Math.max(1, glass.h * 0.04);
    g.stroke();
    g.strokeStyle = "rgba(200,208,220,0.22)";
    g.lineWidth = 1;
    rr(
      g,
      glass.x - glass.w * 0.02 - 1,
      glass.y - glass.h * 0.12 - 1,
      glass.w * 1.04 + 2,
      glass.h * 1.24 + 2,
      3,
    );
    g.stroke();

    // Power, and the phones jack beside it. Geometry comes from `buttons`, so the picture
    // and the pressable area cannot drift apart.
    const btn = (id: HifiButtonId) => buttons.find((b) => b.id === id)!.rect;
    const p0 = btn("power");
    const pw = p0.w;
    g.fillStyle = INK.keyMid;
    rr(g, p0.x, p0.y, pw, pw, 2);
    g.fill();
    g.strokeStyle = INK.edgeLo;
    g.stroke();
    label(
      g,
      "POWER",
      p0.x + pw / 2,
      p0.y + pw * 1.45,
      Math.max(4, pw * 0.28),
      INK.printDim,
      "center",
    );
    const jr = pw * 0.42;
    g.fillStyle = "#0a0b0d";
    g.beginPath();
    g.arc(p0.x + pw / 2, amp.y + amp.h * 0.72, jr, 0, TAU);
    g.fill();
    g.strokeStyle = "rgba(190,198,210,0.3)";
    g.lineWidth = Math.max(1, jr * 0.25);
    g.stroke();

    // Two small buttons between the glass and the volume knob, not three: a third's
    // silkscreen would land under the knob.
    (["display", "dimmer"] as const).forEach((id) => {
      const b = btn(id);
      g.fillStyle = INK.btn;
      rr(g, b.x, b.y, b.w, b.h, 2);
      g.fill();
      g.strokeStyle = INK.edgeLo;
      g.stroke();
      g.fillStyle = INK.edgeHi;
      g.fillRect(b.x + 1, b.y + 1, b.w - 2, 1);
      label(
        g,
        id.toUpperCase(),
        b.x + b.w / 2,
        b.y + b.h * 1.55,
        Math.max(4, b.w * 0.2),
        INK.printDim,
        "center",
      );
    });

    // Volume, at the right where a hand falls on it. Only its legend and the scale of dots
    // are cached — the knob itself turns, so it is drawn per frame.
    const vol = layout.volume;
    label(
      g,
      "VOLUME",
      vol.x,
      vol.y + vol.r * 1.45,
      Math.max(4, vol.r * 0.28),
      INK.printDim,
      "center",
    );
    // The travel it turns through, printed on the panel: min at one end, max at the other.
    g.strokeStyle = INK.printDim;
    g.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
      const a = VOL_MIN + (VOL_MAX - VOL_MIN) * (i / 10);
      const r0 = vol.r * (i % 5 === 0 ? 1.14 : 1.2);
      g.beginPath();
      g.moveTo(vol.x + Math.cos(a) * r0, vol.y + Math.sin(a) * r0);
      g.lineTo(vol.x + Math.cos(a) * vol.r * 1.28, vol.y + Math.sin(a) * vol.r * 1.28);
      g.stroke();
    }

    rr(g, deck.x, deck.y, deck.w, deck.h, Math.max(2, deck.h * 0.04));
    brushed(g, deck, INK.face, INK.faceLo);
    g.strokeStyle = INK.edgeHi;
    g.lineWidth = 1;
    rr(g, deck.x + 0.5, deck.y + 0.5, deck.w - 1, deck.h - 1, Math.max(2, deck.h * 0.04));
    g.stroke();

    // The well's surround: a chamfered opening with the eject notch under it.
    const lip = Math.max(2, well.w * 0.018);
    g.fillStyle = INK.recess;
    rr(g, well.x - lip, well.y - lip, well.w + lip * 2, well.h + lip * 2, lip);
    g.fill();
    g.strokeStyle = INK.edgeHi;
    g.lineWidth = 1;
    rr(g, well.x - lip + 0.5, well.y - lip + 0.5, well.w + lip * 2 - 1, well.h + lip * 2 - 1, lip);
    g.stroke();
    // EJECT: the same cap as the transport row — it is the same kind of thing, a key.
    const ej = btn("eject");
    const ejg = g.createLinearGradient(0, ej.y, 0, ej.y + ej.h);
    ejg.addColorStop(0, INK.keyTop);
    ejg.addColorStop(0.55, INK.keyMid);
    ejg.addColorStop(1, INK.keyBot);
    g.fillStyle = ejg;
    rr(g, ej.x, ej.y, ej.w, ej.h, Math.max(1, ej.h * 0.22));
    g.fill();
    g.strokeStyle = "rgba(0,0,0,0.75)";
    g.lineWidth = 1;
    g.stroke();
    g.fillStyle = INK.edgeHi;
    g.fillRect(ej.x + ej.w * 0.1, ej.y + 1, ej.w * 0.8, 1);
    // The glyph every deck printed on this key: a triangle standing on a bar.
    const gy = ej.y + ej.h * 0.46;
    const gw = Math.min(ej.w * 0.3, ej.h * 0.5);
    g.fillStyle = INK.print;
    g.beginPath();
    g.moveTo(ej.x + ej.w / 2, gy - gw * 0.42);
    g.lineTo(ej.x + ej.w / 2 + gw * 0.5, gy + gw * 0.24);
    g.lineTo(ej.x + ej.w / 2 - gw * 0.5, gy + gw * 0.24);
    g.closePath();
    g.fill();
    g.fillRect(ej.x + ej.w / 2 - gw * 0.5, gy + gw * 0.45, gw, Math.max(1, gw * 0.2));

    // The meters' recessed bezels. The dials themselves move, so they are painted per
    // frame; what is cached is the hole they sit in.
    for (const m of meters) {
      g.fillStyle = INK.meterWell;
      rr(g, m.x, m.y, m.w, m.h, Math.max(2, m.w * 0.04));
      g.fill();
      // Themed rather than a flat near-black: the dial inside is lit amber whatever the
      // room, but the bezel is faceplate.
      g.strokeStyle = INK.edgeLo;
      g.lineWidth = Math.max(1, m.h * 0.04);
      g.stroke();
      g.strokeStyle = "rgba(200,208,220,0.16)";
      g.lineWidth = 1;
      rr(g, m.x - 1, m.y - 1, m.w + 2, m.h + 2, Math.max(2, m.w * 0.04));
      g.stroke();
    }

    const ruleY = lamps[0].y;
    label(g, "DOLBY B·C NR", ctl.x, ruleY, Math.max(4, ctl.w * 0.075), INK.print);
    label(
      g,
      "PEAK",
      // Clear of the first lamp's GLOW, not just its bezel: a lit LED washes over nearby
      // silkscreen, and at r*4 that reach is four times what the dot looks like.
      lamps[0].x - lamps[0].r * 4 - ctl.w * 0.02,
      ruleY,
      Math.max(4, ctl.w * 0.065),
      INK.printDim,
      "right",
    );
    lamps.forEach((l, i) => {
      g.fillStyle = LAMPS[i][1];
      g.beginPath();
      g.arc(l.x, l.y, l.r, 0, TAU);
      g.fill();
    });
    trimLine(g, ctl.x, ctl.y + ctl.h * 0.52, ctl.w);
    paintKeys(g, keys);

    // The model name, vertically centred in the header band the layout reserved for it.
    label(
      g,
      "STEREO CASSETTE DECK",
      deck.x + deck.w * 0.05,
      deck.y + (well.y - deck.y) / 2,
      Math.max(4, deck.w * 0.018),
      INK.printDim,
    );
    label(
      g,
      "AUTO REVERSE",
      ctl.x,
      keys.y + keys.h + Math.max(6, ctl.h * 0.1),
      Math.max(4, ctl.w * 0.055),
      INK.printDim,
    );
  }

  function paintTape() {
    const g = tapeCtx!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    tape.width = Math.max(1, Math.round(W * DPR));
    tape.height = Math.max(1, Math.round(H * DPR));
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.clearRect(0, 0, W, H);
    if (mode === "walkman") {
      if (wm.cass.w > 2) paintWalkmanTape(g, wm, taped);
      return;
    }
    const c = layout.cass;
    if (c.w > 2 && c.h > 2) {
      paintCassette(g, c, taped.title, taped.artist, taped.side, taped.seed);
    }
  }

  return {
    get mode() {
      return mode;
    },
    get glass() {
      return mode === "walkman" ? wm.glass : layout.glass;
    },
    get buttons() {
      return mode === "walkman" ? wm.buttons : layout.buttons;
    },
    get speakers() {
      return mode === "walkman" ? null : layout.speakers;
    },
    get settling() {
      return glow > 0 && glow < 1;
    },
    get panelSize(): PanelSize {
      return mode === "walkman" ? "mini" : "full";
    },
    get stack() {
      return layout;
    },

    resize(w, h, dpr) {
      W = Math.max(1, w);
      H = Math.max(1, h);
      DPR = Math.max(1, Math.min(2, dpr));
      canvas.width = Math.round(W * DPR);
      canvas.height = Math.round(H * DPR);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      painted = currentTheme();
      setChassisTheme(painted);
      mode = chassisMode(W, H);
      layout = layoutHifi(W, H);
      wm = layoutWalkman(W, H);
      paintStill();
      paintGrilleLayer();
      paintTape();
    },

    retape(next) {
      taped = { ...next };
      paintTape();
    },

    draw(input) {
      const now = currentTheme();
      const nowAccent = accentColor().join();
      if (now !== painted || nowAccent !== paintedAccent) {
        painted = now;
        paintedAccent = nowAccent;
        setChassisTheme(now);
        paintStill();
        paintGrilleLayer();
        paintTape();
      }
      if (mode === "walkman") {
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(still, 0, 0, W, H);
        drawWalkmanFrame(ctx, wm, tape, W, H, input);
        return;
      }
      const { buttons, cass, lamps, meters, speakers, well } = layout;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(still, 0, 0, W, H);

      ctx.save();
      rr(ctx, well.x, well.y, well.w, well.h, Math.max(2, well.w * 0.012));
      ctx.clip();
      ctx.fillStyle = INK.wellFloor;
      ctx.fillRect(well.x, well.y, well.w, well.h);

      const open = input.deck.door;
      // With the tape out, the well is a well: the mechanism, lit, and nothing on it. Held
      // until the door is most of the way down rather than switched the instant EJECT is
      // pressed — a cassette that vanishes behind a closed door has not been ejected, it has
      // been deleted.
      if (!input.loaded && open > 0.8) {
        drawMechanism(ctx, cass);
      } else {
        // The packs come from the tape's own geometry, not from anything the drawing
        // decides — see cassette.ts. Both radii move together and neither is free.
        drawReels(ctx, cass, input.deck, reelState(input.deck.frac));
        // The transport, rising in the strip of bay under the cassette. BEFORE the shell is
        // blitted, so the shell's bottom edge cuts the parts off as they go home — being
        // occluded by the cassette is the whole thing that says they went inside it.
        drawTransport(
          ctx,
          cass,
          well.y + well.h,
          well.y + well.h - (cass.y + cass.h),
          input.deck.engage,
        );
        ctx.drawImage(tape, 0, 0, W, H);
      }

      // The door: hinged along its bottom edge, so opening it foreshortens the face and
      // brings its top edge into view as a lit slab. Always drawn — a door tipped fully
      // forward is still a door lying across the bottom of the opening, and skipping it at
      // the top of the travel makes the last frame of the eject pop.
      {
        const cos = Math.cos(open * 1.28);
        const hinge = well.y + well.h;
        ctx.save();
        ctx.translate(0, hinge);
        ctx.scale(1, Math.max(0.001, cos));
        ctx.translate(0, -hinge);
        const dg = ctx.createLinearGradient(0, well.y, 0, well.y + well.h);
        dg.addColorStop(0, INK.doorTop);
        dg.addColorStop(0.55, INK.doorMid);
        dg.addColorStop(1, INK.doorBot);
        ctx.fillStyle = dg;
        ctx.fillRect(well.x, well.y, well.w, well.h);
        // One diagonal sweep across the acrylic — the reflection of the room's light.
        const sg = ctx.createLinearGradient(well.x, well.y, well.x + well.w * 0.8, well.y + well.h);
        sg.addColorStop(0, "rgba(255,255,255,0)");
        sg.addColorStop(0.42, "rgba(200,225,255,0.09)");
        sg.addColorStop(0.52, "rgba(200,225,255,0.02)");
        sg.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = sg;
        ctx.fillRect(well.x, well.y, well.w, well.h);
        ctx.fillStyle = "rgba(255,255,255,0.14)";
        ctx.fillRect(well.x, well.y, well.w, 1);
        ctx.restore();
        if (open > 0.02) {
          // The door's own thickness, catching light as it tips toward the room.
          const topY = hinge - well.h * cos;
          ctx.fillStyle = "rgba(150,170,190,0.28)";
          ctx.fillRect(
            well.x,
            topY - Math.max(1, well.h * 0.02),
            well.w,
            Math.max(1, well.h * 0.02),
          );
        }
      }
      ctx.restore();

      // Ballistics live here rather than in the caller: a moving-coil movement is a damped
      // mass, and feeding it the raw level makes the needle chatter in a way a real
      // instrument physically cannot.
      needle[0] = vuEase(needle[0], input.playing && !input.paused ? input.peakL : 0);
      needle[1] = vuEase(needle[1], input.playing && !input.paused ? input.peakR : 0);
      for (let i = 0; i < 2; i++) {
        const m = meters[i];
        drawVuMeter(ctx, m.x, m.y, m.w, m.h, needle[i], i ? "R" : "L");
      }

      // The knob points where the level is — the only volume control the app has.
      const vol = layout.volume;
      paintKnob(ctx, vol.x, vol.y, vol.r, VOL_MIN + (VOL_MAX - VOL_MIN) * clamp01(input.volume));

      if (input.pressed) {
        const b = buttons.find((k) => k.id === input.pressed);
        if (b && !b.inert) paintPressed(ctx, b.rect);
      }

      const live = input.playing && !input.paused;
      // Power, always on: the stack is switched on for as long as you are looking at it.
      lamp(
        ctx,
        layout.amp.x + layout.amp.w * 0.0475,
        layout.amp.y + layout.amp.h * 0.22,
        Math.max(1.5, layout.amp.h * 0.022),
        INK.ledRed,
        1,
      );
      // Peak lamps strike near the top of the scale, as they did — a lamp that is on all
      // the time tells you nothing.
      const over = (v: number) => Math.max(0, v - 0.72) / 0.28;
      const on = [live ? over(input.peakL) : 0, live ? over(input.peakR) : 0, live ? 1 : 0];
      lamps.forEach((l, i) => {
        lamp(ctx, l.x, l.y, l.r, i === 2 ? INK.ledGreen : INK.ledRed, on[i]);
      });

      // The cone is drawn even under the cover: the grille weave is laid down just short
      // of opaque, so a covered woofer is still there as a ghost moving under it.
      if (speakers) {
        for (let i = 0; i < 2; i++) {
          const w0 = wooferOf(speakers[i]);
          // Excursion: the two cabinets are driven by the same bass but offset a touch, so
          // they breathe together without being a mirror of each other.
          const drive = Math.max(0, Math.min(1, input.bass * (i ? 0.94 : 1.06)));
          drawWoofer(ctx, w0.x, w0.y, w0.r, drive, input.treble);
          const s = speakers[i];
          if (input.grilles && grille.width > 1) {
            ctx.drawImage(grille, 0, 0, grille.width, grille.height, s.x, s.y, s.w, s.h);
          }
        }
      }

      // The display's own light on the metal around it, so it goes out with the display.
      // Faded rather than cut: a vacuum-fluorescent tube has a heated filament, so it dims
      // over a moment instead of snapping off.
      glow += ((input.powered ? 1 : 0) - glow) * 0.16;
      // Snapped at both ends. An exponential ease only approaches its target, so without
      // this `settling` never goes false and the frame loop would be held awake for good by
      // a fade that finished visibly a second ago.
      if (glow < 0.01) glow = 0;
      if (glow > 0.999) glow = 1;
      if (glow > 0) {
        const gl = layout.glass;
        const spill = ctx.createRadialGradient(
          gl.x + gl.w / 2,
          gl.y + gl.h / 2,
          gl.h * 0.4,
          gl.x + gl.w / 2,
          gl.y + gl.h / 2,
          gl.w * 0.85,
        );
        spill.addColorStop(0, INK.vfdSpill);
        spill.addColorStop(1, "rgba(120,255,214,0)");
        ctx.save();
        ctx.globalAlpha = glow;
        ctx.fillStyle = spill;
        ctx.fillRect(layout.amp.x, layout.amp.y, layout.amp.w, layout.amp.h);
        ctx.restore();
      }
    },
  };
}

/** A woofer whose cone actually moves.
 *
 *  The excursion is small — a few percent of the radius — because a real one is. What sells
 *  it is not the outline changing size but the LIGHT sliding: a cone is a funnel, so the
 *  lit crescent sits on the inner slope and travels as the cone comes forward. Drawn as
 *  three concentric parts, because that is what a driver is: a rubber roll surround, the
 *  paper cone sloping in toward the voice coil, and the dust cap capping it. */
function drawWoofer(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  bass: number,
  treble: number,
) {
  const push = bass * r * 0.055;

  // The chassis rim it is bolted through.
  ctx.fillStyle = "#0d0e10";
  ctx.beginPath();
  ctx.arc(x, y, r * 1.1, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i / 4) * TAU;
    ctx.beginPath();
    ctx.arc(
      x + Math.cos(a) * r * 1.03,
      y + Math.sin(a) * r * 1.03,
      Math.max(0.8, r * 0.05),
      0,
      TAU,
    );
    ctx.fill();
  }

  // Rubber roll surround: a torus, so it is lit on its upper outside and shaded on its
  // lower inside — the opposite of the cone, which is what makes the two read as separate.
  const sg = ctx.createLinearGradient(0, y - r, 0, y + r);
  sg.addColorStop(0, "#3a3d43");
  sg.addColorStop(0.45, "#1d1f23");
  sg.addColorStop(1, DRIVER.baffle);
  ctx.fillStyle = sg;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();

  // The cone. Its centre is displaced upward by `push`, which slides the whole highlight.
  const cr = r * 0.8;
  const cy = y - push;
  const cg = ctx.createRadialGradient(x - cr * 0.42, cy - cr * 0.5, cr * 0.04, x, cy, cr);
  cg.addColorStop(0, `rgba(118,124,134,${0.55 + bass * 0.3})`);
  cg.addColorStop(0.35, "#31343a");
  cg.addColorStop(0.75, "#1c1e22");
  cg.addColorStop(1, DRIVER.cone);
  ctx.fillStyle = cg;
  ctx.beginPath();
  ctx.arc(x, cy, cr, 0, TAU);
  ctx.fill();
  // A couple of faint rings down the slope: pressed paper has them, and they give the
  // funnel somewhere to catch light.
  ctx.strokeStyle = "rgba(255,255,255,0.045)";
  ctx.lineWidth = Math.max(0.7, r * 0.02);
  for (const k of [0.58, 0.78]) {
    ctx.beginPath();
    ctx.arc(x, cy, cr * k, Math.PI * 1.05, Math.PI * 1.95);
    ctx.stroke();
  }

  // Dust cap, sitting proudest of all and moving furthest.
  const dr = cr * 0.3;
  const dy = cy - push * 0.6;
  const dg = ctx.createRadialGradient(x - dr * 0.45, dy - dr * 0.55, 0, x, dy, dr);
  dg.addColorStop(0, `rgba(206,212,222,${0.38 + treble * 0.34})`);
  dg.addColorStop(0.7, "#31343a");
  dg.addColorStop(1, "#141619");
  ctx.fillStyle = dg;
  ctx.beginPath();
  ctx.arc(x, dy, dr, 0, TAU);
  ctx.fill();

  ctx.strokeStyle = "rgba(0,0,0,0.65)";
  ctx.lineWidth = Math.max(1, r * 0.03);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.stroke();
}
