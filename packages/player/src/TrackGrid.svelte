<script lang="ts">
  // The tracker frame: what makes a grid of columns read as a tracker rather
  // than a table.
  //
  // Three things do that work, and none of them is the cell content:
  //   * a fixed line the music passes under, with the rows translated so the
  //     current one sits on it — "a stick in the river";
  //   * whole-column paging, so a column is never half-cut at the edge;
  //   * per-column VU bars rising from that line, ProTracker style.
  //
  // All three were built for the module pattern grid and are just as right for a
  // SID's voices, which is why they live here now: the two views differ in what
  // a row *is* (a pattern row vs a reconstructed raster frame), not in how the
  // grid should behave. Callers supply cells through snippets and this owns the
  // measuring, windowing, translation and chrome.
  import type { Snippet } from "svelte";

  import { channelWindow, ROWNUM_W } from "./channel-window";
  import ChannelPager from "./ChannelPager.svelte";
  import { pageSwipe } from "./pageSwipe";

  type Props = {
    /** How many columns exist in total (channels, or voices across all chips). */
    columns: number;
    /** How many rows exist. */
    rows: number;
    /** Row height, px. Fixed — the translation maths depends on it. */
    rowH: number;
    /** The row that should sit on the line. */
    centerRow: number;
    /**
     * Where the line sits, as a fraction of viewport height.
     *
     * 0.5 for a score, where the rows below the line are what's coming. A live
     * trace has no future — those rows haven't been played yet — so it puts the
     * line low and gives the space to history instead of to blank surface.
     */
    centerAt?: number;
    /** Per-column level, 0..1. Empty or absent draws no bars. */
    vu?: number[];
    /** Narrowest a column may be before the view pages instead of shrinking. */
    minCell?: number;
    /** Header height, px. 0 draws no header. */
    headH?: number;
    /** Extra classes for one row (active/playhead bands). */
    rowClass?: (r: number) => string;
    /**
     * Extra classes for one row's sliding column strip.
     *
     * Separate from `rowClass` because the beat/measure tint has to ride the
     * strip, not the static row: on a tinted row the cells would otherwise
     * appear to slide against a fixed band while plain rows didn't, which reads
     * as the highlighted rows animating out of step.
     */
    stripClass?: (r: number) => string;
    /** Left gutter content for a row — the row number, or nothing. */
    rowLabel?: Snippet<[number]>;
    /** One column's header. */
    headCell?: Snippet<[number, number]>;
    /** One cell: row, column, and the column's current width in px. */
    cell: Snippet<[number, number, number]>;
    /** Column the view should keep in the window (an edit cursor). */
    followColumn?: number;
    onkeydown?: (e: KeyboardEvent) => void;
    onclick?: (e: MouseEvent) => void;
    /** Focusable + role=grid. Off for a read-only view like the SID trace, which
     *  has no cursor to move and shouldn't take the tab stop. */
    interactive?: boolean;
    gutterW?: number;
  };

  let {
    columns,
    rows,
    rowH,
    centerRow,
    centerAt = 0.5,
    vu = [],
    minCell,
    headH = 0,
    rowClass,
    stripClass,
    rowLabel,
    headCell,
    cell,
    followColumn,
    onkeydown,
    onclick,
    interactive = false,
    gutterW = ROWNUM_W,
  }: Props = $props();

  /** Per-column VU bar width and height, ProTracker style. */
  const BAR_W = 16;
  const vuMax = $derived(rowH * 6);

  let vpH = $state(0);
  let vpW = $state(0);
  let gridEl = $state<HTMLDivElement | null>(null);

  export function focus() {
    gridEl?.focus();
  }

  // Whole columns only; `offset` is stored unclamped and re-clamped on every
  // read, so a resize that shrinks how many fit self-corrects.
  let offset = $state(0);
  const win = $derived(channelWindow(vpW, columns, offset, minCell, gutterW));
  const stripW = $derived(columns * win.colW);
  const shiftX = $derived(-win.offset * win.colW);
  function page(dir: 1 | -1) {
    offset = win.offset + dir; // from the clamped offset; channelWindow re-clamps
  }

  // Follow a cursor that walks off the window. Reads win/offset untracked so it
  // reacts to the cursor moving, not to manual paging — which it would otherwise
  // fight (paging right with the cursor at column 0 snapped straight back).
  $effect(() => {
    if (followColumn == null) return;
    const c = followColumn;
    const o = win.offset;
    const v = win.visible;
    if (c < o) offset = c;
    else if (c >= o + v) offset = c - v + 1;
  });

  const translateY = $derived(vpH * centerAt - (centerRow + 0.5) * rowH);
