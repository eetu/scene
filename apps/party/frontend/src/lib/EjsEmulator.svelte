<script lang="ts">
  // EmulatorJS surface (self-hosted under /vendor/emulatorjs/) for C64 (vice)
  // and Amiga (puae). EmulatorJS shows its own themed "Start Game" button and
  // only downloads the core on that click, so it's already lazy + provides the
  // audio gesture — no separate launch button needed. We add Fullscreen + Stop.
  import { Gauge, Maximize, Power, Sparkles } from "@lucide/svelte";
  import { onDestroy, onMount, tick } from "svelte";

  let {
    core,
    gameUrl,
    biosUrl,
    biosA500Url,
  }: {
    core: "c64" | "amiga";
    gameUrl: string;
    biosUrl?: string;
    /** A500 Kickstart 1.3 ROM — used instead of biosUrl for OCS/ECS disks. */
    biosA500Url?: string;
  } = $props();

  // Amiga disks tagged (A500)/(OCS)/(ECS) boot a 68000 + original chipset (see
  // the model block below); PUAE then needs the KS1.3 ROM, not the A1200 KS3.1.
  const amigaA500 = () => core === "amiga" && /\((?:a500|ocs|ecs)\)/i.test(gameUrl);

  let host = $state<HTMLDivElement | null>(null);
  let error = $state<string | null>(null);
  // Amiga only: default is an accelerated 68030 (smooth for heavy AGA demos, as
  // on the target hardware / capture videos). This toggle switches to authentic
  // stock-A1200 cycle-exact 68020 timing for the few demos that require it.
  let accurateMode = $state(false);
  // "Recommended settings" (on by default): ignore EmulatorJS's per-demo saved
  // settings and boot with the app defaults below — forgiving, so an accidental
  // setting that made a demo laggy doesn't stick. Toggle off to let your saved
  // settings apply/persist. The choice itself is stored globally (survives the
  // per-demo reset). See EJS_disableLocalStorage in launch().
  const FORCE_KEY = "party-ejs-force-defaults";
  const readForceDefaults = () =>
    typeof localStorage === "undefined" || localStorage.getItem(FORCE_KEY) !== "0";
  let forceDefaults = $state(readForceDefaults());
  // iOS Safari has no Fullscreen API on a <div>, so the real button no-ops; fall
  // back to a CSS "pseudo fullscreen" (fixed overlay), as the DOS surface does.
  let pseudoFs = $state(false);
  let scriptEl: HTMLScriptElement | null = null;
  let announceTimer: ReturnType<typeof setInterval> | null = null;

  const w = () => window as unknown as Record<string, unknown>;

  function cssVar(name: string, fallback: string): string {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  // EmulatorJS caches the downloaded core in the "EmulatorJS-Cache" IndexedDB
  // keyed by core NAME — so swapping the vendored *.data (e.g. to the JIT build)
  // doesn't invalidate it and the old core keeps loading. Bump CORE_VERSION when
  // the vendored core changes to drop that cache ONCE (next load re-fetches +
  // re-caches the new one). Also clears cached BIOS (re-downloaded, small).
  const CORE_VERSION = "jit-m4-2026-07";
  async function bustStaleCoreCache() {
    try {
      if (typeof indexedDB === "undefined") return;
      if (localStorage.getItem("party-ejs-core-ver") === CORE_VERSION) return;
      await new Promise<void>((res) => {
        const req = indexedDB.deleteDatabase("EmulatorJS-Cache");
        req.onsuccess = req.onerror = req.onblocked = () => res();
      });
      localStorage.setItem("party-ejs-core-ver", CORE_VERSION);
      console.log("[PUAE] cleared stale EmulatorJS core cache → fetching current core");
    } catch {
      /* storage/idb blocked — core just re-downloads */
    }
  }

  async function launch() {
    if (!host) return;
    error = null;
    // Wait for Svelte to commit the keyed #ejs-player node before the loader's
    // querySelector('#ejs-player') runs — when this component is (re)mounted
    // inside the file browser, the loader can otherwise race the DOM.
    await tick();
    if (!host) return;
    await bustStaleCoreCache(); // one-time, before the loader reads the core cache
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
    // A500 disks need the KS1.3 ROM; everything else the A1200 KS3.1.
    g.EJS_biosUrl = (amigaA500() ? biosA500Url : biosUrl) ?? undefined;
    g.EJS_startOnLoaded = false; // its Start Game click is the audio gesture
    g.EJS_startButtonName = "Launch"; // override the default "Start Game"
    g.EJS_language = "en"; // vendored locales don't include fi
    // Worker-thread core ONLY for Amiga (PUAE) — it needs the worker to hold
    // ~50fps for cycle-exact AGA. VICE (C64) is light and runs on the main
    // thread, which is also where EmulatorJS's volume slider applies gain (it
    // walks Module.AL.currentCtx.sources): a threaded core leaves that slider
    // inert, so threading C64 would silently break its volume control.
    g.EJS_threads = core === "amiga" && window.crossOriginIsolated === true;
    // Recommended mode → tell EmulatorJS to ignore (and not write) its saved
    // per-demo settings, so EJS_defaultOptions below always win. Off → normal
    // persistence: saved settings override the defaults.
    g.EJS_disableLocalStorage = forceDefaults;
    g.EJS_volume = 1;
    g.EJS_color = cssVar("--accent", "#f78f08");
    g.EJS_backgroundColor = cssVar("--bg", "#0f0f0f");
    // Core option defaults (the INITIAL value; once the user changes an option
    // in the settings menu their choice persists in localStorage and wins,
    // unless "Recommended" above forces these):
    // - Amiga: A1200 (AGA), authentic 68020, CPU compatibility 'normal' (lightest
    //   path); immediate blits + no collision (demos don't use it) save CPU.
    //   NOTE: our vendored PUAE core is a JIT build (a 68k→WASM recompiler baked
    //   in via --post-js, see emulators/puae-wasm) that self-installs on the
    //   emulation thread and accelerates 'normal' — so a real 68020 runs heavy AGA
    //   demos smoothly without faking a faster CPU. We deliberately DON'T bump to
    //   68030: that raises the guest's cycles-per-frame budget (more emulated work
    //   per frame) which, even with the JIT, the browser host can't always deliver
    //   for the heaviest demos → lag; 68020 is both authentic and smoother here.
    //   (Native fs-uae's JIT is fast enough that 030 wins there — not in-browser.)
    //   The "Accurate" toggle switches this 020 from JIT/'normal' to cycle-exact
    //   timing for the few demos that need exact 020/copper/blitter behaviour.
    //   Falls back to the interpreter per-block on any unsupported opcode
    //   (parity-gated), so the JIT is transparent.
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
      // Model by filename tag (amigaA500 above): AGA demos (68020/AGA) run on an
      // A1200; OCS/ECS demos (State of the Art, Desert Dream, Enigma…) need a
      // 68000 + original chipset — a 68020/AGA A1200 runs them too fast or
      // glitches. `… (A500).adf` (or (OCS)/(ECS)) picks the classic path.
      if (amigaA500()) {
        opts.puae_model = "A500"; // OCS, 68000, original chipset
        opts.puae_cpu_compatibility = "exact"; // 68000-accurate timing (demos need it)
        opts.puae_fastmem_size = "0"; // an A500 has no fast RAM
        opts.puae_bogomem_size = "2"; // + 512K slow RAM → 1 MB, what most 1990–93 OCS demos want
      } else {
        opts.puae_model = "A1200"; // force AGA — our Amiga content is AGA demos
        opts.puae_cpu_model = "68020"; // authentic A1200 CPU; the JIT supplies the speed (see note)
        opts.puae_cpu_compatibility = "normal"; // lightest CPU path (JIT-accelerated, see note above)
        opts.puae_immediate_blits = "immediate"; // instant blitter — saves CPU
        // The A1200 preset is "2M Chip + 8M Fast", but the individual memory
        // options override the model preset, and EmulatorJS writes them all at the
        // core's default (fast = 0). With no fast RAM, any sizable demo aborts on
        // launch with "not enough memory available / returncode 10" (verified in
        // UAE). Force 8 MB Zorro-II fast back on so the demos actually load.
        opts.puae_fastmem_size = "8";
      }
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
    if (core === "amiga") announceJit();
  }

  // Log to the console whether the vendored PUAE core is the JIT build and, once
  // it runs, how much of the demo is going through the recompiler — so it's
  // obvious the custom core is in use and enabled. Reads gameManager.Module (the
  // emulation thread's module, page-reachable), stops once the JIT is active.
  function announceJit() {
    let saidCore = false;
    let sawModule = false;
    let tries = 0;
    if (announceTimer) clearInterval(announceTimer);
    announceTimer = setInterval(() => {
      tries++;
      const M = (w().EJS_emulator as { gameManager?: { Module?: Record<string, unknown> } })
        ?.gameManager?.Module;
      if (M) sawModule = true;
      // ejsJitGet is set by the core's baked post-js; it can appear a tick after
      // gameManager.Module does — so we WAIT for it rather than declaring "vanilla"
      // on first sight (only conclude that after the timeout).
      if (M && typeof M.ejsJitGet === "function") {
        if (!saidCore) {
          saidCore = true;
          console.log("%c[PUAE] 68k→WASM JIT core in use ⚡", "color:#2ecc40;font-weight:bold");
        }
        const st = M.__ejsJitStats as { activated: number; gateFail: number } | undefined;
        if (st && st.activated > 0) {
          let share = "";
          try {
            const tot = (M._jit_insn_total as (() => number) | undefined)?.();
            const jit = (M._jit_insn_jit as (() => number) | undefined)?.();
            if (tot) share = ` · ${((100 * (jit ?? 0)) / tot).toFixed(0)}% of instructions via JIT`;
          } catch {
            /* counters not readable across threads — skip */
          }
          console.log(
            `%c[PUAE] JIT active: ${st.activated} blocks live, ${st.gateFail} gate-fails${share}`,
            "color:#2ecc40",
          );
          clearInterval(announceTimer!);
        }
      }
      if (tries > 240) {
        // ~120s: give up. If we saw a module but never ejsJitGet, it's the vanilla
        // core (stale cache?) — bump CORE_VERSION / reload to refetch.
        if (sawModule && !saidCore)
          console.log(
            "%c[PUAE] vanilla core (no JIT) — stale cached core? hard-reload to refetch",
            "color:#f78f08;font-weight:bold",
          );
        clearInterval(announceTimer!);
      }
    }, 500);
  }

  function teardown() {
    if (announceTimer) clearInterval(announceTimer);
    announceTimer = null;
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

  // Amiga: flip the 68020 between the JIT/'normal' default and authentic
  // cycle-exact 020 timing (for the few demos that need exact copper/blitter
  // timing), then reset so PUAE re-reads the variables. Each change pushes to the
  // core via setVariable; restart() re-applies them without re-downloading.
  function toggleAccurate() {
    const ci = w().EJS_emulator as
      | {
          changeSettingOption?: (k: string, v: string) => void;
          gameManager?: { restart?: () => void };
        }
      | undefined;
    if (!ci?.changeSettingOption) return;
    accurateMode = !accurateMode;
    ci.changeSettingOption("puae_cpu_model", "68020"); // authentic A1200 either way
    ci.changeSettingOption("puae_cpu_compatibility", accurateMode ? "exact" : "normal");
    ci.changeSettingOption("puae_immediate_blits", accurateMode ? "waiting" : "immediate");
    ci.gameManager?.restart?.();
  }

  // Flip Recommended-settings mode, persist the choice, and relaunch so
  // EJS_disableLocalStorage takes effect at core init.
  function toggleForceDefaults() {
    forceDefaults = !forceDefaults;
    try {
      localStorage.setItem(FORCE_KEY, forceDefaults ? "1" : "0");
    } catch {
      /* storage blocked — session-only */
    }
    teardown();
    void launch();
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
    <!-- settings toggles (left): pressed = on -->
    <div class="grp">
      <button
        class="tgl"
        class:on={forceDefaults}
        aria-pressed={forceDefaults}
        onclick={toggleForceDefaults}
        title={forceDefaults
          ? "Recommended settings are ON — booting with the app's tuned defaults, ignoring any settings you changed. Click to use your own saved settings instead."
          : "Using your own saved settings. Click to switch back to the recommended defaults (fixes a laggy or broken setup). Restarts the demo."}
      >
        <Sparkles size={15} /> Recommended
      </button>
      {#if core === "amiga"}
        <button
          class="tgl"
          class:on={accurateMode}
          aria-pressed={accurateMode}
          onclick={toggleAccurate}
          title="Accurate timing — cycle-exact 68020 (no JIT). Slower, but for the few demos that need exact copper/blitter timing. Off = JIT-accelerated (smooth). Restarts the demo."
        >
          <Gauge size={15} /> Accurate timing
        </button>
      {/if}
    </div>
    <!-- session actions (right) -->
    <div class="grp">
      <button onclick={fullscreen} title="Fullscreen">
        <Maximize size={15} /> Fullscreen
      </button>
      <button class="exit" onclick={stop} title="Stop and reset to the Launch screen">
        <Power size={15} /> Stop
      </button>
    </div>
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
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 6px;
  }
  .grp {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
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
  /* Toggles read as switches: dotted when off, solid-filled when on. */
  .bar button.tgl {
    border-style: dashed;
  }
  .bar button.tgl.on {
    background: var(--accent);
    border-color: var(--accent);
    border-style: solid;
    color: var(--bg);
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
