<script module lang="ts">
  // Party's enabled visualizers (its own set — the tracker keeps a separate list).
  type VizMode =
    | "vu"
    | "bars"
    | "wave"
    | "stars"
    | "copper"
    | "plasma"
    | "tunnel"
    | "disco"
    | "ball";
  const VIZ: VizMode[] = [
    "vu",
    "bars",
    "wave",
    "stars",
    "copper",
    "plasma",
    "tunnel",
    "disco",
    "ball",
  ];

  // Persist the stage's tab + visualizer across remounts. The party rebuilds this
  // player whenever next/prev/auto-advance advances the track: the detail pane
  // briefly unmounts while the next production's detail loads. Without persisting,
  // the stage would snap back to the pattern tab (and default viz) on every song
  // change, regardless of what the listener was watching.
  let savedTab: "pattern" | "samples" | "viz" = "pattern";
  let savedViz: VizMode = "vu";
</script>

<script lang="ts">
  // The player "stage": a partial header of tabs (pattern / samples / viz) over
  // a content area that switches between the scrolling pattern grid + scope, the
  // instrument/sample name lists, and the visualizers. The "viz" tab holds its
  // own sub-selector for the equalizer bars and the Amiga boing ball. Fills its
  // container's height. Pair it with <Transport/>. Shared by tracker + party.
  import BoingBall from "./BoingBall.svelte";
  import CopperBars from "./CopperBars.svelte";
  import DiscoBall from "./DiscoBall.svelte";
  import Equalizer from "./Equalizer.svelte";
  import GlowWave from "./GlowWave.svelte";
  import PatternView from "./PatternView.svelte";
  import { playback } from "./player.svelte";
  import Plasma from "./Plasma.svelte";
  import SampleBrowser from "./SampleBrowser.svelte";
  import Scope from "./Scope.svelte";
  import Starfield from "./Starfield.svelte";
  import Tunnel from "./Tunnel.svelte";
  import VuMeters from "./VuMeters.svelte";

  let { tab = $bindable(savedTab) } = $props();
  // Which visualizer the "viz" tab shows. Persists across tab switches — and,
  // via the module-scoped saves below, across remounts (song changes).
  let vizMode = $state<VizMode>(savedViz);

  // Remember the current view so a remount restores it (see the module script).
  $effect(() => {
    savedTab = tab;
    savedViz = vizMode;
  });

  const energy = $derived(playback.vu.length ? Math.max(...playback.vu) : 0);
  const playing = $derived(playback.playing && !playback.paused);

  // Module format (file extension) — drives the boing ball's pixelation.
  const format = $derived.by(() => {
    const f = playback.current?.filename ?? "";
    const dot = f.lastIndexOf(".");
    return dot >= 0 ? f.slice(dot + 1).toLowerCase() : "";
  });

  // 'f' fullscreens the viz view (only while the viz tab is active). In fullscreen
  // the picker auto-hides as a top drawer after a pause and returns on movement.
  let vizEl = $state<HTMLElement | undefined>(undefined);
  let vizFs = $state(false);
  let pickerShown = $state(true);
  let pickerTimer: ReturnType<typeof setTimeout> | null = null;
  function schedulePickerHide() {
    if (pickerTimer) clearTimeout(pickerTimer);
    pickerTimer = setTimeout(() => {
      if (vizFs) pickerShown = false;
    }, 2500);
  }
  function revealPicker() {
    pickerShown = true;
    if (vizFs) schedulePickerHide();
  }
  function onFsChange() {
    vizFs = !!document.fullscreenElement && document.fullscreenElement === vizEl;
    pickerShown = true;
    if (vizFs) schedulePickerHide();
    else if (pickerTimer) clearTimeout(pickerTimer);
  }
  function onKey(e: KeyboardEvent) {
    if ((e.key !== "f" && e.key !== "F") || tab !== "viz") return;
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    e.preventDefault();
    if (!vizEl) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void vizEl.requestFullscreen?.();
  }
  $effect(() => {
    const el = vizEl;
    if (!el) return;
    el.addEventListener("pointermove", revealPicker);
    el.addEventListener("pointerdown", revealPicker);
    return () => {
      el.removeEventListener("pointermove", revealPicker);
      el.removeEventListener("pointerdown", revealPicker);
    };
  });
