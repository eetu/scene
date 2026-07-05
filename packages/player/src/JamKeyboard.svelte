<script module lang="ts">
  // Note values follow libopenmpt's play_note convention: 60 = middle C.
  const WHITE_PC = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B
  const PC_NAME = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const HAS_SHARP = new Set([0, 2, 5, 7, 9]); // C D F G A get a black key to their right
  // Note value → name (60 = C5, matching libopenmpt's middle C).
  const noteName = (n: number) => `${PC_NAME[((n % 12) + 12) % 12]}${Math.floor(n / 12)}`;
  // QWERTY → semitone offset from the low octave's C (classic tracker layout:
  // bottom row = base octave, top row = base octave + 1).
  const KEYMAP: Record<string, number> = {
    z: 0,
    s: 1,
    x: 2,
    d: 3,
    c: 4,
    v: 5,
    g: 6,
    b: 7,
    h: 8,
    n: 9,
    j: 10,
    m: 11,
    ",": 12,
    q: 12,
    2: 13,
    w: 14,
    3: 15,
    e: 16,
    r: 17,
    5: 18,
    t: 19,
    6: 20,
    y: 21,
    7: 22,
    u: 23,
    i: 24,
  };
</script>

<script lang="ts">
  // A piano that jams a sample (its raw PCM, via Web Audio) on the loaded module.
  // White keys flow; black keys are positioned over the gaps. Tracks each held
  // note's voice id so key-up cuts exactly that note (polyphonic). Gate on
  // `playback.canReadSamples` in the caller.
  import { jamNote, jamStop, jamStopAll, playback, setJamAuto, setJamLevel } from "./player.svelte";

  let { sample = 1, label = "" }: { sample?: number; label?: string } = $props();

  let octave = $state(5); // leftmost octave; 5 → C=60 (middle C)

  // Show one octave on narrow screens (wider, tap-friendly keys), two otherwise.
  // QWERTY keeps its full two-octave map regardless (desktop only touches it).
  let narrow = $state(false);
  $effect(() => {
    const mq = window.matchMedia("(max-width: 560px)");
    narrow = mq.matches;
    const onChange = (e: MediaQueryListEvent) => (narrow = e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  });
  const octaves = $derived(narrow ? 1 : 2);
  const numWhite = $derived(octaves * 7);

  // note value (60=middle C) → the voice id playing it, so we can stop it.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const active = new Map<number, number>();
  let held = $state<number[]>([]); // note values currently down (for highlight)
  const currentNote = $derived(held.length ? noteName(held[held.length - 1]) : "");

  const whiteKeys = $derived.by(() => {
    const out: { note: number }[] = [];
    for (let o = 0; o < octaves; o++)
      for (const pc of WHITE_PC) out.push({ note: (octave + o) * 12 + pc });
    return out;
  });
  const blackKeys = $derived.by(() => {
    const out: { note: number; left: number }[] = [];
    let w = 0;
    for (let o = 0; o < octaves; o++)
      for (const pc of WHITE_PC) {
        if (HAS_SHARP.has(pc))
          out.push({ note: (octave + o) * 12 + pc + 1, left: ((w + 1) / numWhite) * 100 });
        w++;
      }
    return out;
  });

  async function down(note: number) {
    if (active.has(note)) return; // already sounding (key-repeat / re-enter)
    active.set(note, -1); // reserve so a fast repeat doesn't double-trigger
    held = [...held, note];
    playback.jamHeld = held.length;
    const id = await jamNote(sample, note);
    if (active.get(note) === -1) active.set(note, id);
    else if (id >= 0) jamStop(id); // released before the voice came back
  }
  function up(note: number) {
    const ch = active.get(note);
    active.delete(note);
    held = held.filter((n) => n !== note);
    playback.jamHeld = held.length;
    if (ch !== undefined && ch >= 0) jamStop(ch);
  }

  // Only ignore keys while a TEXT field is focused — a focused range slider (the
  // vol control) must not swallow the QWERTY jam keys.
  function isTextTarget(el: HTMLElement | null): boolean {
    if (!el) return false;
    if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") {
      const t = ((el as HTMLInputElement).type || "text").toLowerCase();
      return !["range", "checkbox", "radio", "button", "submit", "color"].includes(t);
    }
    return false;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTextTarget(e.target as HTMLElement | null)) return;
    const off = KEYMAP[e.key.toLowerCase()];
    if (off === undefined) return;
    e.preventDefault();
    void down(octave * 12 + off);
  }
  function onKeyUp(e: KeyboardEvent) {
    const off = KEYMAP[e.key.toLowerCase()];
    if (off === undefined) return;
    up(octave * 12 + off);
  }

  // --- pointer glissando (drag / swipe across keys, multi-touch) -------------
  let pianoEl = $state<HTMLElement | undefined>(undefined);
  // pointerId → the note it's currently sounding (or null when off the keys).
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const pointers = new Map<number, number | null>();

  function keyAt(x: number, y: number): number | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const k = el?.closest?.("[data-note]") as HTMLElement | null;
    if (!k || !pianoEl?.contains(k)) return null;
    const n = Number(k.getAttribute("data-note"));
    return Number.isFinite(n) ? n : null;
  }
  function pdown(e: PointerEvent) {
    const note = keyAt(e.clientX, e.clientY);
    if (note == null) return;
    e.preventDefault();
    pianoEl?.setPointerCapture?.(e.pointerId); // keep move/up even off the keys
    pointers.set(e.pointerId, note);
    void down(note);
  }
  function pmove(e: PointerEvent) {
    if (!pointers.has(e.pointerId)) return; // not a press started on the piano
    const note = keyAt(e.clientX, e.clientY);
    const cur = pointers.get(e.pointerId);
    if (note === cur) return;
    if (cur != null) up(cur); // left the previous key
    if (note != null) void down(note); // entered a new one
    pointers.set(e.pointerId, note);
  }
  function pend(e: PointerEvent) {
    const cur = pointers.get(e.pointerId);
    if (cur != null) up(cur);
    pointers.delete(e.pointerId);
  }

  // Cancel any sounding voice(s) when the selected sample changes — switching
  // samples shouldn't leave the old (possibly looping) one playing.
  $effect(() => {
    void sample;
    jamStopAll();
    active.clear();
    pointers.clear();
    held = [];
    playback.jamHeld = 0;
  });

  // Stop all held voices when the keyboard unmounts.
  $effect(() => {
    return () => {
      jamStopAll();
      active.clear();
      pointers.clear();
      held = [];
      playback.jamHeld = 0;
    };
  });
