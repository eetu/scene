<script lang="ts">
  // DOS emulator surface (js-dos v8, self-hosted under /vendor/js-dos/). The
  // runtime + WASM (~1.4 MB+) load only when the user clicks Launch — never on
  // page view. Everything is same-origin, so the strict CSP is unchanged.
  import { Keyboard, Maximize, Play, Power, Volume2, X } from "@lucide/svelte";
  import { onDestroy } from "svelte";

  import { autohideControls } from "./autohideControls";

  let {
    bundleUrl,
    label = "Launch",
    onKeyboard,
  }: {
    bundleUrl: string;
    /** Launch-button label, e.g. "Launch CTSTOAST.EXE" when a specific build is
     *  picked from the file list. */
    label?: string;
    /** Fired when the mobile soft keyboard is raised, so the host can free up
     *  vertical space (e.g. collapse a list drawer) and keep the screen visible. */
    onKeyboard?: () => void;
  } = $props();

  // js-dos KBD_ keycodes (from the vendored bundle's keymap): letters are the
  // uppercase ASCII code, digits are their ASCII code, plus these specials.
  const KBD_ESC = 256;
  const KBD_CTRL: Record<string, number> = {
    Enter: 257,
    Backspace: 259,
    Escape: 256,
    Tab: 258,
    " ": 32,
    ArrowUp: 265,
    ArrowDown: 264,
    ArrowLeft: 263,
    ArrowRight: 262,
  };
  const KBD_PUNCT: Record<string, number> = {
    ",": 44,
    ".": 46,
    "-": 45,
    "/": 47,
    ";": 59,
    "=": 61,
    "'": 39,
    "`": 96,
    "[": 91,
    "]": 93,
    "\\": 92,
    " ": 32,
  };
  /** Map a printable character to its js-dos KBD code, or null. */
  function charToKbd(ch: string): number | null {
    if (ch >= "0" && ch <= "9") return ch.charCodeAt(0); // 48–57
    const lower = ch.toLowerCase();
    if (lower >= "a" && lower <= "z") return lower.charCodeAt(0) - 32; // → 65–90
    return KBD_PUNCT[ch] ?? null;
  }

  let wrap = $state<HTMLDivElement | null>(null);
  let host = $state<HTMLDivElement | null>(null);
  let started = $state(false);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let dosProps: DosProps | null = null;
  let ci = $state<DosCommandInterface | null>(null);

  // iOS Safari has no Fullscreen API on a <div>, so the real button no-ops; fall
  // back to a CSS "pseudo fullscreen" (fixed overlay). Touch devices also have no
  // physical keyboard — DOS intros that prompt for a sound card / [Enter] need
  // one — so on coarse pointers we focus a hidden input to raise the soft
  // keyboard and forward its keys into DOSBox.
  let pseudoFs = $state(false);
  // In fullscreen the toolbar auto-hides after inactivity (see autohideControls)
  // and reappears on any pointer/touch/key activity — driven by this flag.
  let controlsHidden = $state(false);
  // Sound-card cheat-sheet snackbar. Many DOS demos run their own SETUP that
  // ignores the BLASTER/ULTRASND env we bake in and asks you to pick a card by
  // hand — so we surface the values (GUS first) on launch, dismissible, and
  // re-openable from the toolbar. Keep these in sync with the backend
  // `dosbox_conf` (routes.rs): GUS base 240 / IRQ 5 / DMA 3; SB16 220 / 7 / 1+5.
  let showSound = $state(false);
  let kbdInput = $state<HTMLInputElement | null>(null);
  const coarse = $derived(
    typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches,
  );

  let scriptPromise: Promise<void> | null = null;
  function loadJsDos(): Promise<void> {
    if (window.Dos) return Promise.resolve();
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "/vendor/js-dos/js-dos.css";
      document.head.appendChild(css);
      const s = document.createElement("script");
      s.src = "/vendor/js-dos/js-dos.js";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("failed to load js-dos"));
      document.head.appendChild(s);
    });
    return scriptPromise;
  }

  async function launch() {
    if (started) return;
    started = true;
    // Pop the sound-card hint right as the demo (and its SETUP) starts.
    showSound = true;
    loading = true;
    error = null;
    try {
      await loadJsDos();
      if (!host || !window.Dos) throw new Error("js-dos unavailable");
      // Effective app theme (the layout writes it to <html data-theme>), so the
      // js-dos chrome matches. kiosk hides the sidebar drawer entirely — both
      // the white panel and the thin strip that lingers in fullscreen — and we
      // provide our own fullscreen button instead.
      const appTheme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
      dosProps = window.Dos(host, {
        url: bundleUrl,
        pathPrefix: "/vendor/js-dos/emulators/",
        autoStart: true,
        kiosk: true,
        theme: appTheme,
        // The command interface arrives here once the emulator is running,
        // so we can inject keys (ESC etc.) the kiosk UI no longer offers.
        onEvent: (event, commandInterface) => {
          if (event === "ci-ready" && commandInterface) {
            ci = commandInterface;
            watchForDemoStart();
          }
        },
      });
    } catch (e) {
      error = String(e);
      started = false;
    } finally {
      loading = false;
    }
  }

  function fullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.();
      return;
    }
    // Fullscreen the WHOLE emu (toolbar + screen), not just the screen — in
    // kiosk mode the toolbar's Fullscreen/Exit button is the only way out, and
    // js-dos grabs the keyboard (Chromium's Keyboard Lock API, absent on
    // Safari), so a bare Escape won't exit fullscreen there. Keeping the toolbar
    // visible gives a reliable, keyboard-independent exit on every browser.
    // Real Fullscreen API where it exists (desktop); CSS overlay fallback on
    // iOS Safari, where requestFullscreen is absent on non-video elements.
    if (wrap?.requestFullscreen) {
      wrap.requestFullscreen().catch(() => (pseudoFs = true));
    } else {
      pseudoFs = !pseudoFs;
    }
  }

  // Inject ESC straight into DOSBox — works in fullscreen too, where the
  // physical Esc key would just exit the browser's fullscreen instead. Useful
  // for demos that quit on ESC; many ignore it, hence Exit below.
  function sendEsc() {
    ci?.simulateKeyPress(KBD_ESC);
  }

  // --- Mobile soft keyboard → DOSBox -------------------------------------
  // Focus the off-screen input (within the tap gesture) to raise the soft
  // keyboard. Only on coarse pointers — on desktop js-dos handles the physical
  // keyboard itself, and stealing focus here would break it.
  function raiseKeyboard() {
    kbdInput?.focus();
    // Let the host reclaim vertical space so the screen isn't hidden behind the
    // soft keyboard (only reached on coarse pointers — see callers).
    onKeyboard?.();
  }
  function onScreenTap() {
    if (coarse) raiseKeyboard();
  }
  // Control keys arrive as keydown; route them and keep js-dos's own global
  // listener from also acting on them.
  function onKbdKeydown(e: KeyboardEvent) {
    const code = KBD_CTRL[e.key];
    if (code != null) {
      ci?.simulateKeyPress(code);
      e.preventDefault();
      e.stopPropagation();
    }
  }
  // Printable characters arrive as input events (the soft keyboard rarely emits
  // usable keydowns); map each and keep the field empty.
  function onKbdInput(e: Event) {
    const t = e.target as HTMLInputElement;
    for (const ch of (e as InputEvent).data ?? "") {
      const code = charToKbd(ch);
      if (code != null) ci?.simulateKeyPress(code);
    }
    t.value = "";
  }

  // Auto-hide the sound-card hint once the demo leaves its (text-mode) SETUP.
  // The hint only helps while a demo asks you to pick a card; when the DOS video
  // mode changes from what it was when the CI arrived, the demo proper is
  // running. Poll width()/height() rather than the CI frame events, which the
  // kiosk renderer owns. Give up after ~60s (single-mode demos never change).
  let sizePoll: ReturnType<typeof setInterval> | null = null;
  function stopSizePoll() {
    if (sizePoll !== null) {
      clearInterval(sizePoll);
      sizePoll = null;
    }
  }
  function watchForDemoStart() {
    stopSizePoll();
    let base = "";
    let ticks = 0;
    sizePoll = setInterval(() => {
      if (!ci || ++ticks > 120) {
        stopSizePoll();
        return;
      }
      const w = ci.width?.() ?? 0;
      const h = ci.height?.() ?? 0;
      if (!w || !h) return; // not painting yet
      const mode = `${w}x${h}`;
      if (!base) {
        base = mode; // first real mode = the SETUP screen
      } else if (mode !== base) {
        showSound = false; // switched modes → demo is running
        stopSizePoll();
      }
    }, 500);
  }

  // Hard stop: tear the emulator down and return to the launch state — the way
  // out for demos that don't respond to ESC at all. Also drops fullscreen: the
  // iOS CSS-overlay (`pseudoFs`) has no other exit once the toolbar unmounts, so
  // leaving it set would strand the user on a black full-viewport overlay.
  // Fully release the js-dos core. Its stop() only tells the guest to exit —
  // which is what throws the async "Aborted(RuntimeError: unreachable)" trap —
  // and this build runs DOSBox on the MAIN thread (no worker to terminate), so
  // its multi-hundred-MB WASM heap is reclaimed only once every reference to the
  // Emscripten Module is dropped. Null our handles and clear the host DOM so the
  // GC can collect it before the next (possibly heavier) core allocates, rather
  // than stranding it — otherwise a stranded heap can starve a subsequent
  // emulator launch (the party player toggles between the DOS and Amiga cores).
  function releaseDos() {
    stopSizePoll();
    try {
      dosProps?.stop?.();
    } catch {
      /* already gone */
    }
    dosProps = null;
    ci = null;
    host?.replaceChildren();
  }

  function exitEmu() {
    if (document.fullscreenElement) void document.exitFullscreen?.();
    pseudoFs = false;
    releaseDos();
    started = false;
    showSound = false;
  }

  onDestroy(() => {
    // Don't strand the page in fullscreen when unmounted mid-session.
    if (document.fullscreenElement) void document.exitFullscreen?.();
    releaseDos();
  });