</script>

<svelte:window onkeydown={onKey} />
<svelte:document onfullscreenchange={onFsChange} />

<div class="stage">
  <div class="tabs">
    <button class:on={tab === "pattern"} onclick={() => (tab = "pattern")}>pattern</button>
    <button class:on={tab === "samples"} onclick={() => (tab = "samples")}>samples</button>
    <button class:on={tab === "viz"} onclick={() => (tab = "viz")}>viz</button>
  </div>
  <div class="wrap">
    {#if tab === "pattern"}
      <div class="scope-strip"><Scope /></div>
      <div class="pfill"><PatternView /></div>
    {:else if tab === "viz"}
      <div class="viz" class:fs={vizFs} bind:this={vizEl}>
        <div class="vizpick" class:hide={!pickerShown}>
          {#each VIZ as m (m)}
            <button class:on={vizMode === m} onclick={() => (vizMode = m)}>{m}</button>
          {/each}
        </div>
        <div class="vizbody">
          {#if vizMode === "bars"}
            <Equalizer active={playing} />
          {:else if vizMode === "wave"}
            <GlowWave active={playing} />
          {:else if vizMode === "vu"}
            <VuMeters active={playing} />
          {:else if vizMode === "stars"}
            <Starfield active={playing} />
          {:else if vizMode === "copper"}
            <CopperBars active={playing} />
          {:else if vizMode === "plasma"}
            <Plasma active={playing} />
          {:else if vizMode === "tunnel"}
            <Tunnel active={playing} />
          {:else if vizMode === "disco"}
            <DiscoBall active={playing} />
          {:else}
            <BoingBall energy={playing ? energy : 0} live={playing} react {format} />
          {/if}
        </div>
      </div>
    {:else}
      <SampleBrowser />
    {/if}
  </div>
</div>

<style>
  .stage {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--surface, var(--panel));
  }
  .tabs {
    flex: 0 0 auto;
    display: flex;
    gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--surface-line-2, var(--border));
  }
  .tabs button {
    padding: 4px 10px;
    font-size: 12px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--panel-hi);
    color: var(--text);
    cursor: pointer;
  }
  .tabs button.on {
    color: var(--bg);
    background: var(--accent);
    border-color: var(--accent);
  }
  .wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .scope-strip {
    flex: 0 0 auto;
    height: 64px;
    border-bottom: 1px solid var(--surface-line-2, var(--border));
  }
  .pfill {
    flex: 1;
    min-height: 0;
  }
  .viz {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .vizpick {
    flex: 0 0 auto;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--surface-line-2, var(--border));
  }
  .vizpick button {
    padding: 2px 9px;
    font-size: 11px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--panel-hi);
    color: var(--muted);
    cursor: pointer;
  }
  .vizpick button.on {
    color: var(--bg);
    background: var(--accent);
    border-color: var(--accent);
  }
  /* Fullscreen: picker floats as a top drawer, sliding away after a pause and
     returning on pointer movement so the viz fills the screen. */
  .viz.fs {
    position: relative;
  }
  .viz.fs .vizpick {
    position: absolute;
    inset: 0 0 auto 0;
    z-index: 3;
    background: color-mix(in srgb, var(--panel) 82%, transparent);
    backdrop-filter: blur(6px);
    transition:
      transform 0.3s ease,
      opacity 0.3s ease;
  }
  .viz.fs .vizpick.hide {
    transform: translateY(-100%);
    opacity: 0;
    pointer-events: none;
  }
  .vizbody {
    flex: 1;
    min-height: 0;
  }
  /* The samples view is the shared <SampleBrowser/> (own scoped styles). */
</style>
