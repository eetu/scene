// The amplifier's faceplate: what is printed on the vacuum-fluorescent plate, and what
// drives each anode. Kept out of the component so the layout is data a test can compile
// headlessly (@glowbox/vfd's `compilePanel` is pure) and so the three faces sit next to
// each other where they can be compared.
//
// The shape of this file follows the hardware's own split, which the package draws a hard
// line down: DECLARING the plate is expensive (it re-compiles every anode) and DRIVING it
// is cheap. So the layout is a pure function of the face, built once per face change, and
// the driver never touches geometry.
//
// A real mini-system had one display and a DISPLAY button that gave its big right-hand
// window a different job — analyser, level meter, text. That is exactly what the
// faces here are, and it is why they are faces of one visualiser rather than three
// visualisers: the left-hand two thirds of the plate never change, because on the real
// thing it was screen-printed there.

import { glyph5x7, type VfdElement, type VfdPanel } from "@glowbox/vfd";

import { readSpectrum, SPECTRUM_SIZE, spectrumSampleRate } from "./scope";

/** The plate's design frame. Every box below is in these units. ~5:1, which is what a
 *  full-width component's display window actually was. */
export const PANEL_FRAME: [number, number] = [320, 64];

/**
 * The two plates: the separates stack's full faceplate, and the one strip a personal stereo
 * had room for.
 *
 * A different size of hardware, not a scaled copy — which is why it is a second layout
 * rather than a transform. A mini plate that was the full one shrunk would carry a tape
 * counter and six annunciators at a size nobody could read, and print silkscreen labels
 * narrower than their own text. What a small machine did instead was carry less.
 *
 * Element NAMES are shared between the two, so the panel handle's drive state survives the
 * `setLayout` when a pane is resized from one shape into the other.
 */
export type PanelSize = "full" | "mini";

const MINI_FRAME: [number, number] = [208, 40];

export function panelFrame(size: PanelSize): [number, number] {
  return size === "mini" ? MINI_FRAME : PANEL_FRAME;
}

/** Which elements the mini plate actually carries — the driver skips the rest rather than
 *  addressing names that aren't there, which would warn once per name. */
const MINI_NAMES = new Set(["main", "time", "play", "pause", "stop", "st", "dolby"]);

// No FM dial. The panel had one and the package draws a beautiful `scale`, but this machine
// is playing a cassette: a tuning cursor sweeping an FM band while a tape turns is a readout
// of nothing, and it made the DISPLAY button cycle through a face you had to skip past.
export type VfdFace = "spectrum" | "level" | "text";

export const VFD_FACES: { id: VfdFace; label: string }[] = [
  { id: "spectrum", label: "spec" },
  { id: "level", label: "level" },
  { id: "text", label: "text" },
];

export function isVfdFace(v: unknown): v is VfdFace {
  return VFD_FACES.some((f) => f.id === v);
}

/**
 * What the window is wired to, including the one job the DISPLAY button cannot select.
 *
 * `reel` is the film a track can bring with it (see reel.ts): it takes the window for as
 * long as that tune is playing, whichever face is chosen, and DISPLAY hands it back. It
 * is deliberately NOT in `VFD_FACES` — a face is a job the hardware always offers, and
 * this one exists only when a clip does. Putting it in the list would mean a fourth
 * button that does nothing on every tune but one.
 */
export type PanelFace = VfdFace | "reel";

/**
 * The dot field a film gets, per plate.
 *
 * Chosen so a dot is SQUARE in its window — the full plate's film area is 108×48 design
 * units, so 72×32 dots is a pitch of 1.5 either way. A rectangular dot on a face that is
 * showing a picture reads as the picture being stretched, which is the one thing a
 * letterboxed film must not look like.
 *
 * Exported because the component samples the clip into a grid of exactly this size, and
 * two places disagreeing about it would be a silently cropped picture.
 */
