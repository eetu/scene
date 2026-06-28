<script lang="ts">
  import "@fontsource-variable/inter";
  import "@scene/design/halo.css";
  import "$lib/player-host"; // register the @scene/player host once, before playback

  import { theme } from "@scene/design";
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();

  // Resolve the chosen mode to an effective 'light'/'dark' and apply it as
  // data-theme on <html>. Only `auto` follows the system; it then re-resolves
  // live when the OS appearance flips.
  $effect(() => {
    const mode = theme.mode;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const eff = mode === "auto" ? (mq.matches ? "dark" : "light") : mode;
      document.documentElement.dataset.theme = eff;
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", eff === "light" ? "#f0f0f0" : "#0f0f0f");
    };
    apply();
    if (mode === "auto") {
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  });
</script>

{@render children()}

<style>
  /* Authentic Amiga system font (TopazPlus a1200, 8×16 bitmap) for the tracker
	   surfaces — self-hosted, GPL Font Exception. github.com/rewtnull/amigafonts */
  @font-face {
    font-family: "TopazPlus";
    src: url("/fonts/TopazPlus_a1200_v1.0.ttf") format("truetype");
    font-display: swap;
  }

  /* Exact CP437 VGA text font (PxPlus/WebPlus IBM VGA 8×16) for DOS-era NFO/DIZ
	   art — box-drawing glyphs fill the cell and tile seamlessly. Self-hosted,
	   CC BY-SA 4.0 by VileR / int10h.org (Ultimate Oldschool PC Font Pack). */
  @font-face {
    font-family: "IBM VGA";
    src: url("/fonts/WebPlus_IBM_VGA_8x16.woff") format("woff");
    font-display: swap;
  }

  /* App tokens are a thin mapping onto the halo-design palette (halo.css). The
	   --halo-* vars flip with data-theme, so this single block covers both
	   themes — no per-theme overrides needed here. */
  :global(:root) {
    --bg: var(--halo-body);
    --panel: var(--halo-bg-main);
    --panel-hi: var(--halo-off-bg);
    --border: var(--halo-border);
    --text: var(--halo-text-main);
    --muted: var(--halo-text-muted);
    --accent: var(--halo-accent);
    --accent-dim: var(--halo-accent-soft);
    /* Player surface (pattern grid + scope overlay), derived from halo. */
    --surface: var(--halo-body);
    --surface-2: var(--halo-bg-light);
    --surface-bar: var(--halo-bg-light);
    --surface-line: var(--halo-border);
    --surface-line-2: var(--halo-off-bg);
    --surface-fg: var(--halo-text-muted);
    --surface-fg-beat: var(--halo-text-main);
    --surface-fg-active: var(--halo-text-main);
    --surface-fg-dim: var(--halo-text-light);
    --scope-bg: var(--halo-body);
    --scope-grid: var(--halo-off-bg);
    /* The CP437 VGA pixel font is the neutral retro identity — app chrome,
		   tracker grids, NFO/DIZ art. The Amiga TopazPlus font is reserved for
		   Amiga-platform content (--font-amiga), opted into by the player when an
		   Amiga production is open. Inter (halo body font) for prose UI. */
    --font-retro: "IBM VGA", ui-monospace, monospace;
    --font-mono-retro: "IBM VGA", ui-monospace, monospace;
    --font-dos: "IBM VGA", ui-monospace, monospace;
    --font-amiga: "TopazPlus", ui-monospace, monospace;
    font-family: var(--halo-font-body);
  }

  :global(*) {
    box-sizing: border-box;
  }

  /* The app owns the viewport: header + scrolling <main> + fixed transport.
	   <main> is the scroll container (TanStack Virtual scrolls it), so the body
	   itself never scrolls — no phantom page scrollbar behind the player overlay. */
  :global(html),
  :global(body) {
    height: 100%;
  }
  :global(body) {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-size: 14px;
    -webkit-font-smoothing: antialiased;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  /* SvelteKit mounts into a display:contents wrapper, so header/main/transport
	   become the body flex items directly. */

  :global(button) {
    font: inherit;
  }

  /* Lucide icons: square the caps/joins and thicken the stroke so they read as
	   blocky/retro alongside the pixel fonts (the default round strokes clash). */
  :global(button svg) {
    display: block;
    stroke-width: 2.5;
    stroke-linecap: square;
    stroke-linejoin: miter;
  }
</style>
