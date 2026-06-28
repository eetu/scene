<script lang="ts">
  // EmulatorJS surface (self-hosted under /vendor/emulatorjs/) for C64 (vice)
  // and Amiga (puae). EmulatorJS shows its own themed "Start Game" button and
  // only downloads the core on that click, so it's already lazy + provides the
  // audio gesture — no separate launch button needed. We add Fullscreen + Stop.
  import { Maximize, Power } from "@lucide/svelte";
  import { onDestroy, onMount, tick } from "svelte";

  let { core, gameUrl, biosUrl }: { core: "c64" | "amiga"; gameUrl: string; biosUrl?: string } =
    $props();

  let host = $state<HTMLDivElement | null>(null);
  let error = $state<string | null>(null);
  let fpsOn = $state(false);
  // Amiga only: trade timing accuracy for speed at runtime (cycle-exact ↔ a
  // lighter CPU mode) for AGA demos that are too heavy. Defaults to accurate.
  let perfMode = $state(false);
  // iOS Safari has no Fullscreen API on a <div>, so the real button no-ops; fall
  // back to a CSS "pseudo fullscreen" (fixed overlay), as the DOS surface does.
  let pseudoFs = $state(false);
  let scriptEl: HTMLScriptElement | null = null;

  const w = () => window as unknown as Record<string, unknown>;

  function cssVar(name: string, fallback: string): string {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  async function launch() {
    if (!host) return;
    error = null;
    // Wait for Svelte to commit the keyed #ejs-player node before the loader's
    // querySelector('#ejs-player') runs — when this component is (re)mounted
    // inside the file browser, the loader can otherwise race the DOM.
    await tick();
    if (!host) return;
    const g = w();
    // A previous emulator instance (navigating between productions) leaves a
    // global behind; drop it so the loader builds a clean one.
    g.EJS_emulator = undefined;
    // EmulatorJS calls querySelector on EJS_player, so it must be a selector.
    g.EJS_player = "#ejs-player";
    g.EJS_pathtodata = "/vendor/emulatorjs/";
    g.EJS_core = core;
    g.EJS_gameUrl = gameUrl;
    g.EJS_biosUrl = biosUrl ?? undefined; // overwrite any stale value
    g.EJS_startOnLoaded = false; // its Start Game click is the audio gesture
    g.EJS_startButtonName = "Launch"; // override the default "Start Game"
    g.EJS_language = "en"; // vendored locales don't include fi
    // Worker-thread core ONLY for Amiga (PUAE) — it needs the worker to hold
    // ~50fps for cycle-exact AGA. VICE (C64) is light and runs on the main
    // thread, which is also where EmulatorJS's volume slider applies gain (it
    // walks Module.AL.currentCtx.sources): a threaded core leaves that slider
    // inert, so threading C64 would silently break its volume control.
    g.EJS_threads = core === "amiga" && window.crossOriginIsolated === true;
    g.EJS_volume = 1;
    g.EJS_color = cssVar("--accent", "#f78f08");
    g.EJS_backgroundColor = cssVar("--bg", "#0f0f0f");
    // Core option defaults (the INITIAL value; once the user changes an option
    // in the settings menu their choice persists in localStorage and wins):
    // - Amiga: force the A1200 (AGA) model + cycle-exact CPU. The AGA demos
    //   rely on exact 68020/copper/blitter timing. Cycle-exact is the heaviest
    //   PUAE mode and is CPU-bound for AGA — note that in this mode PUAE ignores
    //   the cpu_throttle / immediate_blits / frameskip levers, so the one perf
    //   option that still applies is collision detection, which demos don't use,
    //   so we turn it off. If a demo is too slow, drop CPU Compatibility from
    //   'Cycle-exact' to 'memory'/'compatible' in the settings menu (faster, at
    //   some timing accuracy). See libretro PUAE core options.
    // - C64: drive-sound emulation off by default. VICE models the 1541's
    //   motor/stepper noise faithfully, and many demos keep the drive spinning,
    //   so the sound runs on under the demo (unlike Amiga, whose floppy noise
    //   stops with the motor). Re-enable it in the settings menu if wanted.
    //   autostart_warp: warp the machine while the (slow) 1541 loads, then drop
    //   back to 1× — keeps true drive emulation on (demos' fastloaders still
    //   work), only the load is sped up.
    // - virtual-gamepad off: EmulatorJS defaults it to "enabled" on mobile, but
    //   these are keyboard/non-interactive demos, so the touch d-pad just covers
    //   the screen with nothing useful. Still re-enableable in the settings menu.
    const opts: Record<string, string> = { "virtual-gamepad": "disabled" };
    if (core === "amiga") {
      opts.puae_model = "A1200"; // force AGA — our Amiga content is AGA demos
      opts.puae_cpu_compatibility = "exact"; // demo-accurate (heaviest) timing
      opts.puae_collision_level = "none"; // demos don't need collision — saves CPU
    } else if (core === "c64") {
      opts.vice_drive_sound_emulation = "disabled";
      opts.vice_autostart_warp = "enabled";
    }
    g.EJS_defaultOptions = opts;
    // Load the loader as a uniquely-URL'd ES module: a module's top-level
    // declarations are scoped to it (a classic <script> re-add would redeclare
    // loader.js's global `const debug` → "duplicate variable"), and the unique
    // query forces a fresh execution so re-launching actually re-runs it.
    scriptEl = document.createElement("script");
    scriptEl.type = "module";
    scriptEl.src = `/vendor/emulatorjs/loader.js?n=${Date.now()}`;
    scriptEl.onerror = () => (error = "failed to load emulator");
    document.body.appendChild(scriptEl);
  }

  function teardown() {
    const g = w();
    try {
      (g.EJS_emulator as { pause?: () => void } | undefined)?.pause?.();
    } catch {
      /* already gone */
    }
    scriptEl?.remove();
    scriptEl = null;
    host?.replaceChildren();
  }

  function fullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.();
      return;
    }
    // Real Fullscreen API where it exists (desktop); CSS overlay fallback on iOS
    // Safari, where requestFullscreen is absent on a <div>. EmulatorJS's own
    // ResizeObserver refits the canvas when the container grows.
    if (host?.requestFullscreen) {
      host.requestFullscreen().catch(() => (pseudoFs = true));
    } else {
      pseudoFs = !pseudoFs;
    }
  }

  // Toggle EmulatorJS's FPS overlay via its runtime settings API.
  function toggleFps() {
    const ci = w().EJS_emulator as
      | {
          getSettingValue?: (k: string) => string;
          changeSettingOption?: (k: string, v: string) => void;
        }
      | undefined;
    if (!ci?.changeSettingOption) return;
    const next = ci.getSettingValue?.("fps") === "show" ? "hide" : "show";
    ci.changeSettingOption("fps", next);
    fpsOn = next === "show";
  }

  // Amiga: flip CPU emulation between cycle-exact (accurate, heavy) and a
  // lighter mode, then reset the machine so PUAE re-reads the variables. Each
  // option change pushes to the core via setVariable; restart() re-applies them
  // without re-downloading the core.
  function togglePerf() {
    const ci = w().EJS_emulator as
      | {
          changeSettingOption?: (k: string, v: string) => void;
          gameManager?: { restart?: () => void };
        }
      | undefined;
    if (!ci?.changeSettingOption) return;
    perfMode = !perfMode;
    ci.changeSettingOption("puae_cpu_compatibility", perfMode ? "compatible" : "exact");
    ci.changeSettingOption("puae_immediate_blits", perfMode ? "immediate" : "waiting");
    ci.gameManager?.restart?.();
  }

  // Stop the running core and reset to a fresh Start Game screen.
  function stop() {
    teardown();
    void launch();
  }

  onMount(() => {
    void launch();
  });
  onDestroy(() => teardown());