export const reelDots = (size: PanelSize = "full"): { cols: number; rows: number } =>
  // The mini plate's window is 76×28 units, so 76×28 dots is a pitch of 1 — finer than
  // the full plate's, which is the opposite of what scaling a layout down would give and
  // is the point: at 54×20 a 4:3 clip landed in 27×20 dots and stopped being a picture.
  // A personal stereo's display really did have a finer pitch than a full component's;
  // it had less room, not bigger dots.
  size === "mini" ? { cols: 76, rows: 28 } : { cols: 72, rows: 32 };

/** The window the DISPLAY button re-purposes — the one region that differs between faces. */
const WIN = { x: 158, y: 4, w: 116, h: 56 };

/**
 * Plastic laid over regions of the glass, per face.
 *
 * The red one is not decoration and never moves: green filter glass physically cannot pass
 * red, so a red REC indicator on a green panel needs its own window or it is simply
 * invisible. That is why every deck with a green display had a small red rectangle in it.
 *
 * The amber one follows the window's job, and yes, plastic does not move. Neither does a
 * window really change from an analyser into a level meter — the faces are the
 * conceit, and the amber band is part of the face. The alternative was one fixed band, and
 * because the two meters run at right angles to each other (an analyser is hot at the TOP,
 * a horizontal level meter at its RIGHT END) a band that suited one put a meaningless amber
 * corner on the other. That is what it looked like, and it read as a rendering fault.
 */
export function panelZones(face: PanelFace, size: PanelSize = "full") {
  if (size === "mini") {
    // No red REC window: the mini plate has no REC anode to make visible, and a red
    // rectangle over nothing is just a red rectangle.
    const b = { x: MINI_WIN.x + 3, y: MINI_WIN.y + 3, w: MINI_WIN.w - 6, h: MINI_WIN.h - 6 };
    switch (face) {
      case "spectrum":
        return [{ x: b.x, y: b.y, w: b.w, h: 7, filter: "amber" as const }];
      case "level":
        return [{ x: b.x + b.w - 18, y: b.y, w: 18, h: b.h, filter: "amber" as const }];
      default:
        return [];
    }
  }
  const rec = { x: 274, y: 39, w: 22, h: 11, filter: "#c8281a" };
  switch (face) {
    case "spectrum":
      // The last few rows of every band — the classic strip across the top of an analyser.
      return [{ x: WIN.x + 4, y: WIN.y + 4, w: WIN.w - 8, h: 11, filter: "amber" as const }, rec];
    case "level":
      // The same idea turned through ninety degrees, because the meter is.
      return [{ x: 240, y: 10, w: 32, h: 36, filter: "amber" as const }, rec];
    default:
      // Text and a film have no "too hot" end, so there is nothing for a band to mean —
      // and amber plastic laid over a picture is a tint on the picture.
      return [rec];
  }
}

// Icon artwork, authored straight in frame coordinates and declared with a shared
// `frame` so the pieces stay in register with each other instead of each being rescaled
// to fit its own box. A VFD anode is a screen-printed patch, so this is plain SVG fill
// data — no centreline authoring, and a hole fills correctly.
//
// The holes are wound the OPPOSITE way round from their outlines (outer clockwise in
// y-down, inner counter-clockwise). Under a non-zero fill rule that is what knocks the
// hole out; under even-odd it makes no difference. Authoring for both costs nothing and
// means the cassette pictogram can't come out as a solid slab.
const ICONS = {
  play: "M104 35 L115 41 L104 47 Z",
  pause: "M119 35h4v12h-4z M125 35h4v12h-4z",
  stop: "M133 35h12v12h-12z",
  // Two half-arcs, the standard way to close a full circle in path data.
  rec: "M150 41 A5 5 0 1 1 160 41 A5 5 0 1 1 150 41 Z",
};

/** Everything that was screen-printed on the plate and never changes with the face.
 *
 *  Element names are the wiring: they must match across faces, because that is how the
 *  package carries drive state through a `setLayout`. Rename one here and it goes dark on
 *  the next face change rather than erroring, so they are written out once, in one place. */
