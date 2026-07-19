<script lang="ts">
  // Paint on a speaker, as a fluid surface — thin wrapper over the three.js scene in
  // ./paint-scene (a height-field wave sim driven by the audio; glossy wet surface +
  // reflections + bloom). Three is lazy-imported (kept out of the main bundle + node
  // tests), like NixieScene. This component feeds the scene five log-spaced spectrum
  // bands (each drives its own radius) + the beat, and the resolved background colour
  // so the scene follows the app's light/dark theme.
  import { theme } from "@scene/design";
  import { onMount } from "svelte";

  import type { PaintScene } from "./paint-scene";
  import { playback, readSpectrum, SPECTRUM_SIZE, spectrumSampleRate } from "./player.svelte";
  import { driveFrames } from "./raf";

  let { active = true }: { active?: boolean } = $props();
  let host: HTMLDivElement;

  onMount(() => {
    let stopped = false;
    let scene: PaintScene | null = null;
    let stopFrames: (() => void) | null = null;

    void (async () => {
      const { createPaintScene } = await import("./paint-scene");
      if (stopped) return;
      scene = createPaintScene(host);
      const bgHex = () =>
        getComputedStyle(document.documentElement).getPropertyValue("--scope-bg").trim() ||
        "#0f0f0f";
      scene.setTheme(bgHex());
      let cachedMode = theme.mode;

      const NBAND = 5;
      const F_MIN = 40;
      const F_MAX = 14000;
      const spec = new Uint8Array(SPECTRUM_SIZE);
      const lev = new Float32Array(NBAND); // eased band levels 0..1
      let lastBeat = -1;

      // The scene renders on its own capped loop; this only feeds it band levels +
      // beats, so a modest rate is plenty (and drops right down when paused).
      stopFrames = driveFrames(
        (dt) => {
          if (active && readSpectrum(spec)) {
            const hzPerBin = spectrumSampleRate() / 2 / SPECTRUM_SIZE;
            for (let i = 0; i < NBAND; i++) {
              const f0 = F_MIN * Math.pow(F_MAX / F_MIN, i / NBAND);
              const f1 = F_MIN * Math.pow(F_MAX / F_MIN, (i + 1) / NBAND);
              const lo = Math.max(1, Math.floor(f0 / hzPerBin));
              const hi = Math.min(SPECTRUM_SIZE, Math.max(lo + 1, Math.ceil(f1 / hzPerBin)));
              let sum = 0;
              for (let j = lo; j < hi; j++) sum += spec[j];
              const v = Math.pow(sum / (hi - lo) / 255, 0.75);
              lev[i] += (v - lev[i]) * (v > lev[i] ? 0.6 : 0.14);
            }
          } else {
            for (let i = 0; i < NBAND; i++) lev[i] *= 0.9;
          }
          scene!.setLevels(lev);
          scene!.setActive(active);
          if (theme.mode !== cachedMode) {
            scene!.setTheme(bgHex());
            cachedMode = theme.mode;
          }
          if (lastBeat < 0) lastBeat = playback.beat;
          else if (playback.beat !== lastBeat) {
            lastBeat = playback.beat;
            scene!.beat();
          }
        },
        { fps: () => (active ? 30 : 8) },
      );
    })();

    return () => {
      stopped = true;
      stopFrames?.();
      scene?.dispose();
    };
  });
</script>

<div class="speaker-paint" bind:this={host} data-testid="speaker-paint"></div>

<style>
  .speaker-paint {
    width: 100%;
    height: 100%;
  }
</style>
