<script lang="ts">
  // The 3D nixie-tube stopwatch viz: bent-wire cathodes stacked in depth inside
  // glass tubes on a stand, orbiting, showing MM:SS:CC of play time. The WebGL work
  // (geometry, bloom, orbit) lives in ./nixie-gl. This component just feeds it: the
  // smooth clock (advanced by frame dt, re-synced to playback.position on a seek),
  // the theme accent as the glow colour, and bass energy as a pulse that throbs the
  // glow + bloom.
  //
  // Intentionally dark: glowing tubes read only in the dark (nixie-gl even clamps
  // the backdrop brightness), so this does NOT follow the app's light/dark theme —
  // it only tracks --accent for the glow colour.
  import { onMount } from "svelte";

  import { accentHex } from "./accent";
  import { createNixieScene, type NixieScene } from "./nixie-gl";
  import { playback, sampleBands } from "./player.svelte";
  import { driveFrames } from "./raf";

  let { active = true }: { active?: boolean } = $props();
  let host: HTMLDivElement;

  // MM:SS:CC → 8 chars; slots 2 and 5 are the colons (matches the scene's layout).
  function timeDigits(total: number): string[] {
    const t = Math.max(0, total);
    const mm = Math.min(99, Math.floor(t / 60))
      .toString()
      .padStart(2, "0");
    const ss = Math.floor(t % 60)
      .toString()
      .padStart(2, "0");
    const cc = Math.floor((t * 100) % 100)
      .toString()
      .padStart(2, "0");
    return `${mm}:${ss}:${cc}`.split("");
  }
  // Built synchronously — no lazy import. The scene is a few hundred lines of our
  // own WebGL now rather than three.js, small enough to live in the main bundle,
  // which is what stopped selecting this viz from stalling the whole app while a
  // 700KB chunk parsed.
  onMount(() => {
    const scene = createNixieScene(host, {
      digits: timeDigits(playback.position || 0),
      color: accentHex(),
      glass: "#0b0f15",
      backdrop: "#05060a",
      style: "tall",
    });

    let pulse = 0;
    let shown = 0; // smooth elapsed seconds
    let lastColor = "";
    let lastStr = "";
    const stopFrames = driveFrames(
      (dt) => {
        pulse = Math.max(active ? sampleBands().bass : 0, pulse - dt * 1.6);
        scene.setPulse(pulse);
        scene.setActive(active); // idle-throttle the scene's own render loop

        const col = accentHex();
        if (col !== lastColor) {
          scene.setOptions({ color: col });
          lastColor = col;
        }

        const pos = playback.position || 0;
        if (active) {
          shown += dt;
          if (Math.abs(shown - pos) > 0.3) shown = pos;
        } else {
          shown = pos;
        }
        const str = timeDigits(shown).join("");
        if (str !== lastStr) {
          scene.setDigits(str.split(""));
          lastStr = str;
        }
      },
      // The scene renders on its own capped loop; this only feeds it, so a
      // modest rate is plenty (and drops right down when paused).
      { fps: () => (active ? 30 : 10) },
    );

    return () => {
      stopFrames();
      scene.dispose();
    };
  });
</script>

<div class="nixie-scene" bind:this={host} data-testid="nixie-scene"></div>

<style>
  .nixie-scene {
    width: 100%;
    height: 100%;
    min-height: 0;
    background: #05060a;
  }
</style>
