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
  import { reelFrameAt, sampleReel, watchReel } from "./reel";
  import { playback } from "./state.svelte";

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

  /**
   * The clip for this track, if there is one — the same easter egg the flip board and
   * the deck's VFD carry, on the display that can hold the most of it.
   *
   * A film is a flat thing, so it is ONE plane of voxels rather than a slab extruded
   * through the depth: the cube is deep enough to make a shadow sculpture out of a
   * silhouette, and the result reads as a smear of the picture rather than as the
   * picture. One plane and a squared camera is a screen; that is what a film wants.
   */
  const reels = watchReel(playback);
  let reel = $state.raw(reels.reel);
  /** Grid size while a reel plays: the clip's own shape, one deep, capped so a big clip
   *  cannot ask the renderer for more LEDs than the bars ever do. */
  const REEL_MAX = 64;
  const reelSize = $derived.by((): [number, number, number] | null => {
    if (!reel) return null;
    const scale = Math.min(1, REEL_MAX / Math.max(reel.cols, reel.rows));
    return [
      Math.max(1, Math.round(reel.cols * scale)),
      Math.max(1, Math.round(reel.rows * scale)),
      1,
    ];
  });
  const size = $derived<[number, number, number]>(reelSize ?? [NX, NY, NZ]);
  let reelGrid = new Uint8Array(0);

  // The pane, for framing the film. Bound rather than observed: Svelte does the
  // ResizeObserver, and the cube itself needs no size — only the reel does.
  let paneW = $state(0);
  let paneH = $state(0);

  /**
   * How far back to stand for a film.
   *
   * The renderer frames orthographically off the VERTICAL extent, so a distance that
   * fills a wide pane crops the sides off a tall one — measured, not assumed: at 1.8 a
   * 48×36 plane rendered 522 wide in a 900-wide pane and ran off the edge of a 420-wide
   * one. So the pane's aspect has to be paid for whenever it is narrower than the
   * clip's, and a phone gets a smaller picture rather than a cropped one.
   */
  const REEL_FILL = 1.8;
  const reelDistance = $derived.by(() => {
    if (!reelSize || !paneW || !paneH) return REEL_FILL;
    const clip = reelSize[0] / reelSize[1];
    const pane = paneW / paneH;
    return REEL_FILL * Math.max(1, clip / pane);
  });

  function drawReel(d: LedDisplay) {
    const r = reel;
    if (!r) return;
    const nx = d.nx;
    const ny = d.ny;
    if (reelGrid.length !== nx * ny) reelGrid = new Uint8Array(nx * ny);
    // Where the film is up to is where the playhead is, never a clock of its own.
    sampleReel(r, reelFrameAt(r, playback.position), nx, ny, reelGrid);
    for (let y = 0; y < ny; y++) {
      // The grid's rows run BOTTOM-up and the film's run top-down, so the picture has
      // to be flipped or it plays upside down.
      const row = (ny - 1 - y) * nx;
      for (let x = 0; x < nx; x++) {
        if (!reelGrid[row + x]) continue;
        d.plot(x, y, 0, [1, 0.94, 0.82]);
      }
    }
  }

  function draw(d: LedDisplay) {
    d.clear();
    reels.poll();
    reel = reels.reel;
    if (reel) {
      drawReel(d);
      return;
    }

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

<!-- A wrapper only so the pane can be measured: the film's framing depends on the pane's
     aspect (see `reelDistance`), and the grid owns its own canvas. -->
<div class="cube" bind:clientWidth={paneW} bind:clientHeight={paneH}>
  {#if LedGrid}
    <LedGrid
      {size}
      {draw}
      led={{ style: "comic", shape: "square", size: 0.9, outline: 0.28 }}
      color={{ background: bg, gain: 1.0 }}
      camera={{
        // A film is watched square-on: one plane of voxels seen from an orbiting camera
        // is edge-on, and therefore invisible, twice a revolution. Drag and zoom are
        // still live, so the cube can be turned by hand — it just does not turn itself
        // while there is something to read on it.
        autoOrbit: !reel,
        orbitSpeed: 0.2,
        // The wrapper patches each option group on its own and re-sending `camera`
        // snaps the view, which is exactly what is wanted at both ends of a reel:
        // square-on when it starts, back to the bars' opening angle when it finishes.
        yaw: reel ? 0 : 0.6,
        pitch: reel ? 0 : 0.34,
        // Closer than before (4.2), which left most of a wide pane as empty air. Not
        // closer than this: the camera orbits the grid's centre and the bars grow from
        // its floor, so zooming magnifies that downward offset and starts cutting the
        // bars off the bottom — 3.5 clips, 3.9 doesn't. The mass sitting below centre
        // is the dB range's headroom, not the camera, and is left alone.
        distance: reel ? reelDistance : 3.9,
        // Orthographic for a film. Perspective on a flat plane seen square-on tapers the
        // outer columns and reads as a keystone, which is the one thing a screen is not.
        projection: reel ? "orthographic" : "perspective",
      }}
      interaction={{ drag: true, zoom: true }}
      quality={{ fps: vizFps(active) }}
    />
  {/if}
</div>

<style>
  /* Fills the pane and nothing else: the grid's canvas does its own block/fill sizing,
     so this exists purely to be measured. */
  .cube {
    width: 100%;
    height: 100%;
    min-height: 0;
  }
</style>
