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

  // Accent (orange/purple) is a separate axis — apply it as data-accent on <html>.
  $effect(() => {
    document.documentElement.dataset.accent = theme.accent;
  });

  // iOS standalone caches a stale value for the CSS viewport units (100dvh/100vh)
  // at launch — the shell shows a band until the first viewport change (a manual
  // rotate fixes it). window.innerHeight stays reliable, so mirror it into a CSS
  // var and keep it current; the shell then fills the screen without a rotate.
  $effect(() => {
    const setH = () =>
      document.documentElement.style.setProperty("--app-height", `${window.innerHeight}px`);
    setH();
    const raf = requestAnimationFrame(setH);
    window.addEventListener("resize", setH);
    window.addEventListener("orientationchange", setH);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", setH);
      window.removeEventListener("orientationchange", setH);
    };
  });
</script>

{@render children()}

<style>
  /* Authentic Amiga system font (TopazPlus a1200, 8×16 bitmap) for the retro
	   surfaces — self-hosted, GPL Font Exception. github.com/rewtnull/amigafonts */
  @font-face {
    font-family: "TopazPlus";
    src: url("/fonts/TopazPlus_a1200_v1.0.ttf") format("truetype");
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
    /* tracker keeps its retro identity: Amiga TopazPlus on the player
		   surfaces, Inter (halo body font) everywhere else. */
    --font-retro: "TopazPlus", ui-monospace, monospace;
    --font-mono-retro: "TopazPlus", ui-monospace, monospace;
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
    /* Fill the real screen in an iOS standalone app, where height:100% resolves
       to the *safe-area* box and anchors content at the top (header under the
       status bar, dead band at the bottom). --app-height is set from
       window.innerHeight by the layout — reliable even when iOS caches stale
       100dvh/100vh at launch; 100dvh/100% are the pre-JS + no-dvh fallbacks. The
       env() insets then pad content off the notch + home indicator. */
    height: 100%;
    height: 100dvh;
    height: var(--app-height, 100dvh);
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

  /* Themed base for every native button + select in the app — the single source
     of truth (scoped styles don't cross component boundaries, so this used to be
     copy-pasted into each component and drifted). Component classes
     (.tabs / .seg / .ok / .pv-* / .t-btn / .fav / .row …) override on specificity;
     inputs keep their context-specific sizing where they're used. */
  :global(button),
  :global(select) {
    font: inherit;
    background: var(--panel-hi);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 5px 10px;
    cursor: pointer;
  }
  :global(button:disabled),
  :global(select:disabled) {
    opacity: 0.6;
    cursor: default;
  }
  @media (max-width: 640px) {
    :global(button),
    :global(select) {
      padding: 8px 12px;
    }
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