</script>

<div class="emu" class:fs={pseudoFs}>
  {#if error}<p class="err">{error}</p>{/if}
  <div class="bar">
    {#if core === "amiga"}
      <button
        class:on={perfMode}
        onclick={togglePerf}
        title="Performance mode: trade cycle-exact timing for speed (restarts the demo)"
      >
        Perf
      </button>
    {/if}
    <button class:on={fpsOn} onclick={toggleFps} title="Toggle FPS counter">FPS</button>
    <button onclick={fullscreen} title="Fullscreen" aria-label="Fullscreen">
      <Maximize size={16} /> Fullscreen
    </button>
    <button class="exit" onclick={stop} title="Stop the emulator">
      <Power size={16} /> Stop
    </button>
  </div>
  <div id="ejs-player" class="screen" bind:this={host}></div>
</div>

<style>
  .emu {
    display: flex;
    flex-direction: column;
    gap: 8px;
    height: 100%;
    min-height: 0;
  }
  /* iOS fallback fullscreen (no native Fullscreen API on a <div>). */
  .emu.fs {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: #000;
    padding: 8px;
  }
  .err {
    color: #ff4136;
  }
  .bar {
    align-self: flex-end;
    display: flex;
    gap: 6px;
  }
  .bar button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
    color: var(--text);
    font-size: 12px;
    cursor: pointer;
  }
  .bar button:hover {
    border-color: var(--accent);
  }
  .bar button.on {
    color: var(--accent);
    border-color: var(--accent);
  }
  .bar button.exit:hover {
    border-color: #ff4136;
    color: #ff4136;
  }
  .screen {
    width: 100%;
    flex: 1;
    min-height: 0;
    background: #000;
    border-radius: 6px;
    overflow: hidden;
  }
</style>
