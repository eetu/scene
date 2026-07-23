<script lang="ts">
  // A whisper-subtle generative backdrop for the landing page — the demoscene's
  // signature `plasma` (WebGL, from @anarkisti/igyb) at a very low opacity,
  // drifting slowly, with a faint CRT scanline overlay composed on top (the
  // VGA/CRT nod). Colours are read live from the halo tokens via `paletteFromCSS`,
  // so the field tracks the light/dark theme.
  //
  // Scope: the LANDING route only. The per-party catalog (file lists, the tracker
  // PatternView grid, NFO/DIZ ASCII art, the scope) needs a flat, opaque surface
  // for legibility, so this component is mounted by the landing `+page.svelte` —
  // NOT the root layout. On the landing page itself the card grid sits in a
  // `z-index: 1` layer of opaque cards above this `z-index: 0` backdrop, so it
  // only ever shows through the gutters and margins; text legibility is untouched.
  import {
    type Background,
    layers,
    type Palette,
    paletteFromCSS,
    plasma,
    scanlines,
  } from "@anarkisti/igyb/core";
  import { theme } from "@scene/design";
  import { tick } from "svelte";

  // The subtlety knobs, kept together. `plasma` paints its own `--halo-body`
  // fill, so a layer opacity is really "how much of the plasma's modulation
  // shows over the same body colour" — 0.08 was invisible; 0.3 reads as a gentle
  // wash that, on the real landing, only peeks through the card gutters/margins.
  // Scanlines stay a hair fainter — a CRT texture, never a legible pattern.
  const PLASMA_OPACITY = 0.3;
  const SCANLINE_OPACITY = 0.05;

  let el: HTMLDivElement;

  // Palette read live from the halo tokens (on <html>, where `data-theme` flips
  // them light/dark). Passed to the stack as a *thunk* so `refresh()` can
  // re-invoke it on a theme flip and re-read the tokens in place, rather than
  // tearing the background down. Two accents give the plasma a themed two-tone
  // ramp: the brand orange easing through the muted grey.
  function palette(): Palette {
    return paletteFromCSS({
      bg: "--halo-body",
      fg: "--halo-text-main",
      accents: ["--halo-accent", "--halo-text-muted"],
    });
  }

  let bg: Background | undefined;

  // Build the composed background once. A light/dark flip re-themes it in place
  // (next effect) instead of recreating it. `autoPause` + `reducedMotion` are
  // igyb defaults, set explicitly: the loop idles while the tab/section is hidden,
  // and freezes to a static frame when the user prefers reduced motion.
  $effect(() => {
    bg = layers(
      [
        { pattern: plasma, options: { scale: 2.8 }, opacity: PLASMA_OPACITY },
        { pattern: scanlines, options: { spacing: 3, intensity: 0.5 }, opacity: SCANLINE_OPACITY },
      ],
      {
        theme: palette, // thunk: refresh() re-invokes it to re-read the tokens
        speed: 0.25, // slow, ambient drift
        themeTransition: 0.3, // crossfade the palette on a light/dark flip
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

  // Re-theme in place on a light/dark flip. The root layout writes `data-theme`
  // on <html> from `theme.mode` (and from OS changes while in `auto`); this
  // re-reads the live --halo-* tokens. tick() defers the refresh until after that
  // write lands, so paletteFromCSS reads the new theme's colours, not the previous.
  $effect(() => {
    theme.mode;
    theme.accent;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onFlip = () => void tick().then(() => bg?.refresh());
    mq.addEventListener("change", onFlip); // OS flip while in `auto`
    void tick().then(() => bg?.refresh());
    return () => mq.removeEventListener("change", onFlip);
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
