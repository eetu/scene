<script lang="ts">
  // Polar "harmonic" scope — a homage to Symphonie Pro's Spectrum Analyzer in its
  // Harmony mode. Instead of a left→right bar spectrum, frequency is wrapped
  // around a circle by musical pitch: the ANGLE is the pitch class (note within an
  // octave, C at top), the RING is the octave. So the same note in different
  // octaves lines up radially and chords fall into angular patterns — you read the
  // harmony, not just the level. A fixed nested-polygon grid (one faceted ring per
  // octave) is the scale; the live FFT peaks are plotted as glowing dots on it.
  import { readSpectrum, SPECTRUM_SIZE, spectrumSampleRate } from "./player.svelte";
  import { driveFrames } from "./raf";

  let { active = true }: { active?: boolean } = $props();

  let canvas: HTMLCanvasElement | null = $state(null);

  // Musical range: C1 (~32 Hz) up seven octaves to C8 (~4186 Hz) — covers all a
  // module realistically puts out and gives ~7 rings, like Symphonie's display.
  const MIN_MIDI = 24;
  const OCTAVES = 7;
  // One slot per semitone (12 per octave) — dots land on actual notes and the
  // display stays sparse, rather than a dense ring of quarter-tones.
  const SLOTS = 12;
  // Gate the analyser noise floor: with the store's -90..-10 dB window a byte
  // magnitude maps to `(dB + 90) / 80`, so ~-56 dB (a typical noise floor) is
  // ~0.42. Anything below reads as "not sounding" and lights nothing — without
  // this the broadband floor lit almost every dot at once.
  const NOISE = 0.42;
  const CELLS = OCTAVES * SLOTS;
  // Faceted rings (like the original's polygonal look), scale reference only.
  const GRID_SIDES = 16;

  $effect(() => {
    const el = canvas;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const g2: CanvasRenderingContext2D = ctx;

    let w = 0;
    let h = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      w = r.width;
      h = r.height;
      el.width = Math.max(1, Math.round(w * dpr));
      el.height = Math.max(1, Math.round(h * dpr));
      g2.setTransform(dpr, 0, 0, dpr, 0, 0);
    });
    ro.observe(el);

    const buf = new Uint8Array(SPECTRUM_SIZE);
    const cellTarget = new Float32Array(CELLS);
    const levels = new Float32Array(CELLS);

    // Map each FFT bin to a cell (octave ring × pitch slot), rebuilt if the sample
    // rate ever changes (it's fixed once the graph is up). -1 = out of range.
    let binCell = new Int16Array(0);
    let rateUsed = 0;
    function buildBinMap(rate: number) {
      const hzPerBin = rate / 2 / SPECTRUM_SIZE;
      const map = new Int16Array(SPECTRUM_SIZE).fill(-1);
      for (let i = 1; i < SPECTRUM_SIZE; i++) {
        const freq = i * hzPerBin;
        if (freq < 20) continue;
        const rel = 69 + 12 * Math.log2(freq / 440) - MIN_MIDI; // semitones above C1
        if (rel < 0) continue;
        const ring = Math.floor(rel / 12);
        if (ring >= OCTAVES) continue;
        const pc = rel - ring * 12; // 0..12 within the octave
        const slot = Math.min(SLOTS - 1, Math.floor((pc / 12) * SLOTS));
        map[i] = ring * SLOTS + slot;
      }
      binCell = map;
      rateUsed = rate;
    }

    let cachedMode: string | null = null;
    let light = false;
    let cBg = "#08080f";
    let cGrid = "#2a2a3a";
    let cAccent = "#f78f08";
    const node: HTMLCanvasElement = el;
    function refreshColors() {
      const cs = getComputedStyle(node);
      cBg = cs.getPropertyValue("--scope-bg").trim() || cBg;
      cGrid = cs.getPropertyValue("--scope-grid").trim() || cGrid;
      cAccent = cs.getPropertyValue("--accent").trim() || cAccent;
      light = document.documentElement.dataset.theme === "light";
    }

    // A faceted ring (ellipse-fitted polygon) at radius fraction `frac` of the
    // panel — the octave grid the dots sit on.
    function ringPath(cx: number, cy: number, rx: number, ry: number, frac: number) {
      g2.beginPath();
      for (let k = 0; k <= GRID_SIDES; k++) {
        const a = (k / GRID_SIDES) * Math.PI * 2 - Math.PI / 2;
        const x = cx + Math.cos(a) * rx * frac;
        const y = cy + Math.sin(a) * ry * frac;
        if (k === 0) g2.moveTo(x, y);
        else g2.lineTo(x, y);
      }
    }

    const stopFrames = driveFrames(
      () => {
        const mode = document.documentElement.dataset.theme ?? "";
        if (mode !== cachedMode) {
          refreshColors();
          cachedMode = mode;
        }
        if (w <= 0 || h <= 0) return;

        const rate = spectrumSampleRate();
        if (rate !== rateUsed) buildBinMap(rate);

        g2.globalCompositeOperation = "source-over";
        g2.globalAlpha = 1;
        g2.fillStyle = cBg;
        g2.fillRect(0, 0, w, h);

        const cx = w / 2;
        const cy = h / 2;
        // Fill the (usually wide) panel as an ellipse, leaving a small margin.
        const rx = (w / 2) * 0.94;
        const ry = (h / 2) * 0.9;
        // Scale strokes + dots to the panel so they don't shrink to specks on a
        // big screen (sizes below are fractions of this).
        const unit = Math.min(rx, ry);
        // Octave → radius fraction (innermost = lowest octave, small centre gap).
        const frac = (r: number) => 0.14 + 0.86 * ((r + 1) / OCTAVES);

        // Static octave grid.
        g2.strokeStyle = cGrid;
        g2.lineWidth = Math.max(1, unit * 0.004);
        g2.globalAlpha = light ? 0.55 : 0.4;
        for (let r = 0; r < OCTAVES; r++) {
          ringPath(cx, cy, rx, ry, frac(r));
          g2.stroke();
        }
        g2.globalAlpha = 1;

        // Fold the current spectrum into cells — the peak bin magnitude of each
        // note (octave ring × semitone).
        cellTarget.fill(0);
        const have = active && readSpectrum(buf);
        if (have) {
          for (let i = 1; i < SPECTRUM_SIZE; i++) {
            const c = binCell[i];
            if (c < 0) continue;
            if (buf[i] > cellTarget[c]) cellTarget[c] = buf[i];
          }
        }

        // Gate the noise floor, tilt for octave, run meter ballistics — then only
        // the genuinely-sounding notes (fundamentals + their harmonics) survive.
        for (let c = 0; c < CELLS; c++) {
          const ring = (c / SLOTS) | 0;
          const raw = cellTarget[c] / 255;
          const gated = raw > NOISE ? (raw - NOISE) / (1 - NOISE) : 0;
          // Bass dominates the FFT; a gentle tilt lets higher octaves still read.
          const tilt = 0.7 + 0.5 * (ring / (OCTAVES - 1));
          const target = Math.min(1, gated * tilt);
          const lv = levels[c];
          levels[c] = target > lv ? target : lv + (target - lv) * 0.28; // instant attack, eased release
        }

        // Plot the lit notes as dots on their octave ring.
        for (let c = 0; c < CELLS; c++) {
          const level = levels[c];
          if (level < 0.06) continue;
          const ring = (c / SLOTS) | 0;
          const slot = c - ring * SLOTS;
          const a = ((slot + 0.5) / SLOTS) * Math.PI * 2 - Math.PI / 2; // C at top
          const fr = frac(ring);
          const x = cx + Math.cos(a) * rx * fr;
          const y = cy + Math.sin(a) * ry * fr;
          const dot = Math.max(2.5, unit * (0.014 + level * 0.03));

          g2.beginPath();
          g2.arc(x, y, dot, 0, Math.PI * 2);
          g2.fillStyle = cAccent;
          g2.globalAlpha = 0.45 + level * 0.55;
          g2.shadowColor = cAccent;
          g2.shadowBlur = light ? 0 : dot * 1.3;
          g2.fill();
        }
        g2.shadowBlur = 0;
        g2.globalAlpha = 1;
      },
      { active: () => active },
    );

    return () => {
      stopFrames();
      ro.disconnect();
    };
  });
</script>

<canvas bind:this={canvas}></canvas>

<style>
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
