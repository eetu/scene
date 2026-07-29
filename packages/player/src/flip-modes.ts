// What the flip-dot board can show, and the rule that decides what belongs here.
//
// A flip-dot's cost is measured in DOTS CHANGED per frame, not in pixels. Changes sweep
// the board as a 70ms driver scan with a 38ms flip behind them, and a frame goes out
// every ~70ms — so churn decides how much of the board is mid-rotation rather than
// showing a state. Re-target a few dozen dots and it reads as machinery; re-target most
// of them and nothing ever resolves.
//
// So every mode here is sparse or local by construction: a trace, a scatter, a moving
// boundary. Effects whose every dot changes every frame — plasma, a scrolling
// spectrogram — are deliberately absent. flip-modes.test.ts measures the churn of each
// mode against a budget so a future one can't quietly break that; two of the three
// modes added here needed real work to get under it (see `trigger` and the ring cap).
//
// Modes render into a flat 0/1 grid rather than answering per-dot queries, because the
// grid is what makes the churn measurable.
import { readScope, readSpectrum, SCOPE_SIZE, SPECTRUM_SIZE, spectrumSampleRate } from "./scope";

export type FlipMode = "bars" | "scope" | "stars" | "rings";

export const FLIP_MODES: { id: FlipMode; label: string }[] = [
  { id: "bars", label: "bars" },
  { id: "scope", label: "scope" },
  { id: "stars", label: "stars" },
  { id: "rings", label: "rings" },
];

export function isFlipMode(v: unknown): v is FlipMode {
  return FLIP_MODES.some((m) => m.id === v);
}

const F_MIN = 40;
const F_MAX = 12000;
const STAR_COUNT = 26;

type Star = { x: number; y: number; z: number };

export type FlipRenderer = {
  /** Advance state and redraw the grid. `onBeat` is one musical beat having ticked. */
  render(
    mode: FlipMode,
    cols: number,
    rows: number,
    dt: number,
    active: boolean,
    onBeat: boolean,
  ): void;
  /** Lit state of a dot, for the board's setFrame callback. */
  dot(x: number, y: number): boolean;
  /** Dots that changed on the last render — the number the hardware actually pays. */
  readonly churn: number;
};