</script>

<div
  class="emu"
  class:fs={pseudoFs}
  class:controls-hidden={controlsHidden}
  bind:this={wrap}
  use:autohideControls={{ pseudo: pseudoFs, onVisibility: (h) => (controlsHidden = h) }}
>
  {#if !started}
    <button class="launch" onclick={launch}>
      <Play size={20} />
      {label}
    </button>
    <p class="hint">Loads the emulator (~1.5 MB) on demand.</p>
  {/if}
  {#if loading}<p class="hint">starting…</p>{/if}
  {#if error}<p class="err">{error}</p>{/if}
  {#if started && !error}
    <div class="bar">
      <button onclick={sendEsc} disabled={!ci} title="Send ESC to the demo">ESC</button>
      {#if coarse}
        <button onclick={raiseKeyboard} disabled={!ci} title="Show keyboard" aria-label="Keyboard">
          <Keyboard size={16} /><span class="lbl">Keys</span>
        </button>
      {/if}
      <button
        onclick={() => (showSound = !showSound)}
        class:active={showSound}
        title="Sound card settings"
        aria-label="Sound card settings"
      >
        <Volume2 size={16} /><span class="lbl">Sound</span>
      </button>
      <button onclick={fullscreen} title="Fullscreen" aria-label="Fullscreen">
        <Maximize size={16} /><span class="lbl">Fullscreen</span>
      </button>
      <button
        class="exit"
        onclick={exitEmu}
        title="Stop the emulator"
        aria-label="Stop the emulator"
      >
        <Power size={16} /><span class="lbl">Exit</span>
      </button>
    </div>
  {/if}

  <!-- Sound-card cheat-sheet: appears on launch (when the demo's SETUP would),
       GUS first, dismissible, re-openable from the toolbar. -->
  {#if started && showSound}
    <div class="snack" role="status">
      <Volume2 size={16} />
      <div class="snack-text">
        <b>Sound card?</b> Pick <b>Gravis&nbsp;UltraSound</b> — Port&nbsp;240 · IRQ&nbsp;5 ·
        DMA&nbsp;3.
        <span class="snack-sub"
          >Sound&nbsp;Blaster&nbsp;16 also set: 220 · IRQ&nbsp;7 · DMA&nbsp;1/5</span
        >
      </div>
      <button class="snack-x" onclick={() => (showSound = false)} aria-label="Dismiss hint">
        <X size={14} />
      </button>
    </div>
  {/if}
  <!-- Off-screen capture input: focused on a mobile tap to raise the soft
	     keyboard; its keys are forwarded into DOSBox. -->
  <input
    class="kbd-capture"
    bind:this={kbdInput}
    onkeydown={onKbdKeydown}
    oninput={onKbdInput}
    autocomplete="off"
    autocapitalize="off"
    autocorrect="off"
    spellcheck="false"
    aria-hidden="true"
    tabindex="-1"
  />
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="screen" class:live={started} bind:this={host} onpointerup={onScreenTap}></div>
</div>

<style>
  .emu {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    height: 100%;
    min-height: 0;
    /* Positioning context for the sound-card snackbar overlay. */
    position: relative;
  }
  /* iOS fallback fullscreen (no native Fullscreen API on a <div>). */
  .emu.fs {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: #000;
    padding: 8px;
  }
  /* Real fullscreen (desktop) fills the screen via the UA stylesheet; give it
     the same backdrop + inset so the toolbar sits over black, not a stretched
     transparent box. */
  .emu:fullscreen {
    background: #000;
    padding: 8px;
  }
  /* Immersive idle: fade the toolbar out and hide the cursor; any activity
     re-reveals them (autohideControls). Only reached in fullscreen. */
  .emu.controls-hidden {
    cursor: none;
  }
  .emu.controls-hidden .bar {
    opacity: 0;
    pointer-events: none;
  }
  /* Off-screen, invisible — exists only to host the mobile soft keyboard. */
  .kbd-capture {
    position: absolute;
    top: 0;
    left: 0;
    width: 1px;
    height: 1px;
    opacity: 0;
    border: 0;
    padding: 0;
    pointer-events: none;
  }
  .launch {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 12px 20px;
    border: 1px solid var(--accent);
    border-radius: 8px;
    background: var(--accent);
    color: #0f0f0f;
    font-size: 15px;
    cursor: pointer;
  }
  .hint {
    color: var(--muted);
    font-size: 12px;
    margin: 0;
  }
  .bar {
    align-self: flex-end;
    display: flex;
    gap: 6px;
    transition: opacity 0.2s ease;
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
  .bar button:hover:not(:disabled) {
    border-color: var(--accent);
  }
  .bar button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .bar button.exit:hover {
    border-color: #ff4136;
    color: #ff4136;
  }
  .bar button.active {
    border-color: var(--accent);
    color: var(--accent);
  }
  /* On phones the labelled buttons overflow the row (worse once the touch-only
     Keys button joins), so collapse them to icons. ESC has no icon, so its text
     stays; the rest keep their aria-label for accessibility. */
  @media (max-width: 640px) {
    .bar button .lbl {
      display: none;
    }
    .bar button {
      padding: 7px 9px;
    }
  }
  /* Sound-card hint snackbar — floats over the bottom of the screen. Anchor both
     edges (not left:50% + translateX, which caps an auto-width absolute box at
     half the container and forced cramped wrapping); margin-inline:auto then
     centres it, so it fills the width on mobile and only caps at 460px on wide. */
  .snack {
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: 14px;
    margin-inline: auto;
    z-index: 6;
    display: flex;
    /* Top-align so the icon + ✕ stay next to the heading when the text wraps to
       several lines on narrow screens (centering floated them to the middle). */
    align-items: flex-start;
    gap: 10px;
    max-width: 460px;
    padding: 8px 8px 8px 12px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: 8px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
    color: var(--text);
    font-size: 12px;
  }
  .snack > :global(svg) {
    flex: 0 0 auto;
    color: var(--accent);
  }
  .snack-text {
    line-height: 1.35;
  }
  .snack-sub {
    display: block;
    color: var(--muted);
    font-size: 11px;
    font-family: var(--font-mono-retro);
  }
  .snack-x {
    flex: 0 0 auto;
    display: inline-grid;
    place-items: center;
    padding: 3px;
    border: 0;
    background: none;
    color: var(--muted);
    cursor: pointer;
  }
  .snack-x:hover {
    color: var(--accent);
  }
  .err {
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
  .screen:not(.live) {
    display: none;
  }
</style>