function furniture(): VfdElement[] {
  return [
    // The title readout. A segment field can only step a whole character at a time, so
    // long titles march rather than glide — see `stepText` below, and note the panel's
    // persistence is kept low for exactly this reason (the README's own warning: past
    // ~0.45 a character field ghosts into its previous value and a marching title turns
    // into mush).
    { kind: "digits", name: "main", chars: 12, glyphs: "14seg", x: 6, y: 6, w: 144, h: 24 },
    // Elapsed, and the mechanical counter beside it. Two different jobs that both look
    // like numbers, which is why the plate labels them.
    { kind: "digits", name: "time", chars: 5, glyphs: "7seg", x: 6, y: 34, w: 40, h: 14 },
    { kind: "legend", name: "timeLbl", text: "ELAPSED", printed: true, x: 6, y: 50, w: 34, h: 6 },
    {
      kind: "digits",
      name: "count",
      chars: 4,
      glyphs: "7seg",
      align: "right",
      x: 54,
      y: 34,
      w: 34,
      h: 14,
    },
    { kind: "legend", name: "countLbl", text: "COUNTER", printed: true, x: 54, y: 50, w: 34, h: 6 },

    // Transport. Icons rather than legends because that is what they were: little printed
    // arrows, not the words.
    { kind: "icon", name: "play", d: ICONS.play, frame: PANEL_FRAME },
    { kind: "icon", name: "pause", d: ICONS.pause, frame: PANEL_FRAME },
    { kind: "icon", name: "stop", d: ICONS.stop, frame: PANEL_FRAME },
    { kind: "icon", name: "rec", d: ICONS.rec, frame: PANEL_FRAME },

    // Annunciators, in three rows down the right-hand column.
    //
    // There was a cassette pictogram here too — a shell outline with two reels alternating
    // at 2Hz, which is exactly what a real deck's display did. It came out because on THIS
    // faceplate it says nothing: the actual cassette is sitting right below it with its
    // actual reels turning, at twenty times the size. A pictogram earns its place on
    // hardware whose tape you cannot see, and this is not that. The space it freed goes to
    // the annunciators, which had been squeezed into the top third of the column to make
    // room for it.
    //
    // ST gets an amber phosphor of its own — real plates did mix, and the stereo lamp being
    // a different colour from the rest of the panel is the detail that says "this is a tube
    // with several phosphors in it" rather than "this is a font".
    { kind: "legend", name: "st", text: "ST", phosphor: "amber", x: 276, y: 8, w: 16, h: 9 },
    { kind: "legend", name: "dolby", text: "DOLBY", x: 296, y: 8, w: 22, h: 9 },
    { kind: "legend", name: "mono", text: "MONO", x: 276, y: 24, w: 22, h: 9 },
    { kind: "legend", name: "rpt", text: "RPT", x: 302, y: 24, w: 16, h: 9 },
    // Under the red window declared in panelZones — green filter glass cannot pass red.
    { kind: "legend", name: "recLbl", text: "REC", x: 276, y: 40, w: 18, h: 9 },
    { kind: "legend", name: "rand", text: "RAND", x: 298, y: 40, w: 20, h: 9 },

    // Silkscreen furniture: the hairline that separates the readout from the window, and
    // the box around the window itself.
    { kind: "rule", name: "sep", shape: "line", x: 152, y: 6, w: 0, h: 52, weight: 0.6 },
    { kind: "rule", name: "winBox", shape: "box", x: WIN.x, y: WIN.y, w: WIN.w, h: WIN.h },
  ];
}

/** The mini plate: one line of readout, three transport arrows, two annunciators, and the
 *  window doing whatever the face asks of it. */
const MINI_WIN = { x: 122, y: 3, w: 82, h: 34 };

