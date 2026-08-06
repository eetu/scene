<script lang="ts">
  // The SID's pattern grid — one row per raster frame, one column per voice.
  //
  // A module has a score to display; a SID has 6502 code writing registers 50
  // times a second. So each row here is the chip's state at one raster frame,
  // reconstructed in the decode worker from cycle-stamped register writes.
  //
  // It shows the future as well as the past, which surprises people: the decoder
  // runs ~1.5s ahead of the worklet, so those frames exist well before they're
  // audible. They come straight from the worker rather than riding the audio
  // relay, each carrying the playback time it's due, and the view locates itself
  // by the clock. What it still isn't is a *score* — nothing exists until it has
  // been decoded, so there's no seeking within it and nothing to edit.
  //
  // The frame around it (centerline, whole-column paging, VU bars rising off the
  // line) is the module grid's, shared through TrackGrid: the two views differ in
  // what a row *is*, not in how a tracker should behave.
  import { decodeChips } from "./sid/registers";
  import { traceRow } from "./sid/trace";
  import { playback } from "./state.svelte";
  import TrackGrid from "./TrackGrid.svelte";

  /** Frames drawn either side of the playhead. The store keeps far more
   *  (TRACE_ROWS); drawing them all would re-render 1024 rows at 50 Hz for no
   *  gain, since only a screenful is ever visible. */
  const BEHIND = 48;
  const AHEAD = 32;
  const ROW_H = 18;

  /**
   * Where the playing frame sits — mid-pane, like a module's.
   *
   * It can be, because the grid genuinely has a future to show: the decoder runs
   * a jitter buffer ahead of the worklet, so frames are reconstructed ~1.5s
   * before they're audible and each carries the time it's due. The rows below
   * the line are notes that haven't sounded yet.
   *
   * `AHEAD` is deliberately well under that horizon — it shrinks when the
   * decoder is starved, and a grid that visibly runs dry is worse than one that
   * shows a little less.
   */
  const CENTER_AT = 0.5;

  /**
   * Narrowest a voice column may get before the view pages instead of shrinking.
   *
   * Much narrower than a module's 130, and chosen so the ordinary case — one
   * chip, three voices — still fits whole on a phone: 320px less the frame
   * number gutter leaves ~96px each, enough for a note and a waveform.
   *
   * A 2SID or 3SID tune has six or nine voices and will page on a narrow pane
   * rather than shrink below legibility. That's the module grid's behaviour for
   * a many-channel tune, and it's the trade that comes with adopting its frame:
   * a column is never half-cut, and never squeezed to nothing.
   */
  const MIN_CELL = 64;

  const all = $derived(playback.sidTrace);
  const times = $derived(playback.sidTraceAt);

  /** Index of the frame currently sounding: the last one whose time has passed.
   *
   *  Binary search — the buffer is time-ordered and this runs on every position
   *  update, of which there are ~47 a second. */
  const playing = $derived.by(() => {
    const t = playback.position;
    let lo = 0;
    let hi = times.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    // Before the first frame is due, sit at the start rather than at -1.
    return found < 0 ? (times.length ? 0 : -1) : found;
  });

  const start = $derived(Math.max(0, playing - BEHIND));
  const end = $derived(Math.min(all.length, playing + AHEAD + 1));

  /** Voices per row, from the newest row — a tune's chip count is fixed for the
   *  life of the tune, so this is stable. */
  const voiceCount = $derived(all.length ? decodeChips(all[all.length - 1]).length * 3 : 0);

  /** The drawn window, each row decoded (and cached) against its predecessor.
   *  The predecessor comes from the full ring, not the window, so the top row
   *  diffs correctly rather than reading as all-new. */
  const view = $derived(
    playing < 0 ? [] : all.slice(start, end).map((r, i) => traceRow(r, all[start + i - 1])),
  );

  /** Fit as many fields as the column allows. They drop in order of how much
   *  they carry: ADSR first (it changes rarely), then the waveform. The note
   *  never drops — without it there is no music on screen, and one column of
   *  notes per voice is still a tracker.
   *
   *  Driven by the width TrackGrid hands each cell, so it follows the actual
   *  flexed column rather than a guess from the viewport: with six or nine
   *  voices the columns are far narrower than the same pane would suggest. */
  const detail = (w: number) => (w >= 150 ? "full" : w >= 118 ? "mid" : w >= 88 ? "lean" : "bare");