</script>

<svelte:window onkeydown={onKeyDown} onkeyup={onKeyUp} />

<div class="jam">
  <div class="bar">
    <span class="lbl">jam{label ? ` · ${label}` : ""}</span>
    <span class="note">{currentNote || "—"}</span>
    <span class="oct">
      <button onclick={() => (octave = Math.max(0, octave - 1))} aria-label="octave down">−</button>
      <span class="ov">oct {octave}</span>
      <button onclick={() => (octave = Math.min(8, octave + 1))} aria-label="octave up">+</button>
    </span>
    <label class="lvl">
      vol
      <input
        type="range"
        min="0"
        max="200"
        value={Math.round(playback.jamLevel * 100)}
        oninput={(e) => setJamLevel(e.currentTarget.valueAsNumber / 100)}
        onpointerup={(e) => e.currentTarget.blur()}
        onchange={(e) => e.currentTarget.blur()}
        title={playback.jamAutoLevel
          ? "jam trim (100% = matched to the song)"
          : "jam level (manual)"}
        aria-label="jam level"
      />
    </label>
    <button
      type="button"
      class="auto"
      class:on={playback.jamAutoLevel}
      role="switch"
      aria-checked={playback.jamAutoLevel}
      title="auto-balance the jam level to the song"
      onclick={() => setJamAuto(!playback.jamAutoLevel)}
    >
      <span class="sw"></span>auto
    </button>
    <span class="hint">tap / QWERTY · Z–M · Q–U</span>
  </div>
  <!-- Input is handled on the container (not per key) so a drag / swipe glides
       across keys, and multi-touch works — each pointer tracks the key under it. -->
  <div
    class="piano"
    role="group"
    aria-label="jam keyboard"
    bind:this={pianoEl}
    onpointerdown={pdown}
    onpointermove={pmove}
    onpointerup={pend}
    onpointercancel={pend}
  >
    {#each whiteKeys as k (k.note)}
      <button
        type="button"
        class="wkey"
        class:on={held.includes(k.note)}
        data-note={k.note}
        aria-label="note {k.note}"
      >
        {#if k.note % 12 === 0}<span class="klabel">{noteName(k.note)}</span>{/if}
      </button>
    {/each}
    {#each blackKeys as k (k.note)}
      <button
        type="button"
        class="bkey"
        class:on={held.includes(k.note)}
        data-note={k.note}
        style="left:{k.left}%"
        aria-label="note {k.note}"
      ></button>
    {/each}
  </div>
</div>

<style>
  .jam {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border-top: 1px solid var(--surface-line-2, var(--border));
    background: var(--panel-hi, var(--panel));
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 11px;
    color: var(--muted);
    flex-wrap: wrap;
  }
  .lbl {
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .note {
    min-width: 30px;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .oct {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .oct button {
    width: 22px;
    height: 22px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--panel);
    color: var(--text);
    cursor: pointer;
    line-height: 1;
  }
  .ov {
    min-width: 40px;
    text-align: center;
  }
  .lvl {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .lvl input {
    width: 76px;
    accent-color: var(--accent);
    outline: none;
  }
  /* "auto" thumbswitch — a compact iOS-style toggle. */
  .auto {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .auto .sw {
    width: 26px;
    height: 14px;
    border-radius: 7px;
    background: var(--border);
    position: relative;
    transition: background 0.15s ease;
  }
  .auto .sw::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--panel);
    transition: transform 0.15s ease;
  }
  .auto.on {
    color: var(--accent);
  }
  .auto.on .sw {
    background: var(--accent);
  }
  .auto.on .sw::after {
    transform: translateX(12px);
  }
  .hint {
    margin-left: auto;
  }
  /* White keys flow; black keys are absolutely positioned over the boundaries. */
  .piano {
    position: relative;
    display: flex;
    gap: 2px;
    height: 110px;
    touch-action: none;
    user-select: none;
  }
  .wkey {
    flex: 1;
    height: 100%;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    border: 1px solid #2a2a2a;
    border-radius: 0 0 4px 4px;
    /* Always light — a piano's white keys shouldn't follow the dark theme. */
    background: linear-gradient(#fbfbfb, #d0d0d0);
    cursor: pointer;
    padding: 0 0 3px;
    outline: none;
    -webkit-tap-highlight-color: transparent;
  }
  .klabel {
    font-size: 9px;
    color: #666;
    pointer-events: none;
  }
  .wkey.on {
    background: var(--accent);
  }
  .bkey {
    position: absolute;
    top: 0;
    width: 26px;
    height: 64%;
    transform: translateX(-50%);
    border: 1px solid #000;
    border-radius: 0 0 3px 3px;
    background: linear-gradient(#333, #111);
    cursor: pointer;
    padding: 0;
    z-index: 2;
    outline: none;
    -webkit-tap-highlight-color: transparent;
  }
  .bkey.on {
    background: var(--accent);
  }
</style>