export function createFlipRenderer(): FlipRenderer {
  let cols = 0;
  let rows = 0;
  let grid = new Uint8Array(0);
  let prev = new Uint8Array(0);
  let churn = 0;

  const spec = new Uint8Array(SPECTRUM_SIZE);
  const wave = new Uint8Array(SCOPE_SIZE);

  // bars
  let heights = new Float32Array(0);
  let peaks = new Float32Array(0);
  let tilt = new Float32Array(0);

  // stars — normalised (-1..1) with depth, projected each frame
  const stars: Star[] = [];
  // rings — radii in dot units, oldest first
  let rings: number[] = [];

  function resize(nextCols: number, nextRows: number) {
    if (nextCols === cols && nextRows === rows) return;
    cols = nextCols;
    rows = nextRows;
    grid = new Uint8Array(cols * rows);
    prev = new Uint8Array(cols * rows);
    heights = new Float32Array(cols);
    peaks = new Float32Array(cols);
    // Per-column tilt: music carries far more energy low down, so mapping magnitude
    // straight to height pegs the bass columns and barely lights the treble. This is
    // the analyser convention of tilting up with frequency (~+3dB/octave, i.e.
    // amplitude with the square root of f), clamped so the top can't run away on hiss.
    tilt = new Float32Array(cols);
    for (let c = 0; c < cols; c++) {
      const f0 = F_MIN * Math.pow(F_MAX / F_MIN, c / cols);
      const f1 = F_MIN * Math.pow(F_MAX / F_MIN, (c + 1) / cols);
      tilt[c] = Math.min(2.8, Math.max(0.7, Math.pow(Math.sqrt(f0 * f1) / 320, 0.5)));
    }
  }

  const set = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= cols || y >= rows) return;
    grid[y * cols + x] = 1;
  };

  function bars(dt: number, active: boolean) {
    if (active && readSpectrum(spec)) {
      const hzPerBin = spectrumSampleRate() / 2 / SPECTRUM_SIZE;
      for (let c = 0; c < cols; c++) {
        const f0 = F_MIN * Math.pow(F_MAX / F_MIN, c / cols);
        const f1 = F_MIN * Math.pow(F_MAX / F_MIN, (c + 1) / cols);
        const lo = Math.max(1, Math.floor(f0 / hzPerBin));
        const hi = Math.min(SPECTRUM_SIZE, Math.max(lo + 1, Math.ceil(f1 / hzPerBin)));
        let sum = 0;
        for (let j = lo; j < hi; j++) sum += spec[j];
        // Gamma above 1 compresses toward the floor rather than the ceiling; below 1
        // lifts every middling level toward full and the board sits permanently half-lit.
        const v = Math.min(1, Math.pow((sum / (hi - lo) / 255) * tilt[c], 1.25));
        // Fast attack, and a fall quick enough to see: a slow release holds every bar
        // near its recent maximum, so the lit area only ever grows within a phrase.
        heights[c] += (v - heights[c]) * (v > heights[c] ? 0.6 : 0.3);
        peaks[c] = Math.max(peaks[c] - dt * 0.5, heights[c]);
      }
    } else {
      for (let c = 0; c < cols; c++) {
        heights[c] *= 0.86;
        peaks[c] = Math.max(peaks[c] - dt * 0.8, heights[c]);
      }
    }
    for (let x = 0; x < cols; x++) {
      const h = heights[x] * rows;
      const peak = Math.ceil(peaks[x] * rows);
      for (let y = 0; y < rows; y++) {
        // y counts down from the top, so a bar of height h lights the bottom h rows.
        const level = rows - y;
        // Peak marker: one dot riding above the bar, the flip-dot equivalent of a
        // peak-hold segment.
        if (level <= h || peak === level) set(x, y);
      }
    }
  }

  /** First rising zero-crossing in the first half of the buffer, else 0.
   *
   *  This is what a real oscilloscope's trigger does, and here it is the difference
   *  between a mode that works and one that doesn't. Untriggered, the waveform's phase
   *  slides a little every frame, so the whole trace moves and re-targets ~240 dots a
   *  frame — seven times what the spectrum mode costs, on a board where simultaneous
   *  rotations are the budget. Triggered, a steady tone stands still and only the parts
   *  of the trace that actually changed shape flip. */
  function trigger(): number {
    const half = SCOPE_SIZE >> 1;
    // Smoothed and hysteretic, not a bare zero-crossing. Music is not one sine: a bare
    // crossing latches onto whichever harmonic happens to cross first — with a
    // 55/440/3200Hz mix that is the 3.2kHz partial, and there are ~70 candidates in the
    // window, so the lock jumps every frame and the trace never stands still. A box
    // average over ~24 samples rolls the top partials off so the crossing found belongs
    // to the fundamental, and requiring the signal to dip below -TH before accepting a
    // rise above +TH stops noise around zero from re-triggering.
    const WIN = 24;
    const TH = 6; // ≈5% of full scale
    let run = 0;
    for (let i = 0; i < WIN && i < half; i++) run += wave[i] - 128;
    let armed = false;
    for (let i = WIN; i < half; i++) {
      run += wave[i] - 128 - (wave[i - WIN] - 128);
      const v = run / WIN;
      if (v < -TH) armed = true;
      else if (armed && v > TH) return i - WIN;
    }
    return 0;
  }

  function scope(active: boolean) {
    const mid = (rows - 1) / 2;
    if (!active || !readScope(wave)) {
      for (let x = 0; x < cols; x++) set(x, Math.round(mid));
      return;
    }
    // Half the buffer, so the trigger has somewhere to slide without running off the end.
    const span = SCOPE_SIZE >> 1;
    const start = trigger();
    const stride = span / cols;
    let prevRow = -1;
    for (let x = 0; x < cols; x++) {
      // Peak of the window rather than a point sample: at 40 columns over 1024 samples
      // a point sample aliases badly and the trace jitters between frames on a steady
      // tone. Taking the extreme keeps the envelope stable.
      const from = start + Math.floor(x * stride);
      const to = Math.min(SCOPE_SIZE, start + Math.floor((x + 1) * stride));
      let peak = 0;
      for (let i = from; i < to; i++) {
        const d = wave[i] - 128;
        if (Math.abs(d) > Math.abs(peak)) peak = d;
      }
      const row = Math.round(mid - (peak / 128) * mid);
      const clamped = Math.max(0, Math.min(rows - 1, row));
      // Join to the previous column so the trace reads as a line rather than a dotted
      // scatter, but cap the joint: on a near-vertical edge an uncapped fill paints most
      // of a column, which turns the trace into a filled block and costs the churn a
      // filled block costs.
      if (prevRow >= 0) {
        const lo = Math.min(prevRow, clamped);
        const hi = Math.max(prevRow, clamped);
        const capped = Math.min(hi, lo + 3);
        for (let y = lo; y <= capped; y++) set(x, y);
        if (capped < hi) set(x, hi);
      } else {
        set(x, clamped);
      }
      prevRow = clamped;
    }
  }

  function starfield(dt: number, active: boolean) {
    if (!stars.length) {
      for (let i = 0; i < STAR_COUNT; i++) {
        stars.push({ x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: Math.random() });
      }
    }
    // Depth speed. Held above zero when paused so the field drifts to a stop rather
    // than freezing mid-frame.
    const speed = active ? 0.55 : 0.08;
    const cx = (cols - 1) / 2;
    const cy = (rows - 1) / 2;
    for (const s of stars) {
      s.z -= speed * dt;
      if (s.z <= 0.06) {
        s.x = Math.random() * 2 - 1;
        s.y = Math.random() * 2 - 1;
        s.z = 1;
      }
      const px = Math.round(cx + (s.x / s.z) * cx * 0.55);
      const py = Math.round(cy + (s.y / s.z) * cy * 0.55);
      if (px < 0 || py < 0 || px >= cols || py >= rows) {
        // Off the edge: recycle rather than tracking a star nobody can see.
        s.x = Math.random() * 2 - 1;
        s.y = Math.random() * 2 - 1;
        s.z = 1;
        continue;
      }
      set(px, py);
    }
  }

  function ringsMode(dt: number, active: boolean, onBeat: boolean) {
    const cx = (cols - 1) / 2;
    const cy = (rows - 1) / 2;
    const maxR = Math.hypot(cx, cy) + 1;
    // A tunnel re-thought for the hardware: rings step outward instead of the whole
    // field zooming, so only the ring boundaries flip — ~80 dots a frame rather than
    // all 900. Spawned on the beat, which is also what makes it read as musical.
    if (onBeat && active) rings.push(0);
    if (active && !rings.length) rings.push(0);
    const growth = maxR / 1.6;
    rings = rings.map((r) => r + growth * dt).filter((r) => r <= maxR);
    // Two at a time. A ring's circumference grows with its radius, so three or four
    // alive at once light most of the board and move all of it every frame — measured
    // at 268 dots a frame against the spectrum's 36. Two reads as a tunnel just as well
    // and costs a third of that; the oldest is the one nearest the edge, where it is
    // also the least legible.
    if (rings.length > 2) rings = rings.slice(-2);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const d = Math.hypot(x - cx, y - cy);
        for (const r of rings) {
          if (Math.abs(d - r) <= 0.5) {
            set(x, y);
            break;
          }
        }
      }
    }
  }

  return {
    render(mode, nextCols, nextRows, dt, active, onBeat) {
      resize(nextCols, nextRows);
      if (!cols || !rows) return;
      prev.set(grid);
      grid.fill(0);
      if (mode === "bars") bars(dt, active);
      else if (mode === "scope") scope(active);
      else if (mode === "stars") starfield(dt, active);
      else ringsMode(dt, active, onBeat);
      let changed = 0;
      for (let i = 0; i < grid.length; i++) if (grid[i] !== prev[i]) changed++;
      churn = changed;
    },
    dot(x, y) {
      // Bounds-checked, not just indexed: a flat grid means x === cols reads the first
      // dot of the NEXT row rather than falling off the end, so an off-by-one in a
      // caller would silently mirror the left edge onto the right.
      if (x < 0 || y < 0 || x >= cols || y >= rows) return false;
      return grid[y * cols + x] === 1;
    },
    get churn() {
      return churn;
    },
  };
}