</script>

{#if !view.length}
  <div class="tr-empty">{playback.current ? "no frames yet" : "nothing playing"}</div>
{:else}
  <TrackGrid
    columns={voiceCount}
    rows={view.length}
    rowH={ROW_H}
    centerRow={playing - start}
    centerAt={CENTER_AT}
    minCell={MIN_CELL}
    headH={22}
    vu={playback.vu}
    rowClass={(r) =>
      r === playing - start
        ? "now"
        : // Decoded but not yet sounded. Dimmed by the frame, because reading the
          // lookahead as already-played would misrepresent where the tune is.
          r > playing - start
          ? "ahead"
          : ""}
    rowLabel={frameNumber}
    headCell={voiceHead}
    cell={voiceCell}
  />
{/if}

{#snippet frameNumber(r: number)}
  <!-- The absolute frame index, so the grid reads as a position in the tune
       rather than a position in the scroll window. -->
  <span class="frm">{(start + r) % 1000}</span>
{/snippet}

{#snippet voiceHead(i: number, w: number)}
  <span class="vhead" style:width="{w}px">V{i + 1}</span>
{/snippet}

{#snippet voiceCell(r: number, c: number, w: number)}
  {@const cell = view[r]?.[c]}
  {@const d = detail(w)}
  <span class="vcell" style:width="{w}px">
    {#if cell}
      <span class="note" class:hit={cell.note}>{cell.note ?? "···"}</span>
      {#if d !== "bare"}
        <span class="wf" class:chg={cell.waveChanged}>{cell.wave}</span>
      {/if}
      {#if d === "full" || d === "mid"}
        <span class="adsr" class:chg={cell.adsrChanged}
          >{cell.adsrChanged ? cell.adsr : "····"}</span
        >
      {/if}
      {#if d === "full"}
        <span class="pw" class:chg={cell.pulseChanged}
          >{cell.pulseChanged ? cell.pulse : "···"}</span
        >
      {/if}
    {/if}
  </span>
{/snippet}

{#if playback.sidTraceDense}
  <!-- Honest about what the rows can't show rather than implying they're the
       whole story: a digi tune streams samples through the volume register
       thousands of times a second, and one row per frame cannot hold that. -->
  <p class="lossy">sample playback — this tune writes faster than one row per frame can show</p>
{/if}

<style>
  .tr-empty {
    display: grid;
    place-items: center;
    height: 100%;
    color: var(--muted);
    font-size: 12px;
  }
  .lossy {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    margin: 0;
    padding: 3px 8px;
    font-size: 11px;
    color: var(--muted);
    background: var(--panel);
    z-index: 4;
  }

  .frm {
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .vhead {
    font-size: 11px;
    color: var(--surface-fg);
  }

  .vcell {
    flex: 0 0 auto;
    display: flex;
    gap: 5px;
    align-items: center;
    /* The frame hands out an exact column width; padding must come out of it,
       not add to it, or every column renders 16px over and the strip overflows
       its own window. */
    box-sizing: border-box;
    padding: 0 8px;
    font-size: 13px;
    /* Column dividers, matching the module grid's cells. */
    border-left: 1px solid var(--surface-line);
    overflow: hidden;
    /* The whole point of a grid is that a column stays a column while the
       numbers under it change. */
    font-variant-numeric: tabular-nums;
  }
  /* Widths in `ch` — the advance width of a digit — because every field holds a
     fixed number of monospace characters. `em` is the font SIZE, not its advance
     width, so it over-reserved by ~60% and a 2SID tune ran off a phone screen. */
  .note {
    flex: 0 0 auto;
    width: 3.6ch;
    /* --muted, not --surface-fg-dim: that token goes invisible on the light
       theme, and the var() fallback never fires because it IS defined. */
    color: var(--muted);
  }
  /* A struck note is the event worth seeing; the continuation dots recede. */
  .note.hit {
    color: var(--accent);
  }
  .wf,
  .adsr,
  .pw {
    flex: 0 0 auto;
    color: var(--muted);
    opacity: 0.55;
    overflow: hidden;
  }
  .wf {
    width: 3ch;
  }
  .adsr {
    width: 4.4ch;
  }
  .pw {
    width: 3.4ch;
  }
  .wf.chg,
  .adsr.chg,
  .pw.chg {
    color: var(--surface-fg);
    opacity: 1;
  }
</style>
