<script lang="ts">
  // A whisper-subtle generative backdrop for the landing page — flowing `waveLines`
  // (from @anarkisti/igyb) with a faint CRT scanline overlay composed on top (the
  // VGA/CRT nod). Chosen over `plasma` because a geometric line field still reads as
  // an intentional texture when frozen — so respecting `prefers-reduced-motion` (a
  // static frame) loses nothing. Uses a fixed `mono` palette (theme-independent greys).
  //
  // Scope: the LANDING route only. The per-party catalog (file lists, the tracker
  // PatternView grid, NFO/DIZ ASCII art, the scope) needs a flat, opaque surface
  // for legibility, so this component is mounted by the landing `+page.svelte` —
  // NOT the root layout. On the landing page itself the card grid sits in a
  // `z-index: 1` layer of opaque cards above this `z-index: 0` backdrop, so it
  // only ever shows through the gutters and margins; text legibility is untouched.
  import { type Background, layers, scanlines, waveLines } from "@anarkisti/igyb/core";

  // The subtlety knobs, kept together. waveLines paints its own bg fill, so the layer
  // opacity is "how much of the accent lines show over the body colour" — 0.35 reads
  // as a gentle line texture that, on the real landing, only peeks through the card
  // gutters/margins. Scanlines stay a hair fainter — a CRT texture, never legible.
  const WAVE_OPACITY = 0.35;
  const SCANLINE_OPACITY = 0.05;

  let el: HTMLDivElement;
  let bg: Background | undefined;

  // Build the composed background once. `autoPause` + `reducedMotion` are igyb
  // defaults, set explicitly: the loop idles while the tab is hidden, and freezes to
  // a static frame under prefers-reduced-motion (the line texture still reads static).
  $effect(() => {
    bg = layers(
      [
        { pattern: waveLines, options: { spacing: 20, amplitude: 1 }, opacity: WAVE_OPACITY },
        { pattern: scanlines, options: { spacing: 3, intensity: 0.5 }, opacity: SCANLINE_OPACITY },
      ],
      {
        theme: "mono", // fixed monochrome greys, independent of the app's light/dark
        speed: 0.4, // gentle ambient drift
        // The lines bulge toward the pointer — a subtle "push the curtain" reaction.
        // pointerSource:'window' because this layer is pointer-events:none behind the
        // cards, so it must track the mouse globally (the dice-background trick).
        interactive: true,
        pointerSource: "window",
        autoPause: true,
        reducedMotion: "respect",
      },
    )(el);
    bg.start();
    return () => {
      bg?.destroy();
      bg = undefined;
    };
  });
</script>

<div class="party-bg" aria-hidden="true">
  <div bind:this={el} class="field"></div>
</div>

<style>
  .party-bg {
    position: fixed;
    inset: 0;
    z-index: 0;
    overflow: hidden;
    pointer-events: none;
  }
  .field {
    position: absolute;
    inset: 0;
  }
</style>
