<script lang="ts">
  // A nixie-tube clock visualiser: big glowing tubes showing elapsed play time
  // (M:SS, widening to MM:SS past ten minutes) over @glowbox/svelte's <NixieTube>.
  // The glass pulses to the theme accent on the beat and fades back — driven by
  // bass energy (fast attack / slow release). Idle (paused/stopped) settles to a
  // dark glass and the time holds. Fills the viz body.
  //
  // Namespace import: @glowbox/svelte re-exports `NixieTube` as both a value and a
  // type alias, which trips verbatimModuleSyntax on a named import — reaching it
  // off the namespace value avoids that. (Reported upstream.)
  import * as glowbox from "@glowbox/svelte";

  import { playback, sampleBands } from "./player.svelte";
  import { driveFrames } from "./raf";

  const NixieTube = glowbox.NixieTube;

  let { active = true }: { active?: boolean } = $props();

  const DARK: [number, number, number] = [0.015, 0.015, 0.022]; // unlit glass
  let pulse = $state(0);
  let accent = $state<[number, number, number]>([0.97, 0.56, 0.03]); // theme --accent

  const chars = $derived.by(() => {
    const total = Math.max(0, Math.floor(playback.position || 0));
    const m = Math.floor(total / 60);
    const ss = (total % 60).toString().padStart(2, "0");
    return `${m}:${ss}`.split("");
  });

  // Glass colour: dark → accent by the beat pulse; numerals keep the warm nixie
  // default so they read on either theme's accent.
  const glass = $derived<[number, number, number]>([
    DARK[0] + (accent[0] * 0.75 - DARK[0]) * pulse,
    DARK[1] + (accent[1] * 0.75 - DARK[1]) * pulse,
    DARK[2] + (accent[2] * 0.75 - DARK[2]) * pulse,
  ]);
  const glow = $derived(0.6 + 0.35 * pulse);

  // Parse a `#rgb` / `#rrggbb` (the accent tokens are hex) to [r,g,b] 0..1.
  function parseHex(s: string): [number, number, number] | null {
    const h = s.trim().replace(/^#/, "");
    const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
    if (full.length !== 6 || /[^0-9a-f]/i.test(full)) return null;
    return [
      parseInt(full.slice(0, 2), 16) / 255,
      parseInt(full.slice(2, 4), 16) / 255,
      parseInt(full.slice(4, 6), 16) / 255,
    ];
  }

  $effect(() => {
    const stop = driveFrames(
      (dt) => {
        // Re-read the accent each frame so the theme accent toggle applies live.
        const raw = getComputedStyle(document.documentElement).getPropertyValue("--accent");
        const a = parseHex(raw);
        if (a) accent = a;
        // Fast attack to the current bass, slow release back to dark glass.
        const bass = active ? sampleBands().bass : 0;
        pulse = Math.max(bass, pulse - dt * 1.8);
      },
      { fps: () => (active ? 45 : 20) },
    );
    return stop;
  });
</script>

<div class="nixie-viz" aria-label="play time" data-testid="nixie-viz">
  {#each chars as c, i (i)}
    <div class="tube" class:colon={c === ":"}>
      <NixieTube value={c} tubeStyle="tall" background={glass} {glow} />
    </div>
  {/each}
</div>

<style>
  .nixie-viz {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: min(1.4vw, 16px);
    background: #05060a;
  }
  .tube {
    width: clamp(46px, 11vw, 150px);
    aspect-ratio: 1 / 1.9;
  }
  .tube.colon {
    width: clamp(18px, 4vw, 54px);
  }
</style>
