<script lang="ts">
  // Scroller board: the module's own words on a Solari departures board.
  //
  // Tracker composers used the sample- and instrument-name slots as a text area —
  // their handle, their group, greets, an email address, "written in 3 hours at 4am".
  // It is the demoscene's oldest habit and the reason the archive's own enrichment
  // pipeline reads those slots at all. Every other visualiser here draws the *audio*;
  // this one reads what the person who made it wrote down.
  //
  // Why a split-flap and not the flip-dot board: this is text, and a split-flap's
  // native content is characters. Rendering a spectrum on it would be a worse
  // flip-dot. Conversely a flip-dot board can't hold a sentence.
  //
  // Cadence is the whole design constraint. A flap falls in `flipMs` and a run costs
  // a fall per flap, so a module that has to cross the drum takes flipMs × drum
  // length — ~2.9s here. Lines therefore change every few *beats*, not every frame:
  // the board is always mid-cascade for about half its life, which is exactly the
  // effect. Anything faster just smears.
  import { onMount } from "svelte";
  import { ChevronDown, ChevronUp } from "@lucide/svelte";

  import type { SplitFlapBoard } from "@glowbox/split-flap";
  import { driveFrames } from "./raf";
  import { playback } from "./state.svelte";

  let { active = true }: { active?: boolean } = $props();

  let host: HTMLDivElement;
  let canvas: HTMLCanvasElement | undefined = $state();

  // A flap card is markedly taller than it is wide — this is the module aspect the
  // real Solari units use, and cols are derived from it so characters stay square-ish
  // whatever shape the pane is.
  const CARD_ASPECT = 0.62;
  // Shorter than the 90ms default: at 90 a worst-case wrap across the 53-flap Nordic
  // drum is ~4.8s, which would still be running when the next line is due.
  const FLIP_MS = 55;
  // Hold a line for this many beats, so the board turns *with* the music.
  //
  // Eight bars — ~15s at 125bpm — arrived by walking it down twice. Scrolling by a line
  // re-targets EVERY module (row i takes row i+1's text), so each step costs a full
  // cascade: ~1.5s typical, 2.9s worst case. At one bar the board was mid-flip more
  // than half the time and the text never resolved — the first version of this was
  // pretty and completely unreadable. At four it resolved but was turning the page
  // while you were still reading it. A Solari board is something you glance at and take
  // in, and the pause between turns is most of what makes a turn feel like an event.
  const BEATS_PER_LINE = 32;
  // …but never sit still longer than this, for modules whose beat tick is sparse.
  const MAX_HOLD_S = 22;
  const MIN_HOLD_S = 12;

  function cssVar(name: string, fallback: string): string {
    if (typeof getComputedStyle !== "function") return fallback;
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  /** Does this name look like a message rather than a sample filename? */
  function isProse(s: string): boolean {
    if (s.length < 3) return false;
    // "bd1.wav", "STRG-D1.WAV", "hihat closed 1" — the first two are inventory, the
    // third is still just a label. Prose has a space AND isn't a filename, or is long
    // enough that it can't be an instrument name.
    if (/\.(wav|raw|smp|iff|snd|aif+|pcm|spl|s3i|its)$/i.test(s.trim())) return false;
    return /\s/.test(s.trim()) || s.trim().length >= 12;
  }

  /** The board's script for the loaded module: a title card, then whatever the
   *  composer wrote in the sample slots. Falls back progressively so a module with
   *  no text still shows something rather than an empty board. */
  const script = $derived.by(() => {
    const t = playback.current;
    const head: string[] = [];
    if (t) head.push(String(t.title || t.filename));
    if (t?.artist) head.push(`BY ${t.artist}`);

    const slots = [...playback.instruments, ...playback.samples]
      .map((s) => (s ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    // De-dupe: trackers repeat the same padding line dozens of times to make a block
    // of text, and a board that shows the same line eight times reads as broken.
    const seen = new Set<string>();
    const uniq = slots.filter((s) => {
      const k = s.toUpperCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const prose = uniq.filter(isProse);
    // Two lines of prose is the bar for "this module has a message". Under that, show
    // the whole inventory instead — on a sparse module the sample list IS the content.
    const body = prose.length >= 2 ? prose : uniq;
    return [...head, "", ...body];
  });

  // Re-script the board when the loaded module changes. Declared out here because
  // $effect has to be created during component init — inside the async setup below
  // it would run after init and Svelte rejects it. The setup assigns `rescript` once
  // the board exists and calls it for the first paint; this only handles the changes.
  let rescript: (() => void) | null = null;
  $effect(() => {
    void script;
    rescript?.();
  });

  // Hand paging. Assigned once the board exists; `$state` so the arrows appear with it
  // rather than rendering dead. `pageable` stays false when the whole script already
  // fits on the board — there is nothing to page to, and two arrows that do nothing are
  // worse than no arrows.
  let step: ((d: number) => void) | null = $state(null);
  let pageable = $state(false);
  // Ends of the script, for disabling the arrows. Hand paging clamps (see `step`), so
  // an arrow that would do nothing says so rather than silently no-oping.
  let atTop = $state(true);
  let atEnd = $state(false);

  // Scroll position for the rail between the arrows: where the window sits in the
  // script and how much of it shows. Read-only — the arrows are the control. A floor on
  // the thumb's height keeps it visible on very long scripts.
  let scrollTop = $state(0);
  let scrollLen = $state(0);
  let scrollWin = $state(0);
  const thumbH = $derived(
    scrollLen ? Math.max(8, Math.min(100, (scrollWin / scrollLen) * 100)) : 100,
  );
  const thumbY = $derived(scrollLen ? Math.min((scrollTop / scrollLen) * 100, 100 - thumbH) : 0);

  onMount(() => {
    let stopped = false;
    let board: SplitFlapBoard | null = null;
    let stopFrames: (() => void) | null = null;
    let ro: ResizeObserver | null = null;

    void (async () => {
      const { createSplitFlap, DRUM_NORDIC } = await import("@glowbox/split-flap");
      if (stopped || !canvas) return;

      let cols = 24;
      let rows = 5;
      const measure = () => {
        const r = host.getBoundingClientRect();
        if (r.height <= 0 || r.width <= 0) return false;
        // Cards keep their real proportions, so the only way to more columns is more
        // rows — a shorter card is a narrower one. 10 rows of ~56px on a 560-tall pane
        // gives ~27 columns, which fits most greet lines whole; at 7 rows it was 19 and
        // nearly everything wrapped.
        const next = {
          rows: Math.max(4, Math.min(10, Math.round(r.height / 52))),
          cols: 0,
        };
        const cellH = r.height / next.rows;
        next.cols = Math.max(8, Math.min(48, Math.floor(r.width / (cellH * CARD_ASPECT))));
        const changed = next.rows !== rows || next.cols !== cols;
        rows = next.rows;
        cols = next.cols;
        return changed;
      };
      measure();

      board = createSplitFlap(canvas, {
        cols,
        rows,
        // The Nordic drum, not the 40-flap alnum one. Two reasons, both about this
        // archive's own text: Å/Ä/Ö, because artist folders include Mäkä and
        // löylynlyömä; and 1.6.0's added punctuation — ( ) @ , ' & + — which is most of
        // what module text is made of, from "don't touch my things" through "(c) 1994"
        // to the email addresses sceners left in their sample slots. On the alnum drum
        // all of that blanks out. The 13 extra flaps cost ~700ms on a worst-case wrap,
        // which the cadence below absorbs easily.
        charset: DRUM_NORDIC,
        ink: cssVar("--accent", "#f78f08"),
        card: "#131317",
        board: "#0a0b0d",
        // Unlike the flip-dot board, the shading earns its keep here: the cards are
        // large enough that the fallen-card pile and the top flap's shadow read as
        // depth rather than as noise, and that lighting is most of why a Solari board
        // looks like an object instead of a font.
        shaded: true,
        flipMs: FLIP_MS,
        label: "the module's own text on a split-flap board",
      });
      if (!board) return; // no 2D context — leave the pane empty rather than half-built

      ro = new ResizeObserver(() => {
        if (!board) return;
        if (measure()) board.setOptions({ cols, rows });
        board.resize();
        show();
      });
      ro.observe(host);

      // Wrap to the board's width on word boundaries, so a long greet line breaks
      // where a reader would break it rather than mid-word at column 24.
      function wrap(line: string, width: number): string[] {
        if (line.length <= width) return [line];
        const out: string[] = [];
        let cur = "";
        for (const word of line.split(" ")) {
          if (!cur.length) cur = word.slice(0, width);
          else if (cur.length + 1 + word.length <= width) cur += ` ${word}`;
          else {
            out.push(cur);
            cur = word.slice(0, width);
          }
        }
        if (cur.length) out.push(cur);
        return out;
      }

      let lines: string[] = [];
      let top = 0;

      /** Last window start that still shows real content — paging never goes past it. */
      const maxTop = () => Math.max(0, lines.length - (board?.rows ?? 0));

      function show() {
        if (!board) return;
        const n = board.rows;
        scrollTop = top;
        scrollLen = lines.length;
        scrollWin = n;
        atTop = top <= 0;
        atEnd = top >= maxTop();
        if (!lines.length) {
          board.clear();
          return;
        }
        const win: string[] = [];
        for (let i = 0; i < n; i++) win.push(lines[(top + i) % lines.length] ?? "");
        board.setText(win);
      }

      function rebuild() {
        lines = script.flatMap((l) => wrap(l.toUpperCase(), cols));
        // A blank tail before the loop, so a short script reads as "…and round again"
        // rather than snapping back with no pause.
        if (lines.length) lines = [...lines, "", ""];
        top = 0;
        pageable = !!board && lines.length > board.rows;
        show();
      }

      rescript = rebuild;
      rebuild();

      let lastBeat = playback.beat;
      let held = 0;
      let beats = 0;

      // Paging by hand restarts the hold rather than suppressing it: after a nudge you
      // get a full ~15s to read where you landed, and it drifts on by itself again
      // without needing a "resume" affordance.
      //
      // Clamps rather than wraps, unlike the drift below. The rail between the arrows is
      // a scrollbar, and a scrollbar's thumb sitting at the bottom means there is nothing
      // below — jumping back to the top from there would contradict the one piece of UI
      // telling you where you are. The drift is a different thing: it loops, because an
      // ambient board that stops at the end is a board that has died.
      step = (d: number) => {
        if (!board || !lines.length) return;
        top = Math.max(0, Math.min(maxTop(), top + d));
        held = 0;
        beats = 0;
        show();
      };

      stopFrames = driveFrames(
        (dt) => {
          if (!board || !lines.length) return;
          held += dt;
          if (playback.beat !== lastBeat) {
            lastBeat = playback.beat;
            beats++;
          }
          // Turn on a beat once the line has had its time — and unconditionally if the
          // beats never come (a very quiet or very slow module still has to move).
          const due = (beats >= BEATS_PER_LINE && held >= MIN_HOLD_S) || held >= MAX_HOLD_S;
          if (!due) return;
          held = 0;
          beats = 0;
          // Loop from the last full window back to the start, rather than sliding
          // through positions where the window straddles the end and re-shows the head
          // underneath the tail. Those straddled frames are also what would make the
          // rail's thumb and the arrows disagree about where "the end" is.
          top = top >= maxTop() ? 0 : top + 1;
          show();
        },
        { active: () => active },
      );
    })();

    return () => {
      stopped = true;
      stopFrames?.();
      ro?.disconnect();
      board?.dispose();
    };
  });
</script>

<div class="scroller" bind:this={host} data-testid="scroller-board">
  <canvas bind:this={canvas}></canvas>
  {#if step && pageable}
    <div class="pager">
      <button onclick={() => step?.(-1)} disabled={atTop} aria-label="Previous lines">
        <ChevronUp />
      </button>
      <div class="rail" aria-hidden="true">
        <div class="thumb" style:top="{thumbY}%" style:height="{thumbH}%"></div>
      </div>
      <button onclick={() => step?.(1)} disabled={atEnd} aria-label="Next lines">
        <ChevronDown />
      </button>
    </div>
  {/if}
</div>

<style>
  /* Dark surround, like the flip-dot board and the nixie scene: the unit's own
     casing is near-black, so the pane matches rather than framing it in a lighter
     box. Not theme-following — a lit display only reads in a dark room. */
  .scroller {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    background: #0a0b0d;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
  /* Above the CRT screen's output canvas, on purpose. The screen composites the
     visualisers' canvases and nothing else, so a DOM control can only ever sit in
     front of the glass — which is the right place for it anyway: it is a control, not
     part of the picture, and the same is already true of the pane's own crt and
     fullscreen buttons. z-index rather than DOM order because the screen appends its
     canvas after this one. */
  .pager {
    position: absolute;
    right: 0.4rem;
    top: 50%;
    transform: translateY(-50%);
    z-index: 3;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .pager button {
    display: grid;
    place-items: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    border: 1px solid color-mix(in srgb, var(--accent, #f78f08) 35%, transparent);
    border-radius: 3px;
    background: color-mix(in srgb, #0a0b0d 78%, transparent);
    color: var(--accent, #f78f08);
    cursor: pointer;
    /* Dim until wanted: the board is the thing being looked at. */
    opacity: 0.45;
    transition: opacity 120ms ease;
  }
  .pager button:hover:not(:disabled),
  .pager button:focus-visible {
    opacity: 1;
  }
  /* At an end of the script. Kept visible rather than hidden so the pager doesn't
     change shape as you page, and dimmer than the resting state so "nothing that way"
     reads without having to click to find out. */
  .pager button:disabled {
    opacity: 0.16;
    cursor: default;
  }
  /* The rail: where the window sits in the module's text. Same dim-until-wanted
     treatment as the buttons, brightening with the whole pager so the trio reads
     as one control. */
  .rail {
    position: relative;
    width: 2rem;
    height: 3.6rem;
    opacity: 0.45;
    transition: opacity 120ms ease;
  }
  .pager:hover .rail,
  .pager:focus-within .rail {
    opacity: 1;
  }
  .rail::before {
    content: "";
    position: absolute;
    left: 50%;
    top: 0;
    bottom: 0;
    width: 3px;
    transform: translateX(-50%);
    border-radius: 2px;
    background: color-mix(in srgb, var(--accent, #f78f08) 22%, transparent);
  }
  .thumb {
    position: absolute;
    left: 50%;
    width: 3px;
    transform: translateX(-50%);
    border-radius: 2px;
    background: var(--accent, #f78f08);
  }
  /* Squared strokes, like the rest of the family's icons. */
  .pager :global(svg) {
    width: 1rem;
    height: 1rem;
    stroke-width: 2.4;
    stroke-linecap: square;
    stroke-linejoin: miter;
  }
</style>
