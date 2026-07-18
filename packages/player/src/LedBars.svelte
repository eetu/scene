<script lang="ts">
  // A 3D spectrum bar chart on a glowbox LED cube (@glowbox/svelte): an 8×8 field
  // of chunky bars standing on the floor. Frequency is anchored to a corner — a
  // bar's band is its diagonal distance from the near corner (bx+bz), so bass sits
  // at that corner and the spectrum compounds outward in ridges toward the far
  // corner. Height is a dB (log) magnitude with meter ballistics (fast attack /
  // slow release) + a floating peak-hold cap; a blue→red heat gradient by height,
  // tips bloom (HDR >1). Idle decays to dark. The grid owns its own WebGL render +
  // orbit; we just write voxels in `draw`.
  // @glowbox/svelte's index re-exports the nixie component, which touches Path2D
  // at import — fine in a browser, but it crashes node unit tests that transitively
  // import @scene/player. So the value (LedGrid) is lazy-imported in onMount (also
  // keeps it out of the main bundle); only the type is imported statically.
  import type { LedDisplay } from "@glowbox/svelte";
  import { theme } from "@scene/design";
  import { onMount } from "svelte";

  import { vizFps } from "./perf.svelte";
  import { readSpectrum, sampleBands, SPECTRUM_SIZE } from "./player.svelte";

  let { active = true }: { active?: boolean } = $props();

  type LedGridComponent = (typeof import("@glowbox/svelte"))["LedGrid"];
  let LedGrid = $state<LedGridComponent | null>(null);
  onMount(async () => {
    LedGrid = (await import("@glowbox/svelte")).LedGrid;
  });

  // The cube's background follows the app theme like the other panel viz: read the
  // resolved --scope-bg token off :root, re-reading whenever the theme flips. (The
  // LED heat colours themselves stay theme-independent — LEDs are LEDs.)
  let bg = $state("#04050a");
  $effect(() => {
    theme.mode; // re-read on a theme flip
    const v = getComputedStyle(document.documentElement).getPropertyValue("--scope-bg").trim();
    if (v) bg = v;
  });

  const N = 8; // bars per side → N×N = 64 bars
  const FOOT = 2; // bar footprint (LEDs) — chunky blocks
  const STEP = 3; // lattice pitch (footprint + 1 gap)
  const DB_FLOOR = 34; // height is a dB (log) scale over this range below 0 dBFS
  const NX = N * STEP - 1; // 23
  const NY = 24; // bar height range (tall for dramatic, log-scaled bars)
  const NZ = N * STEP - 1; // 23
  const NB = 2 * N - 1; // frequency bands = diagonals from the corner (bx+bz: 0..14)

  // Log-spaced FFT bin ranges per band — most energy is low, so spread the bands
  // over audible content and cap the top bin under Nyquist. One per diagonal.
  const TOP_BIN = Math.floor(SPECTRUM_SIZE * 0.7);
  const ranges: Array<[number, number]> = [];
  for (let b = 0; b < NB; b++) {
    const lo = Math.floor(TOP_BIN ** (b / NB));
    const hi = Math.max(lo + 1, Math.floor(TOP_BIN ** ((b + 1) / NB)));
    ranges.push([lo, Math.min(hi, SPECTRUM_SIZE)]);
  }

  const buf = new Uint8Array(SPECTRUM_SIZE);
  const bandRaw = new Float32Array(NB); // this-frame dB norm per band
  const levels = new Float32Array(NB); // smoothed band heights 0..1 (post-AGC)
  const peaks = new Float32Array(NB); // floating peak-hold 0..1
  let ref = 0.4; // adaptive loudness reference for the AGC (see draw)

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

    // Pass 1 — per-band dB (log) magnitude, and the loudest band this frame.
    let curMax = 0;
    for (let b = 0; b < NB; b++) {
      let dbn = 0;
      if (have) {
        const [lo, hi] = ranges[b];
        let sum = 0;
        for (let j = lo; j < hi; j++) sum += buf[j];
        const raw = sum / (hi - lo) / 255;
        const db = 20 * Math.log10(raw + 1e-6);
        dbn = Math.min(1, Math.max(0, (db + DB_FLOOR) / DB_FLOOR));
      }
      bandRaw[b] = dbn;
      if (dbn > curMax) curMax = dbn;
    }

    // AGC: track an adaptive reference (fast attack, slow release, floored so a
    // quiet passage doesn't amplify noise). Normalizing to it — with headroom, so
    // the loudest band tops out ~0.9, not pegged — turns the field into a relative
    // spectral landscape instead of a solid, saturated cube. Log-scale alone can't
    // do this: on a loud broadband tune every band hits the ceiling.
    ref += (curMax - ref) * (curMax > ref ? 0.4 : 0.03);
    const denom = Math.max(ref, 0.4);
    for (let b = 0; b < NB; b++) {
      // Normalize to the reference, then cut the base + curve it so only bands
      // near this frame's peak rise and the rest fall to dark — that contrast is
      // what stops a loud broadband beat from filling the whole cube.
      const rel = bandRaw[b] / denom;
      const shaped = Math.max(0, (rel - 0.3) / 0.7);
      const target = Math.min(1, shaped ** 1.6 * 0.95);
      const lv = levels[b];
      levels[b] = target > lv ? target : lv + (target - lv) * 0.32; // attack/release
      peaks[b] = levels[b] >= peaks[b] ? levels[b] : Math.max(levels[b], peaks[b] - 0.012);
    }

    // Draw the field — each cell's band is its diagonal distance from the corner.
    for (let bz = 0; bz < N; bz++) {
      for (let bx = 0; bx < N; bx++) {
        const b = bx + bz;
        const h = levels[b];
        const x0 = bx * STEP;
        const z0 = bz * STEP;
        const barH = Math.round(h * (NY - 1));
        const [r, g, bl] = heat(h);

        if (h >= 0.02) {
          const body = 0.28 + 0.5 * h;
          d.box([x0, 0, z0], [x0 + FOOT - 1, barH, z0 + FOOT - 1], [r * body, g * body, bl * body]);
          const tip = (0.85 + 0.4 * h) * pump; // bloom just at the cap
          d.box([x0, barH, z0], [x0 + FOOT - 1, barH, z0 + FOOT - 1], [r * tip, g * tip, bl * tip]);
        }
        const py = Math.round(peaks[b] * (NY - 1));
        if (py > barH) {
          const [pr, pg, pb] = heat(peaks[b]);
          d.box([x0, py, z0], [x0 + FOOT - 1, py, z0 + FOOT - 1], [pr * 1.4, pg * 1.4, pb * 1.4]);
        }
      }
    }
  }
</script>

{#if LedGrid}
  <LedGrid
    size={[NX, NY, NZ]}
    {draw}
    led={{ style: "comic", shape: "square", size: 0.9, outline: 0.28 }}
    color={{ background: bg, gain: 1.0 }}
    camera={{
      autoOrbit: true,
      orbitSpeed: 0.2,
      pitch: 0.34,
      distance: 4.2,
      projection: "perspective",
    }}
    interaction={{ drag: true, zoom: true }}
    quality={{ fps: vizFps(active) }}
  />
{/if}