function miniFurniture(): VfdElement[] {
  return [
    { kind: "digits", name: "main", chars: 9, glyphs: "14seg", x: 4, y: 4, w: 84, h: 17 },
    { kind: "digits", name: "time", chars: 5, glyphs: "7seg", x: 4, y: 24, w: 30, h: 11 },
    { kind: "icon", name: "play", d: "M40 26 L49 30.5 L40 35 Z", frame: MINI_FRAME },
    { kind: "icon", name: "pause", d: "M53 26h3v9h-3z M58 26h3v9h-3z", frame: MINI_FRAME },
    { kind: "icon", name: "stop", d: "M65 26h9v9h-9z", frame: MINI_FRAME },
    { kind: "legend", name: "st", text: "ST", phosphor: "amber", x: 92, y: 5, w: 12, h: 9 },
    { kind: "legend", name: "dolby", text: "DOLBY", x: 92, y: 18, w: 26, h: 9 },
    {
      kind: "rule",
      name: "winBox",
      shape: "box",
      x: MINI_WIN.x,
      y: MINI_WIN.y,
      w: MINI_WIN.w,
      h: MINI_WIN.h,
    },
  ];
}

function miniWindow(face: PanelFace): VfdElement[] {
  const b = { x: MINI_WIN.x + 3, y: MINI_WIN.y + 3, w: MINI_WIN.w - 6, h: MINI_WIN.h - 6 };
  switch (face) {
    case "reel": {
      const { cols, rows } = reelDots("mini");
      return [{ kind: "dots", name: "film", cols, rows, dot: "square", ...b }];
    }
    case "spectrum":
      return [
        { kind: "bars", name: "spec", bands: 12, rows: 8, peakHold: true, peakFall: 5, ...b },
      ];
    case "level":
      return [
        {
          kind: "bars",
          name: "vu",
          bands: 2,
          rows: 18,
          from: "left",
          peakHold: true,
          peakFall: 6,
          ...b,
        },
      ];
    case "text":
      return [{ kind: "dots", name: "ticker", cols: 56, rows: 7, dot: "square", ...b }];
  }
}

/** The plate for one face: the printed furniture, plus whatever the big window is wired
 *  to this time. Pure — `compilePanel` can take it with no canvas at all. */
export function panelLayout(face: PanelFace, size: PanelSize = "full"): VfdElement[] {
  if (size === "mini") return [...miniFurniture(), ...miniWindow(face)];
  const els = furniture();
  switch (face) {
    case "reel": {
      // The whole window, and nothing printed in it. The other faces label themselves —
      // an analyser has its decade scale, the text face says MESSAGE — because a readout
      // that does not say what it is showing is a mystery. A picture is not a readout, and
      // a caption over one is in the way of it.
      const { cols, rows } = reelDots("full");
      els.push({
        kind: "dots",
        name: "film",
        cols,
        rows,
        dot: "square",
        x: WIN.x + 4,
        y: WIN.y + 4,
        w: WIN.w - 8,
        h: WIN.h - 8,
      });
      break;
    }
    case "spectrum":
      els.push({
        kind: "bars",
        name: "spec",
        bands: 14,
        rows: 11,
        peakHold: true,
        peakFall: 5,
        x: WIN.x + 4,
        y: WIN.y + 4,
        w: WIN.w - 8,
        h: WIN.h - 8,
        // Printed along the bottom edge; the element reserves the space itself. THREE, not
        // the five this started with: the package sizes scale labels off the element rather
        // than off the slot each one gets, so five across 108 frame units ran into each
        // other and "63 250 1K 4K 16K" printed as one smear. Three is also what the real
        // ones carried — a decade scale is for orientation, not for reading values off.
        scale: ["63", "1K", "16K"],
      });
      break;
    case "level":
      els.push(
        { kind: "legend", name: "lvlL", text: "L", printed: true, x: WIN.x + 4, y: 16, w: 7, h: 9 },
        { kind: "legend", name: "lvlR", text: "R", printed: true, x: WIN.x + 4, y: 32, w: 7, h: 9 },
        {
          kind: "bars",
          name: "vu",
          bands: 2,
          rows: 22,
          from: "left",
          peakHold: true,
          peakFall: 6,
          // Filling the window rather than sitting in the top half of it: two rows of
          // horizontal blocks in a 56-unit-tall box left a third of the glass empty, which
          // on a panel this crowded looked like something had failed to draw.
          x: WIN.x + 14,
          y: 12,
          w: WIN.w - 20,
          h: 40,
          // Three, for the same reason as the analyser's — and the three that matter on a
          // record-level meter are the bottom, the shoulder and the over mark.
          scale: ["-20", "-5", "+3"],
        },
      );
      break;
    case "text":
      els.push(
        {
          kind: "legend",
          name: "txtLbl",
          text: "MESSAGE",
          printed: true,
          x: WIN.x + 4,
          y: 8,
          w: 40,
          h: 6,
        },
        {
          kind: "dots",
          name: "ticker",
          cols: 72,
          rows: 9,
          dot: "square",
          x: WIN.x + 4,
          y: 18,
          w: WIN.w - 8,
          h: 26,
        },
      );
      break;
  }
  return els;
}

