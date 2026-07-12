<script lang="ts">
  // A 3D spectrum bar chart on a glowbox LED cube (@glowbox/svelte): an 8×8 field
  // of chunky bars standing on the floor, each a log-frequency band (bass at the
  // front, treble at the back), its height the band level. Bars have meter
  // ballistics (fast attack / slow release) and a floating peak-hold cap that
  // drifts down — the classic analyzer look, in 3D. A blue→red heat gradient by
  // height, tips bloom (HDR >1). Idle decays to dark. The grid owns its own WebGL
  // render + orbit; we just write voxels in `draw`.
  import { LedGrid, type LedDisplay } from "@glowbox/svelte";

  import { readSpectrum, sampleBands, SPECTRUM_SIZE } from "./player.svelte";

  let { active = true }: { active?: boolean } = $props();

  const N = 8; // bars per side → N×N = 64 bars
  const FOOT = 2; // bar footprint (LEDs) — chunky blocks
  const STEP = 3; // lattice pitch (footprint + 1 gap)
  const DB_FLOOR = 34; // height is a dB (log) scale over this range below 0 dBFS
  const NX = N * STEP - 1; // 23
  const NY = 24; // bar height range (tall for dramatic, log-scaled bars)
  const NZ = N * STEP - 1; // 23
  const BARS = N * N;

  // Log-spaced FFT bin ranges per band (most energy is low → spread bars over
  // audible content, cap the top bin under Nyquist). One per bar, computed once.
  const TOP_BIN = Math.floor(SPECTRUM_SIZE * 0.7);
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < BARS; i++) {
    const lo = Math.floor(TOP_BIN ** (i / BARS));
    const hi = Math.max(lo + 1, Math.floor(TOP_BIN ** ((i + 1) / BARS)));
    ranges.push([lo, Math.min(hi, SPECTRUM_SIZE)]);
  }

  const buf = new Uint8Array(SPECTRUM_SIZE);
  const levels = new Float32Array(BARS); // smoothed bar heights 0..1
  const peaks = new Float32Array(BARS); // floating peak-hold 0..1

  // Blue → cyan → green → yellow → red heat ramp by height (0..1).
  const STOPS: Array<[number, number, number]> = [
    [0.1, 0.3, 1.0],
    [0.1, 0.9, 0.9],
    [0.2, 1.0, 0.3],
    [1.0, 0.9, 0.15],
    [1.0, 0.25, 0.12],
  ];
  function heat(v: number): [number, number, number] {
    const t = Math.min(0.999, Math.max(0, v)) * (STOPS.length - 1);
    const i = Math.floor(t);
    const f = t - i;
    const a = STOPS[i];
    const b = STOPS[i + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }

  function draw(d: LedDisplay) {
    d.clear();

    const have = active && readSpectrum(buf);
    const pump = 1 + (active ? sampleBands().bass : 0) * 0.25;

    for (let i = 0; i < BARS; i++) {
      let target = 0;
      if (have) {
        const [lo, hi] = ranges[i];
        let sum = 0;
        for (let j = lo; j < hi; j++) sum += buf[j];
        const raw = sum / (hi - lo) / 255;
        // Log (dB) magnitude: quiet high-frequency bins become tall bars instead
        // of a flat back row — the ear hears loudness logarithmically. Normalized
        // from a -DB_FLOOR floor up to 0 dBFS; a gentle tilt still lifts the very top.
        const db = 20 * Math.log10(raw + 1e-6);
        const norm = Math.max(0, (db + DB_FLOOR) / DB_FLOOR);
        const tilt = 0.7 + 0.45 * (i / (BARS - 1)); // extra lift toward the highs
        target = Math.min(1, norm * tilt);
      }
      const lv = levels[i];
      levels[i] = target > lv ? target : lv + (target - lv) * 0.32; // attack/release
      peaks[i] = levels[i] >= peaks[i] ? levels[i] : Math.max(levels[i], peaks[i] - 0.012);

      const bx = i % N;
      const bz = (i / N) | 0;
      const x0 = bx * STEP;
      const z0 = bz * STEP;
      const h = levels[i];
      const barH = Math.round(h * (NY - 1));
      const [r, g, b] = heat(h);

      if (h >= 0.02) {
        const body = 0.28 + 0.5 * h;
        d.box([x0, 0, z0], [x0 + FOOT - 1, barH, z0 + FOOT - 1], [r * body, g * body, b * body]);
        // Slightly brighter top face (blooms just at the cap, not the whole bar).
        const tip = (0.85 + 0.4 * h) * pump;
        d.box([x0, barH, z0], [x0 + FOOT - 1, barH, z0 + FOOT - 1], [r * tip, g * tip, b * tip]);
      }
      // Floating peak-hold cap (bright, hue of its height), a rung above the bar.
      const py = Math.round(peaks[i] * (NY - 1));
      if (py > barH) {
        const [pr, pg, pb] = heat(peaks[i]);
        d.box([x0, py, z0], [x0 + FOOT - 1, py, z0 + FOOT - 1], [pr * 1.4, pg * 1.4, pb * 1.4]);
      }
    }
  }
</script>

<LedGrid
  size={[NX, NY, NZ]}
  {draw}
  led={{ glow: 1.2, shape: "square" }}
  color={{ background: "#04050a", gain: 1.0 }}
  camera={{
    autoOrbit: true,
    orbitSpeed: 0.2,
    pitch: 0.34,
    distance: 4.2,
    projection: "perspective",
  }}
  interaction={{ drag: true, zoom: true }}
/>
