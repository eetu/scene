<script lang="ts">
  // EmulatorJS surface (self-hosted under /vendor/emulatorjs/) for C64 (vice)
  // and Amiga (puae). EmulatorJS shows its own themed "Start Game" button and
  // only downloads the core on that click, so it's already lazy + provides the
  // audio gesture — no separate launch button needed. We add Fullscreen + Stop.
  import { Gauge, Maximize, Power, Sparkles, Trash2, Upload } from "@lucide/svelte";
  import { onDestroy, onMount, tick } from "svelte";

  import {
    crc32,
    ensureRomSW,
    KNOWN_ROMS,
    loadStoredRoms,
    removeRom,
    storeRom,
    userRomUrl,
  } from "./amigaRoms";

  let {
    core,
    gameUrl,
    biosUrl,
    biosA500Url,
    biosA4000Url,
  }: {
    core: "c64" | "amiga";
    gameUrl: string;
    biosUrl?: string;
    /** A500 Kickstart 1.3 ROM — used instead of biosUrl for OCS/ECS disks. */
    biosA500Url?: string;
    /** A4000 Kickstart 3.1 ROM — used for (030)/(040) demos (an A4000/030|040).
     * It's a DIFFERENT ROM from the A1200 KS3.1; without it PUAE falls back to
     * AROS on the A4000 model and demos misbehave. */
    biosA4000Url?: string;
  } = $props();

  // Amiga disks tagged (A500)/(OCS)/(ECS) boot a 68000 + original chipset (see
  // the model block below); PUAE then needs the KS1.3 ROM, not the A1200 KS3.1.
  const amigaA500 = () => core === "amiga" && /\((?:a500|ocs|ecs)\)/i.test(gameUrl);
  // Disks tagged (030)/(A4030) or (040)/(A4040) need an accelerated A4000/030|040
  // (68030/68040 + FPU): some AGA demos require a real 68030/40 and/or an FPU and
  // die (Line-F / illegal instruction) on the base A1200 68020. Returns the PUAE
  // model preset or null. These need the A4000 KS3.1 ROM (biosA4000Url).
  const amigaAccel = (): "A4040" | "A4030" | null => {
    if (core !== "amiga") return null;
    if (/\((?:040|a4040)\)/i.test(gameUrl)) return "A4040";
    if (/\((?:030|a4030)\)/i.test(gameUrl)) return "A4030";
    return null;
  };
  // The Kickstart this demo needs: the exact PUAE ROM filename, the server URL for
  // it (null if the server doesn't ship it), and the expected CRC/size for
  // validating a user-supplied file. PUAE reads the ROM by filename from the
  // emulator FS root, so a user ROM is injected there (see tryInjectRom).
  const neededRom = () => {
    if (core !== "amiga") return null;
    const name = amigaA500()
      ? "kick34005.A500"
      : amigaAccel()
        ? "kick40068.A4000"
        : "kick40068.A1200";
    const backendUrl = amigaA500() ? biosA500Url : amigaAccel() ? biosA4000Url : biosUrl;
    return { name, backendUrl, ...KNOWN_ROMS[name] };
  };
  // ROMs the visitor supplied in-browser (filename → bytes), loaded from IndexedDB
  // and served to EmulatorJS by a service worker (see amigaRoms.ts / launch()).
  let userRoms = $state<Record<string, Uint8Array>>({});
  let romError = $state<string | null>(null); // hard error (couldn't read the file)
  let romWarn = $state<string | null>(null); // soft note (ROM doesn't match — used anyway)
  // Show the upload control when the demo needs a ROM the server lacks and the user
  // hasn't provided it yet.
  const romMissing = () => {
    const r = neededRom();
    return !!r && !r.backendUrl && !userRoms[r.name];
  };
  const havingUserRom = () => {
    const r = neededRom();
    return !!r && !r.backendUrl && !!userRoms[r.name];
  };

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
  const CORE_VERSION = "jit-hot-2026-07";
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
    // Pick the ROM by machine: A500 disks → KS1.3; (030)/(040) → A4000 KS3.1;
    // everything else → A1200 KS3.1. The server ROM (if it ships one) wins; else a
    // ROM the visitor provided is served from IndexedDB by the service worker at
    // its exact Kickstart filename, so PUAE's model auto-selects it — the same path
    // a server ROM takes. PUAE matches by filename, so the model below must agree.
    const rom = neededRom();
    g.EJS_biosUrl = rom
      ? (rom.backendUrl ?? (userRoms[rom.name] ? userRomUrl(rom.name) : undefined))
      : (biosUrl ?? undefined);
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
    // - Amiga: A1200 (AGA), authentic 68020, CPU compatibility 'normal' (the
    //   JIT-accelerated path); immediate blits + no collision (demos don't use it)
    //   save CPU. NOTE: we ship the 68k→WASM JIT core (emulators/puae-wasm) — a
    //   recompiler baked in via --post-js that self-installs on the emulation
    //   thread. It's a HOT-THRESHOLD dynarec: only blocks executed ≥2000× get
    //   compiled, so cold timing-sensitive boot/setup/decrunch code stays on the
    //   interpreter (correct chipset timing) while hot effect loops get compiled
    //   for speed. That fixes the earlier black screen (which was JITing cold
    //   one-shot code). Self-modification is caught by a full-block checksum, and
    //   the interpreter is the automatic per-block fallback for anything not hot /
    //   not compilable / parity-failing — so the JIT can only ever speed a demo up
    //   or match the interpreter, never break it. Measured ~1.4× on CPU-bound demos
    //   (3D/vector); chipset/blitter-bound demos are limited by the chipset
    //   emulation, not the CPU, so they match stock (no regression). We keep 68020,
    //   not 68030: authentic, and 030 raises the guest's cycles-per-frame budget
    //   (more emulated work/frame → lag even with the JIT). The "Accurate" toggle
    //   switches 'normal' → cycle-exact (a CPU loop that bypasses the JIT) for the
    //   few demos that need exact 020/copper/blitter timing.
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
    // Force the modern WebGL2 core build. EmulatorJS picks the "-legacy" (WebGL1)
    // core whenever `webgl2Enabled` is falsy, and that value defaults to null unless
    // a saved setting or the core's report JSON (options.defaultWebGL2) supplies one
    // — our vendored report has no such key, and it 404s under the backend's SPA
    // fallback in prod anyway. So a fresh origin (any real deployment) fell back to
    // the legacy WebGL1 core, which renders AGA demos black; dev only worked because
    // localhost's localStorage happened to have WebGL2 persisted. preGetSetting reads
    // this default when there's no saved value, so this pins WebGL2 on everywhere.
    const opts: Record<string, string> = {
      "virtual-gamepad": "disabled",
      webgl2Enabled: "enabled",
    };
    if (core === "amiga") {
      // Model by filename tag (amigaA500 above): AGA demos (68020/AGA) run on an
      // A1200; OCS/ECS demos (State of the Art, Desert Dream, Enigma…) need a
      // 68000 + original chipset — a 68020/AGA A1200 runs them too fast or
      // glitches. `… (A500).adf` (or (OCS)/(ECS)) picks the classic path.
      const accel = amigaAccel();
      if (amigaA500()) {
        opts.puae_model = "A500"; // OCS, 68000, original chipset
        opts.puae_cpu_compatibility = "exact"; // 68000-accurate timing (demos need it)
        opts.puae_fastmem_size = "0"; // an A500 has no fast RAM
        opts.puae_bogomem_size = "2"; // + 512K slow RAM → 1 MB, what most 1990–93 OCS demos want
      } else if (accel) {
        // (030)/(040) demos: an accelerated A4000/030|040 — a real 68030/68040 with
        // an FPU. Some AGA demos require a 68030/40 and/or an FPU and die (Line-F /
        // illegal instruction) on the base A1200 68020; this preset (which auto-
        // selects the A4000 KS3.1 ROM set above) runs them. Still AGA + 2M Chip +
        // 8M Fast. NOTE: needs kick40068.A4000 present, else PUAE falls back to AROS.
        opts.puae_model = accel; // "A4030" or "A4040"
        opts.puae_cpu_compatibility = accurateMode ? "exact" : "normal";
        opts.puae_immediate_blits = accurateMode ? "waiting" : "immediate";
        opts.puae_fastmem_size = "8";
      } else {
        opts.puae_model = "A1200"; // force AGA — our Amiga content is AGA demos
        opts.puae_cpu_model = "68020"; // authentic A1200 CPU; the JIT supplies the speed (see note)
        // Accurate mode → cycle-exact 68020 (a different CPU loop that BYPASSES the
        // JIT dispatch hook, so it's the reliable "JIT off" path); default → 'normal'
        // (the JIT-accelerated loop). These select the CPU emulation path at machine
        // init, so toggleAccurate() relaunches rather than warm-restarting.
        opts.puae_cpu_compatibility = accurateMode ? "exact" : "normal";
        opts.puae_immediate_blits = accurateMode ? "waiting" : "immediate"; // exact blitter timing vs instant
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

  // Let the visitor supply the Kickstart the server doesn't ship. Validated by
  // CRC32 + size (a wrong ROM would silently fall back to AROS), kept in IndexedDB
  // (never uploaded), then the emulator is relaunched so it loads the ROM via the
  // service worker's /amiga-rom/<name> URL.
  async function pickRom() {
    const r = neededRom();
    if (!r) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".rom,.a500,.a600,.a1200,.a4000,application/octet-stream";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
      // Validate by CRC32 + size (same identity check PUAE uses on a ROM) — but
      // only WARN, don't block: a visitor may have a valid alternative dump. If it's
      // genuinely wrong, PUAE will reject it and fall back to AROS.
      romWarn =
        bytes.length !== r.size || crc32(bytes) !== r.crc
          ? `Heads up: this doesn't match ${r.name} (${r.label}) — expected ${r.size} bytes / CRC ${hex(r.crc)}, ` +
            `got ${bytes.length} bytes / CRC ${hex(crc32(bytes))}. Using it anyway; if the demo won't boot, remove it and try the exact ROM.`
          : null;
      romError = null;
      // Store to IndexedDB FIRST so the service worker can serve it, then relaunch
      // so EmulatorJS loads it via /amiga-rom/<name>.
      try {
        await ensureRomSW();
        await storeRom(r.name, bytes);
      } catch {
        /* IDB/SW blocked — keep it for this session only */
      }
      userRoms = { ...userRoms, [r.name]: bytes };
      teardown();
      void launch();
    };
    input.click();
  }

  // Remove a user-supplied ROM (e.g. the wrong file was given), then relaunch so
  // the upload prompt returns.
  async function removeUserRom() {
    const r = neededRom();
    if (!r) return;
    romError = null;
    romWarn = null;
    try {
      await removeRom(r.name);
    } catch {
      /* ignore */
    }
    const { [r.name]: _drop, ...rest } = userRoms;
    userRoms = rest;
    teardown();
    void launch();
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
          // NOTE: this only means the core is the JIT *build* (recompiler baked in)
          // — NOT that the JIT is executing. In cycle-exact ("Accurate timing") mode,
          // or on demos whose hot code the JIT can't compile, blocks barely run and
          // ~0% of instructions go through it. The real signal is the % line below.
          console.log("%c[PUAE] JIT-capable core loaded (recompiler present)", "color:#888");
        }
        const st = M.__ejsJitStats as { activated: number; gateFail: number } | undefined;
        if (st && st.activated > 0) {
          let share: number | null = null;
          try {
            const tot = (M._jit_insn_total as (() => number) | undefined)?.();
            const jit = (M._jit_insn_jit as (() => number) | undefined)?.();
            if (tot) share = (100 * (jit ?? 0)) / tot;
          } catch {
            /* counters not readable across threads — skip */
          }
          // Only claim it's actually accelerating when a non-trivial share executes
          // via the JIT; otherwise say so plainly so the banner can't mislead.
          const running = share !== null && share >= 1;
          const pct = share === null ? "" : ` · ${share.toFixed(1)}% of instructions via JIT`;
          console.log(
            `%c[PUAE] ${running ? "JIT executing ⚡" : "JIT idle (interpreter running)"}: ${st.activated} blocks compiled, ${st.gateFail} gate-fails${pct}`,
            running ? "color:#2ecc40" : "color:#888",
          );
          // keep sampling until the JIT actually kicks in (or the timeout below)
          if (running) clearInterval(announceTimer!);
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
  // timing — and the reliable "JIT off" path, since cycle-exact uses a different
  // CPU loop that the JIT doesn't hook). PUAE only re-reads cpu_compatibility /
  // cpu_model at machine INIT, not on a warm restart(), and on the threaded core
  // the JIT can't be toggled from the page — so we relaunch (like the Recommended
  // toggle) and let launch()'s opts (which read accurateMode) init the core in the
  // chosen mode. You'll re-click Launch after the switch.
  function toggleAccurate() {
    accurateMode = !accurateMode;
    teardown();
    void launch();
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
    // For Amiga, make the ROM service worker control the page and load any ROMs the
    // visitor supplied before, THEN launch — so launch() can point EJS_biosUrl at
    // /amiga-rom/<name> and the SW is ready to serve it (no reload race).
    void (async () => {
      if (core === "amiga") {
        await ensureRomSW();
        userRoms = await loadStoredRoms();
      }
      await launch();
    })();
  });
  onDestroy(() => teardown());
</script>

<div class="emu" class:fs={pseudoFs}>
  {#if error}<p class="err">{error}</p>{/if}
  {#if romError}<p class="err">{romError}</p>{/if}
  {#if romWarn}<p class="warn">{romWarn}</p>{/if}
  <div class="bar">
    <!-- settings toggles (left): pressed = on -->
    <div class="grp">
      <button
        class="tgl"
        class:on={forceDefaults}
        aria-pressed={forceDefaults}
        onclick={toggleForceDefaults}
        title={forceDefaults
          ? "Settings source: booting the app's tuned defaults, ignoring any options you changed in the menu (fixes a laggy or broken setup). Click to use your own saved settings instead. Independent of Accurate timing."
          : "Settings source: using your own saved settings. Click to boot the app's tuned defaults instead. Restarts the demo. Independent of Accurate timing."}
      >
        <Sparkles size={15} /> Default settings
      </button>
      {#if core === "amiga"}
        <button
          class="tgl"
          class:on={accurateMode}
          aria-pressed={accurateMode}
          onclick={toggleAccurate}
          title="CPU mode: cycle-exact 68020 (JIT off) — slower, for the few demos that need exact copper/blitter timing. Off = JIT-accelerated (smooth). Independent of Default settings. Restarts the demo."
        >
          <Gauge size={15} /> Accurate timing
        </button>
      {/if}
      {#if romMissing()}
        <button
          class="rom-need"
          onclick={pickRom}
          title="This demo needs the {neededRom()
            ?.label} Kickstart ROM, which this server doesn't provide. Load your own ROM file — it stays in your browser (never uploaded) and is remembered for next time."
        >
          <Upload size={15} /> Provide {neededRom()?.label}
        </button>
      {:else if havingUserRom()}
        <span
          class="rom-ok"
          title="Using your {neededRom()?.label} ROM, stored in this browser (never uploaded)."
        >
          {neededRom()?.label}: your ROM ✓
          <button
            class="rom-del"
            onclick={removeUserRom}
            title="Remove this ROM from your browser (e.g. if you uploaded the wrong file), then upload another."
            aria-label="Remove uploaded {neededRom()?.label} ROM"
          >
            <Trash2 size={13} />
          </button>
        </span>
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
  .warn {
    color: var(--accent, #f78f08);
    font-size: 12px;
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
  /* "Provide ROM" stands out (a required action), like the on-toggle accent. */
  .bar button.rom-need {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--bg);
    font-weight: 600;
  }
  .rom-ok {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    font-size: 12px;
    color: var(--muted, #8a8);
  }
  .rom-ok .rom-del {
    display: inline-flex;
    align-items: center;
    padding: 2px;
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
    opacity: 0.7;
  }
  .rom-ok .rom-del:hover {
    color: #ff4136;
    opacity: 1;
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