// ─── the ticker ────────────────────────────────────────────────────────────────────────

const CH_W = 5;
const CH_ADV = 6;

/**
 * Text scrolled by DOT COLUMN across the `dots` window.
 *
 * This is the one thing a character-addressed field structurally cannot do, and the
 * reason the text face uses a dot area rather than a wider `digits` run: a segment field
 * can only jump a whole cell, which under any persistence at all reads as two glyphs
 * stacked rather than as motion.
 *
 * The sub-pixel position is not thrown away. A multiplexed anode dims by duty cycle, so
 * the package takes fractional brightness honestly — the two columns a glyph column
 * currently straddles are lit in proportion, and the text glides instead of stepping.
 * Costs nothing: it is the same 648 anodes either way.
 */
export function createTicker() {
  let cols: number[] = [];
  let at = 0;
  let text = "";

  function setText(next: string) {
    if (next === text) return;
    text = next;
    cols = [];
    for (const ch of next.toUpperCase()) {
      const rows = glyph5x7(ch);
      for (let c = 0; c < CH_W; c++) {
        // Bit 4 is the leftmost of the five columns.
        let bits = 0;
        for (let r = 0; r < rows.length; r++) {
          if ((rows[r] >> (CH_W - 1 - c)) & 1) bits |= 1 << r;
        }
        cols.push(bits);
      }
      for (let g = CH_W; g < CH_ADV; g++) cols.push(0);
    }
    at = 0;
  }

  return {
    setText,
    get length() {
      return cols.length;
    },
    /** Advance by `cols` dot columns (fractional). */
    advance(step: number) {
      if (!cols.length) return;
      at = (at + step) % cols.length;
      if (at < 0) at += cols.length;
    },
    /** Brightness 0..1 of the dot at (x, y) of a `rows`-tall window. */
    sample(x: number, y: number, rows: number): number {
      if (!cols.length) return 0;
      // One blank row top and bottom, so a 7-tall font sits centred in a 9-tall window.
      const pad = Math.floor((rows - 7) / 2);
      const r = y - pad;
      if (r < 0 || r > 6) return 0;
      const pos = at + x;
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = (cols[((i % cols.length) + cols.length) % cols.length] >> r) & 1;
      const b = (cols[(((i + 1) % cols.length) + cols.length) % cols.length] >> r) & 1;
      return a * (1 - frac) + b * frac;
    },
  };
}

export type Ticker = ReturnType<typeof createTicker>;

// ─── the driver ────────────────────────────────────────────────────────────────────────

/** Everything the plate needs to know about the moment, gathered by the component so this
 *  module stays free of the player store and can be driven from a test. */