</script>

<!-- The tab stop and the grid role are the same switch: a read-only view (the SID
     trace) is neither focusable nor a grid widget. svelte-check can't see that
     the two are tied, so it reads the dynamic tabindex as landing on a
     non-interactive element. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="tg"
  role={interactive ? "grid" : "table"}
  tabindex={interactive ? 0 : undefined}
  bind:this={gridEl}
  bind:clientHeight={vpH}
  bind:clientWidth={vpW}
  {onkeydown}
  {onclick}
  use:pageSwipe={{ onPage: page }}
>
  {#if headH > 0 && headCell}
    <!-- Column-aligned header, windowed with the columns below it. -->
    <div class="thead" style:height="{headH}px">
      <span class="hgutter" style:width="{gutterW}px" style:margin-left="{win.leftEdgeW}px"></span>
      <div class="clip" style:width="{win.windowW}px">
        <div class="strip" style:width="{stripW}px" style:transform="translateX({shiftX}px)">
          {#each { length: columns } as _, i (i)}
            <span class="thcell" style:width="{win.colW}px">{@render headCell(i, win.colW)}</span>
          {/each}
        </div>
      </div>
    </div>
  {/if}

  <div class="centerline" style:height="{rowH}px" style:top="{centerAt * 100}%"></div>

  <div class="rows" style:transform="translateY({translateY}px)">
    {#each { length: rows } as _, r (r)}
      <div class="trow {rowClass?.(r) ?? ''}" data-r={r} style:height="{rowH}px">
        <span class="rownum" style:width="{gutterW}px" style:margin-left="{win.leftEdgeW}px">
          {#if rowLabel}{@render rowLabel(r)}{/if}
        </span>
        <div class="clip" style:width="{win.windowW}px">
          <div
            class="strip rstrip {stripClass?.(r) ?? ''}"
            style:width="{stripW}px"
            style:height="{rowH}px"
            style:transform="translateX({shiftX}px)"
          >
            {#each { length: columns } as _, c (c)}{@render cell(r, c, win.colW)}{/each}
          </div>
        </div>
      </div>
    {/each}
  </div>

  {#if vu.length}
    <!-- Bars rise from the line, so the loudest voice is read against the row
         that produced it rather than off in a separate meter. -->
    <div class="vu-overlay" style:left="{gutterW + win.leftEdgeW}px" style:width="{win.windowW}px">
      <div class="vu-strip" style:width="{stripW}px" style:transform="translateX({shiftX}px)">
        {#each { length: columns } as _, i (i)}
          <div
            class="vubar"
            style:left="{i * win.colW + (win.colW - BAR_W) / 2}px"
            style:width="{BAR_W}px"
            style:bottom="{(1 - centerAt) * 100}%"
            style:height="{Math.min(1, vu[i] ?? 0) * vuMax}px"
          ></div>
        {/each}
      </div>
    </div>
  {/if}

  <ChannelPager
    canLeft={win.canLeft}
    canRight={win.canRight}
    leftEdgeW={win.leftEdgeW}
    rightEdgeW={win.rightEdgeW}
    onPage={page}
  />
</div>

<style>
  .tg {
    height: 100%;
    overflow: hidden;
    position: relative;
    background: var(--surface);
    color: var(--surface-fg);
    /* App sets --tracker-font (party: per-platform DOS/Amiga). Fall back to the
       retro mono font both apps define, then a universal monospace — never an
       undefined var, which would drop to the default serif. */
    font-family: var(--tracker-font, var(--font-mono-retro, ui-monospace, monospace));
    font-size: 16px;
    line-height: 1;
    white-space: nowrap;
    /* Vertical is fixed (centerline); horizontal swipe pages columns. */
    touch-action: none;
  }

  /* Clip/slide wrapper for one whole-column window; the strip inside holds every
     column and translates by whole columns (animated) so paging glides. */
  .clip {
    flex: 0 0 auto;
    overflow: hidden;
  }
  .strip {
    display: flex;
    transition: transform 0.18s ease;
  }
  .thead .strip {
    height: 100%;
  }

  /* The current row — the strongest cue in the view, clearly above any
     beat/measure tint, so "you are here" reads instantly. */
  .centerline {
    position: absolute;
    left: 0;
    right: 0;
    transform: translateY(-50%);
    background: color-mix(in srgb, var(--accent) 34%, var(--surface-2));
    box-shadow:
      0 -1px 0 color-mix(in srgb, var(--accent) 60%, transparent),
      0 1px 0 color-mix(in srgb, var(--accent) 60%, transparent);
    z-index: 0;
  }

  .rows {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 1;
  }
  .trow {
    display: flex;
    align-items: center;
  }
  /* Row states. Generic tracker semantics, so they live with the frame rather
     than with either view: the row element is this component's markup, and a
     caller's scoped CSS can't reach it.
       beat/measure — the FT2/OpenMPT rhythm cue, a neutral 2-step kept subtle so
                      it never competes with the accent centerline.
       active       — the row the engine is sounding.
       playhead     — the editor sequencer's row: a bold sweeping bar, clearly
                      distinct from the per-cell edit cursor so both read at once. */
  .trow.beat,
  .trow.measure {
    color: var(--surface-fg-beat);
  }
  .trow.active {
    color: var(--surface-fg-active);
  }
  /* Not yet sounded — the SID trace's lookahead. Dimmed so the line still reads
     as "you are here" and the future doesn't compete with the present. */
  .trow.ahead {
    opacity: 0.45;
  }
  .trow.playhead {
    background: color-mix(in srgb, var(--accent) 30%, transparent);
    box-shadow: inset 3px 0 0 var(--accent);
    color: var(--surface-fg-active);
  }
  .rstrip {
    align-items: center;
  }
  /* The rhythm tint rides the sliding strip, not the static row — see
     `stripClass`. */
  .rstrip.beat {
    background: color-mix(in srgb, var(--surface-fg) 6%, transparent);
  }
  .rstrip.measure {
    background: color-mix(in srgb, var(--surface-fg) 14%, transparent);
  }
  .rownum {
    flex: 0 0 auto;
    text-align: right;
    /* Padding inside the gutter width, not added to it. Without this the rows'
       gutter is 42px while the header's is 30px, so every column header sits
       12px left of the column it names — which is what it did before the two
       shared a frame, invisibly. */
    box-sizing: border-box;
    padding: 0 6px;
    /* --surface-fg, NOT --surface-fg-dim: the dim token is halo's lightest text
       and is near-invisible on the light theme. This stays legible on both. */
    color: var(--surface-fg);
    background: var(--surface);
    z-index: 2;
  }
  .tg:focus-visible {
    outline: 1px solid color-mix(in srgb, var(--accent) 60%, transparent);
    outline-offset: -1px;
  }

  .thead {
    position: absolute;
    top: 0;
    left: 0;
    display: flex;
    z-index: 3;
  }
  .hgutter {
    flex: 0 0 auto;
    background: var(--surface-bar);
    border-bottom: 1px solid var(--surface-line-2);
  }
  .thcell {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    /* Padding comes out of the column width the window allotted, never adds to
       it — otherwise the header strip is wider than the row strip beneath and
       the labels drift off their columns. */
    box-sizing: border-box;
    padding: 2px 8px;
    border-left: 1px solid var(--surface-line);
    border-bottom: 1px solid var(--surface-line-2);
    background: var(--surface-bar);
    overflow: hidden;
  }

  .vu-overlay {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 2;
    overflow: hidden;
    pointer-events: none;
  }
  .vu-strip {
    position: absolute;
    inset: 0;
    transition: transform 0.18s ease;
  }
  /* Green → yellow → red over a fixed 108px span, so the colour means a level
     rather than a fraction of whatever height the bar happens to have. `bottom`
     is set inline to sit on the centerline wherever the caller put it. */
  .vubar {
    position: absolute;
    background: linear-gradient(to top, #2ecc40, #ffdc00 55%, #ff4136);
    background-size: 100% 108px;
    background-position: bottom;
    transition: height 0.05s linear;
  }
</style>
