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
  import { boardView, BOARD_MODES, setBoardMode } from "./board-mode.svelte";
  import { departureLines, departureRows, HEADER, STATUS_DRUM, TIME_W, TIME_X } from "./departures";
  import { moduleLines } from "./module-text";
  import { upcoming } from "./player.svelte";
  import { driveFrames } from "./raf";
  import { playback } from "./state.svelte";

  let { active = true }: { active?: boolean } = $props();

  let host: HTMLDivElement;
  let canvas: HTMLCanvasElement | undefined = $state();

  // A flap card is markedly taller than it is wide — this is the module aspect the
  // real Solari units use, and cols are derived from it so characters stay square-ish
  // whatever shape the pane is.
  const CARD_ASPECT = 0.62;
  // The scrollbar column's own drum: blank, groove, thumb, and the two end arrows. Five
  // flaps — the shortest drum on the board, which is what real installations used for
  // their fast-changing fields, and it keeps a thumb move to a four-step wrap at worst
  // (~220ms).
  //
  // The groove matters. Left blank, the unlit track showed nothing and the thumb floated
  // with no indication of how far it could travel — which is most of what a scrollbar is
  // for. Groove and thumb sit adjacent on the drum so the commonest transition between
  // them costs a single flap.
  const TRACK = " \u2502\u2588\u25b2\u25bc";
  const TRACK_GROOVE = "\u2502";
  const TRACK_THUMB = "\u2588";
  const TRACK_UP = "\u25b2";
  const TRACK_DOWN = "\u25bc";
  // The groove is hardware, not signal: a neutral dim grey rather than the theme accent,
  // so the thumb riding in it is the thing that reads.
  const TRACK_INK = "#5c5c6a";
  // Shorter than the 90ms default: at 90 a worst-case wrap across the 53-flap Nordic
  // drum is ~4.8s, which would still be running when the next line is due.
  const FLIP_MS = 55;
  // The queue face flips faster. A departures board changes a whole column of fields at
  // once when the queue moves, and at 55ms that cascade outlasts the second-tick that
  // follows it; at 32ms it lands well inside. The text face keeps the slower, heavier
  // fall — there the weight IS the effect, and nothing needs to keep up with a clock.
  const FLIP_MS_QUEUE = 32;
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

  /** The board's script for the loaded module — see module-text.ts, which the hi-fi's
   *  text face reads the same way. */
  const script = $derived(moduleLines(playback.current, playback.instruments, playback.samples));

  // Re-script the board when the loaded module changes. Declared out here because
  // $effect has to be created during component init — inside the async setup below
  // it would run after init and Svelte rejects it. The setup assigns `rescript` once
  // the board exists and calls it for the first paint; this only handles the changes.
  let rescript: (() => void) | null = null;
  // Re-configure the board when the face changes. Same reason as `rescript`: $effect has
  // to be created during component init, not inside the async setup.
  let reface: (() => void) | null = null;
  $effect(() => {
    void boardView.mode;
    reface?.();
  });
  $effect(() => {
    void script;
    rescript?.();
  });

  // Hand paging. Assigned once the board exists; `$state` so the a11y control appears
  // with it rather than rendering dead. `pageable` stays false when the whole script
  // already fits on the board — there is nothing to scroll to, and a scrollbar for a
  // page that fits is a lie.
  let step: ((d: number) => void) | null = $state(null);
  let jump: ((to: number) => void) | null = $state(null);
  let hit: ((ev: PointerEvent) => void) | null = $state(null);
  let pageable = $state(false);

  // Scroll position, for the invisible range that carries this control's semantics.
  // The visible scrollbar is drawn as flaps in the panel's last column (see TRACK), so
  // these exist for the a11y layer rather than for painting.
  let scrollTop = $state(0);
  let scrollMax = $state(0);

  onMount(() => {
    let stopped = false;
    let board: SplitFlapBoard | null = null;
    let stopFrames: (() => void) | null = null;
    let ro: ResizeObserver | null = null;

    void (async () => {
      const { createSplitFlap, DRUM_DIGITS, DRUM_NORDIC } = await import("@glowbox/split-flap");
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
      // Field drums. The scrollbar column is the same in both faces; the queue face adds
      // a digit drum for the time column and a three-flap drum for the status glyph.
      // Short drums are the point — a 14-flap digit module rolls a second in a fraction
      // of the time a 53-flap letter module would, which is exactly why real boards mixed
      // module types per field rather than carding one drum for everything.
      const zones = () => {
        const track = { x: cols - 1, y: 0, cols: 1, rows, charset: TRACK };
        if (boardView.mode !== "departures") return [track];
        // No scrollbar on the queue face — the queue is a window, not a document, so
        // there is nothing to scroll and the last column belongs to the status flag
        // instead. Worth being explicit: zones overlap by "later wins", so leaving the
        // track zone in would silently steal that column back and blank every flag,
        // which is exactly what it did the first time.
        return [
          // y: 1 so the header row keeps the letter drum and can spell TIME.
          { x: TIME_X, y: 1, cols: TIME_W, rows: rows - 1, charset: DRUM_DIGITS },
          { x: cols - 1, y: 1, cols: 1, rows: rows - 1, charset: STATUS_DRUM },
        ];
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
        // Last column is the scrollbar. A zone rather than a second canvas so it flips
        // with the same physics as the text and composites through the CRT with it.
        drums: zones(),
        // Per-flap ink: only the groove is re-coloured, so thumb and arrows keep the
        // board's accent and the track sits behind them.
        palette: { [TRACK_GROOVE]: { ink: TRACK_INK } },
        ink: cssVar("--accent", "#f78f08"),
        card: "#131317",
        board: "#0a0b0d",
        // Unlike the flip-dot board, the shading earns its keep here: the cards are
        // large enough that the fallen-card pile and the top flap's shadow read as
        // depth rather than as noise, and that lighting is most of why a Solari board
        // looks like an object instead of a font.
        shaded: true,
        flipMs: boardView.mode === "departures" ? FLIP_MS_QUEUE : FLIP_MS,
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
      const maxTop = () => Math.max(0, lines.length - contentRows());
      /** Columns left for text once the scrollbar column is reserved. */
      const textCols = () => Math.max(4, cols - 1);
      /** Rows the faces may lay out into — the last one belongs to the face toggle, so
       *  the chips can never clip a line of the module's text. */
      const contentRows = () => Math.max(1, (board?.rows ?? 1) - 1);

      /** Paint the scrollbar column: arrows at the ends, thumb across the middle. */
      function drawTrack() {
        if (!board) return;
        const n = contentRows();
        const x = board.cols - 1;
        board.setChar(x, 0, TRACK_UP);
        board.setChar(x, n - 1, TRACK_DOWN);
        const trackRows = n - 2;
        if (trackRows <= 0) return;
        const span = maxTop();
        // Thumb length reflects how much of the script is on screen, with a one-cell
        // floor so it never disappears on a long module.
        const len = Math.max(1, Math.round((n / lines.length) * trackRows)) || 1;
        const at = span ? Math.round((top / span) * (trackRows - len)) : 0;
        for (let i = 0; i < trackRows; i++) {
          const lit = i >= at && i < at + len;
          board.setChar(x, i + 1, lit ? TRACK_THUMB : TRACK_GROOVE);
        }
      }

      /** The queue face: a header row, then one row per upcoming track. */
      function showDepartures() {
        if (!board) return;
        const n = contentRows();
        const list = upcoming(Math.max(0, n - 1));
        const rows = departureRows(list, board.cols, n, playback.position);
        board.setText([HEADER, ...departureLines(rows, board.cols)]);
      }

      function show() {
        if (!board) return;
        if (boardView.mode === "departures") return showDepartures();
        const n = contentRows();
        scrollTop = top;
        scrollMax = maxTop();
        if (!lines.length) {
          board.clear();
          return;
        }
        const win: string[] = [];
        for (let i = 0; i < n; i++) win.push(lines[(top + i) % lines.length] ?? "");
        // Text first, then the track over it: setText pads every row to the full width,
        // so writing the column first would blank it again.
        board.setText(win);
        if (pageable) drawTrack();
      }

      function rebuild() {
        lines = script.flatMap((l) => wrap(l.toUpperCase(), textCols()));
        // A blank tail before the loop, so a short script reads as "…and round again"
        // rather than snapping back with no pause.
        if (lines.length) lines = [...lines, "", ""];
        top = 0;
        pageable = boardView.mode === "scroll" && !!board && lines.length > contentRows();
        show();
      }

      // Swapping face swaps the module types under the fields, so the board is
      // re-configured rather than merely repainted.
      reface = () => {
        if (!board) return;
        board.setOptions({
          drums: zones(),
          flipMs: boardView.mode === "departures" ? FLIP_MS_QUEUE : FLIP_MS,
        });
        board.clear();
        rebuild();
      };

      rescript = rebuild;
      rebuild();

      let lastBeat = playback.beat;
      let held = 0;
      let beats = 0;

      // Paging by hand restarts the hold rather than suppressing it: after a nudge you
      // get a full ~15s to read where you landed, and it drifts on by itself again
      // without needing a "resume" affordance.
      //
      // Clamps rather than wraps, unlike the drift below. The column IS a scrollbar, and
      // a thumb sitting at the bottom means there is nothing below — jumping back to the
      // top from there would contradict the one piece of UI telling you where you are.
      // The drift is a different thing: it loops, because an ambient board that stops at
      // the end is a board that has died.
      step = (d: number) => {
        if (!board || !lines.length) return;
        top = Math.max(0, Math.min(maxTop(), top + d));
        held = 0;
        beats = 0;
        show();
      };

      // Pointer -> module. The library owns the layout but exposes no hit test, so this
      // assumes a uniform cell pitch across the canvas (`gap` insets the drawn card
      // inside its cell rather than changing the pitch). Worth revisiting if a cellAt()
      // ever lands upstream — this is the one bit of the board's geometry we duplicate.
      hit = (ev: PointerEvent) => {
        if (!board || !lines.length || !pageable) return;
        const r = canvas!.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;
        const cx = Math.floor(((ev.clientX - r.left) / r.width) * board.cols);
        const cy = Math.floor(((ev.clientY - r.top) / r.height) * board.rows);
        if (cx !== board.cols - 1) return; // not the scrollbar column
        const n = board.rows;
        if (cy <= 0) step?.(-1);
        else if (cy >= n - 1) step?.(1);
        else {
          // Jump: land the window where the tap sits along the track.
          const frac = (cy - 1) / Math.max(1, n - 3);
          jump?.(Math.round(frac * maxTop()));
        }
      };

      jump = (to: number) => {
        if (!board || !lines.length) return;
        top = Math.max(0, Math.min(maxTop(), to));
        held = 0;
        beats = 0;
        show();
      };

      let sinceDep = 0;
      let lastDep = "";

      stopFrames = driveFrames(
        (dt) => {
          if (!board) return;

          if (boardView.mode === "departures") {
            // Four times a second is plenty: the only thing moving is the elapsed field,
            // which changes once a second. Re-rendered only when the text actually
            // differs, so a settled board issues no flips at all.
            sinceDep += dt;
            if (sinceDep < 0.25) return;
            sinceDep = 0;
            const sig = `${playback.queueIndex}|${Math.floor(playback.position)}`;
            if (sig === lastDep) return;
            lastDep = sig;
            showDepartures();
            return;
          }

          if (!lines.length) return;
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
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <canvas bind:this={canvas} onpointerdown={(e) => hit?.(e)}></canvas>
  <!-- Two faces of one display, not two visualisers: the pane's own picker is already
       fifteen wide. Same placement and treatment as the flip-dot board's modes. -->
  <div class="faces">
    {#each BOARD_MODES as m (m.id)}
      <button
        class:on={boardView.mode === m.id}
        onclick={() => setBoardMode(m.id)}
        aria-pressed={boardView.mode === m.id}>{m.label}</button
      >
    {/each}
  </div>
  {#if pageable}
    <!-- The scrollbar you SEE is the panel's last column, drawn in flaps (see TRACK) so
         it flips with the text and composites through the CRT with it. What lives here is
         only what a canvas cannot be: a real focusable control. @glowbox/split-flap
         exposes the board as an image and leaves the semantics to the consumer, so this
         range carries the name, the value, the focus ring and the keyboard model — and is
         invisible, because the panel already draws the visual. -->
    <input
      class="scrub"
      type="range"
      min="0"
      max={scrollMax}
      step="1"
      value={scrollTop}
      aria-label="Scroll the module's text"
      oninput={(e) => jump?.(Number(e.currentTarget.value))}
    />
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
  /* The reserved bottom strip (see contentRows). Every other corner is content: the top
     row is the queue face's column header and the text face's title, and the right-hand
     column is the scrollbar in one face and the status flags in the other. Bottom-left
     looked free and wasn't — the text window fills every row it is given — so the layout
     now keeps a row back rather than the chips hoping to land on a blank one.

     Opaque chips, like the flip-dot board's modes and for the same reason: a translucent
     label over flap cards washes out whichever way the contrast falls. */
  .faces {
    position: absolute;
    left: 0.4rem;
    bottom: 0.4rem;
    z-index: 3;
    display: flex;
    gap: 0.25rem;
  }
  .faces button {
    padding: 0.2rem 0.5rem;
    border: 1px solid color-mix(in srgb, var(--accent, #f78f08) 35%, transparent);
    border-radius: 3px;
    background: #0a0b0d;
    color: var(--accent, #f78f08);
    font: inherit;
    font-size: 0.7rem;
    line-height: 1.1;
    cursor: pointer;
    opacity: 0.55;
    transition: opacity 120ms ease;
  }
  .faces button:hover,
  .faces button:focus-visible {
    opacity: 0.9;
  }
  .faces button.on {
    opacity: 1;
    border-color: var(--accent, #f78f08);
    background: color-mix(in srgb, var(--accent, #f78f08) 18%, #0a0b0d);
  }
  @media (pointer: coarse) {
    .faces button {
      min-width: 2.75rem;
      min-height: 2.75rem;
      font-size: 0.8rem;
      opacity: 0.7;
    }
  }
  /* Invisible, but present. Laid over the scrollbar column so a drag on the range and a
     tap on the flaps land in the same place, and so focus lands somewhere that matches
     what is drawn.

     opacity, not display:none or visibility:hidden — both of those take an element back
     out of the accessibility tree, which is the entire reason this exists. (The same
     distinction @glowbox/crt just had to fix for the canvases it composites.) */
  .scrub {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    /* One column wide, matching the drum zone, with a touch-sized floor. */
    width: 4%;
    min-width: 2.75rem;
    margin: 0;
    opacity: 0;
    cursor: pointer;
    /* Vertical, so dragging matches the direction the thumb moves. */
    writing-mode: vertical-lr;
  }
  /* The one time it shows itself: a focus ring is worthless if you can't see it. */
  .scrub:focus-visible {
    opacity: 1;
  }
</style>