export type FaceInput = {
  title: string;
  /** The composer's own words, for the text face. */
  message: string;
  elapsed: number;
  counter: string;
  playing: boolean;
  paused: boolean;
  /** Per-channel levels, 0..1 — split L/R by the Amiga panning convention below. */
  vu: number[];
  mono: boolean;
  repeat: boolean;
  shuffle: boolean;
  /**
   * The film's current frame, already sampled to `reelDots(size)` — one byte per dot,
   * row-major FROM THE TOP, which is the order a `dots` element wants.
   *
   * Sampled by the caller rather than here because the clip and the playhead belong to the
   * component, and this module is the plate: it knows how many dots the window has and
   * nothing about what a reel is.
   */
  film?: Uint8Array | null;
};

const F_MIN = 40;
const F_MAX = 16000;

function mmss(secs: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(secs) ? secs : 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Split per-channel levels into a stereo pair the way the hardware this music was written
 * on did: Paula's four channels are panned hard L-R-R-L, and trackers kept that grouping
 * as channel counts grew. Averaging everything into one number instead would give two
 * meters that always agree, which is the one thing a stereo level meter must not do.
 */
export function stereoLevels(vu: number[]): [number, number] {
  if (!vu.length) return [0, 0];
  let l = 0;
  let r = 0;
  let nl = 0;
  let nr = 0;
  for (let i = 0; i < vu.length; i++) {
    const left = i % 4 === 0 || i % 4 === 3;
    if (left) {
      l += vu[i];
      nl++;
    } else {
      r += vu[i];
      nr++;
    }
  }
  return [nl ? l / nl : 0, nr ? r / nr : 0];
}

/** How long a title sits still before marching one character left. */
const STEP_S = 0.42;

export function createFaceDriver() {
  const spec = new Uint8Array(SPECTRUM_SIZE);
  const ticker = createTicker();

  let bands = 0;
  let tilt = new Float32Array(0);
  let levels = new Float32Array(0);
  let vuHold: [number, number] = [0, 0];

  // Title marching
  let stepAt = 0;
  let stepPhase = 0;
  let lastTitle = "";

  function fitBands(n: number) {
    if (n === bands) return;
    bands = n;
    levels = new Float32Array(n);
    // The analyser convention of tilting up with frequency: music carries far more energy
    // low down, so mapping magnitude straight to height pegs the bass bands and leaves the
    // treble end permanently dark. Same curve the flip-dot board uses, for the same reason.
    tilt = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const f0 = F_MIN * Math.pow(F_MAX / F_MIN, i / n);
      const f1 = F_MIN * Math.pow(F_MAX / F_MIN, (i + 1) / n);
      tilt[i] = Math.min(2.8, Math.max(0.7, Math.pow(Math.sqrt(f0 * f1) / 320, 0.5)));
    }
  }

  /** Band magnitudes, 0..1, log-spaced across the audible range. */
  function readBands(n: number, active: boolean): Float32Array {
    fitBands(n);
    if (!active || !readSpectrum(spec)) {
      for (let i = 0; i < n; i++) levels[i] *= 0.86;
      return levels;
    }
    const hzPerBin = spectrumSampleRate() / 2 / SPECTRUM_SIZE;
    for (let i = 0; i < n; i++) {
      const f0 = F_MIN * Math.pow(F_MAX / F_MIN, i / n);
      const f1 = F_MIN * Math.pow(F_MAX / F_MIN, (i + 1) / n);
      const lo = Math.max(1, Math.floor(f0 / hzPerBin));
      const hi = Math.min(SPECTRUM_SIZE, Math.max(lo + 1, Math.ceil(f1 / hzPerBin)));
      let sum = 0;
      for (let j = lo; j < hi; j++) sum += spec[j];
      const v = Math.min(1, Math.pow((sum / (hi - lo) / 255) * tilt[i], 1.25));
      // Fast attack, slower release — the asymmetry every analyser has. The panel adds its
      // own phosphor tail on top, which is a different and much shorter time constant.
      levels[i] += (v - levels[i]) * (v > levels[i] ? 0.55 : 0.22);
    }
    return levels;
  }

  return {
    ticker,

    /** Everything that is on the plate whatever the window is doing. */
    furniture(
      p: VfdPanel,
      face: PanelFace,
      dt: number,
      input: FaceInput,
      size: PanelSize = "full",
    ) {
      const live = input.playing && !input.paused;
      // The mini plate carries less hardware, so the driver addresses less of it. Writing to
      // a name that isn't there is not fatal — the package warns once — but a console line
      // per missing annunciator on every pane that happens to be portrait is noise the
      // consumer put there, not a library problem.
      const has = (name: string) => size === "full" || MINI_NAMES.has(name);

      // Title. Marched a character at a time once it overflows the field, with a pause at
      // each end so the beginning and the end are both readable — the same reason the
      // scroller board holds a page.
      const t = (input.title || "").toUpperCase();
      if (t !== lastTitle) {
        lastTitle = t;
        stepPhase = 0;
        stepAt = 0;
      }
      const chars = size === "mini" ? 9 : 12;
      const over = Math.max(0, t.length - chars);
      if (over > 0) {
        stepAt += dt;
        if (stepAt >= STEP_S) {
          stepAt -= STEP_S;
          // Two extra steps at each end: 0..over is the travel, the rest is the dwell.
          stepPhase = (stepPhase + 1) % (over + 8);
        }
      }
      const off = Math.min(over, Math.max(0, stepPhase - 4));
      const shown = input.paused
        ? "- PAUSE -"
        : !input.playing
          ? "- STOP -"
          : t.slice(off, off + chars);
      p.set("main", shown);
      p.set("time", mmss(input.elapsed));
      if (has("count")) p.set("count", input.counter);

      p.light("play", live);
      p.light("pause", input.paused);
      p.light("stop", !input.playing);
      if (has("rec")) p.light("rec", false); // wired, never driven — nothing here records

      p.light("st", !input.mono);
      // Dolby was on essentially every prerecorded tape and most home ones; it is lit
      // because the deck is playing a tape, not because anything here is decoding.
      p.light("dolby", input.playing);
      if (has("mono")) p.light("mono", input.mono);
      if (has("rpt")) p.light("rpt", input.repeat);
      if (has("rand")) p.light("rand", input.shuffle);
      if (has("recLbl")) p.light("recLbl", false);

      void face;
    },

    /** The window, whatever it is wired to this time. */
    window(p: VfdPanel, face: PanelFace, dt: number, input: FaceInput, size: PanelSize = "full") {
      const live = input.playing && !input.paused;
      const mini = size === "mini";
      switch (face) {
        case "reel": {
          const film = input.film;
          const { cols } = reelDots(size);
          // Straight through, no flip: a `dots` element counts row 0 at the TOP because
          // what it takes is an image, and so does the sampled film. (The LED cube is the
          // other way round — its rows run bottom-up — which is why that one flips.)
          //
          // Nothing dims it while the film is dark: this plate can hold a fractional
          // brightness per dot, so a 1-bit clip only ever asks for 0 or 1 and the panel's
          // own phosphor tail does the rest.
          p.setDots("film", (x, y) => (film && film[y * cols + x] ? 1 : 0));
          break;
        }
        case "spectrum":
          p.setBars("spec", readBands(mini ? 12 : 14, live));
          break;
        case "level": {
          const [l, r] = stereoLevels(input.vu);
          const target: [number, number] = live ? [l, r] : [0, 0];
          for (let i = 0; i < 2; i++) {
            const v = target[i];
            vuHold[i] += (v - vuHold[i]) * (v > vuHold[i] ? 0.7 : 0.12);
          }
          p.setBars("vu", vuHold);
          break;
        }
        case "text": {
          ticker.setText(input.message);
          if (live) ticker.advance(dt * 26);
          const rows = mini ? 7 : 9;
          p.setDots("ticker", (x, y) => ticker.sample(x, y, rows));
          break;
        }
      }
    },
  };
}

export type FaceDriver = ReturnType<typeof createFaceDriver>;
