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
  // Above the grid sits the chip state the rows have no column for: per voice
  // the pitch it's actually at and how it's routed, and per chip the filter and
  // master volume. That used to be a separate "voices" tab, which meant reading
  // the note, waveform, envelope and level twice in two places — everything it
  // showed beyond these is already a column here, and its level meter was the
  // same `playback.vu` the frame draws as bars.
  //
  // The frame around it (centerline, whole-column paging, VU bars rising off the
  // line) is the module grid's, shared through TrackGrid: the two views differ in
  // what a row *is*, not in how a tracker should behave.
  import { channelWindow } from "./channel-window";
  import { type Chip, decodeChips, gateOf, type Voice } from "./sid/registers";
  import { DOT, traceRow } from "./sid/trace";
  import { playback } from "./state.svelte";
  import TrackGrid from "./TrackGrid.svelte";

  /** Frames drawn either side of the playhead. The store keeps far more
   *  (TRACE_ROWS); drawing them all would re-render 1024 rows at 50 Hz for no
   *  gain, since only a screenful is ever visible. */
  const BEHIND = 48;
  const AHEAD = 32;

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
   * number gutter leaves ~93px each, enough for a note and a waveform.
   *
   * A 2SID or 3SID tune has six or nine voices and will page on a narrow pane
   * rather than shrink below legibility. That's the module grid's behaviour for
   * a many-channel tune, and it's the trade that comes with adopting its frame:
   * a column is never half-cut, and never squeezed to nothing.
   */
  const MIN_CELL = 64;

  /**
   * Wider than the module grid's 30px.
   *
   * The frame number is three characters, and in a square-celled font that is
   * 24px at the small size — where a 30px gutter, less its 6px of padding,
   * offers 18. The number stays at CELL_PX_SMALL at both scales: it's chrome,
   * and at the large size it would want a 60px gutter all to itself.
   */
  const GUTTER_W = 40;

  /**
   * The two cell sizes.
   *
   * C64 Pro Mono is the C64 character ROM: an 8×8 cell, so its advance width is
   * a full em where TopazPlus's is half of one, and every column wants twice the
   * width at a given font-size. It's also a bitmap face, so it is only
   * pixel-exact at multiples of 8 — 12px would be a blurred 1.5×, and there is
   * no size between these two.
   *
   * Which one is in use is decided per pane by `px` below, not by a breakpoint.
   */
  const CELL_PX_LARGE = 16;
  const CELL_PX_SMALL = 8;

  /** Row heights per cell size. 18 is the module grid's, so the large size keeps
   *  the familiar row rhythm; the small one gets proportionally less leading. */
  const ROW_H_LARGE = 18;
  const ROW_H_SMALL = 12;

  /** Header: the voice number on one line, pitch and routing under it at the
   *  small size (they're a readout, not the label). */
  const HEAD_H_LARGE = 34;
  const HEAD_H_SMALL = 26;

  /**
   * How long a voice keeps reading as sounding after its last gated frame.
   *
   * Not a sampling artefact — these are exact raster frames, so a gate that
   * reads low really was low. It's that a voice retriggering every frame is
   * genuinely gate-low for one 20ms frame in each, and at render rate that
   * strobes the whole header. A voice retriggering steadily IS continuously
   * sounding, so it's held, the way a VU meter holds a peak.
   *
   * Counted in frames rather than milliseconds so it's a property of the music
   * rather than of the wall clock: paused, the readout freezes with the grid
   * instead of decaying to silence under a still playhead.
   */
  const HOLD_FRAMES = 7; // ~140ms at 50Hz

  /** Cell padding and inter-field gap, in px. Flat rather than scaled with the
   *  type: they separate fields, and a hairline at the small size separates no
   *  better than it does at the large one. Must match `.vcell`'s CSS — `fits`
   *  below is what decides whether a field is drawn at all. */
  const PAD = 8;
  const GAP = 5;
  /** Field widths, in characters. Every glyph is one full `ch` in this face, so
   *  these are the character counts plus a hair of slack. */
  const NOTE_CH = 3.2;
  const WAVE_CH = 3;
  const ADSR_CH = 4.2;
  const PW_CH = 3.2;

  /** Width a set of fields needs at a given cell size. */
  const fits = (chs: number[], size: number) =>
    chs.reduce((a, b) => a + b, 0) * size + (chs.length - 1) * GAP + 2 * PAD;

  /** Fit as many fields as the column allows. They drop in order of how much
   *  they carry: ADSR first (it changes rarely), then the waveform. The note
   *  never drops — without it there is no music on screen, and one column of
   *  notes per voice is still a tracker.
   *
   *  Derived from the geometry rather than tuned as constants, because the
   *  thresholds move with the cell size: what fits a 150px column at the small
   *  size does not at the large one. */
  const detail = (w: number, size: number) =>
    w >= fits([NOTE_CH, WAVE_CH, ADSR_CH, PW_CH], size)
      ? "full"
      : w >= fits([NOTE_CH, WAVE_CH, ADSR_CH], size)
        ? "mid"
        : w >= fits([NOTE_CH, WAVE_CH], size)
          ? "lean"
          : "bare";

  /** Widest a column flexes to: the width that shows every field at the large
   *  size. Past that the column has nothing more to say, and the module grid's
   *  own cap (160px, tuned for a half-em advance) would freeze this one at
   *  note-plus-waveform however wide the pane got. */
  const MAX_CELL = fits([NOTE_CH, WAVE_CH, ADSR_CH, PW_CH], CELL_PX_LARGE);

  let paneW = $state(0);

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

  /** Chip state at the playhead — the same ring the rows come from, so the
   *  readout above the grid and the row on the line can never disagree. */
  const chips = $derived<Chip[]>(playing >= 0 && all[playing] ? decodeChips(all[playing]) : []);
  /** Flattened, so a voice's position here is its column index. */
  const voices = $derived<Voice[]>(chips.flatMap((c) => c.voices));

  /** Voices gated within the hold window (see HOLD_FRAMES). */
  const held = $derived.by(() => {
    const on = new Set<number>();
    for (let i = Math.max(0, playing - HOLD_FRAMES + 1); i <= playing; i++) {
      const row = all[i];
      if (!row) continue;
      for (let v = 0; v < voices.length; v++) if (gateOf(row, v)) on.add(v);
    }
    return on;
  });

  /** Voices per row, from the newest row — a tune's chip count is fixed for the
   *  life of the tune, so this is stable. */
  const voiceCount = $derived(all.length ? decodeChips(all[all.length - 1]).length * 3 : 0);

  /** The drawn window, each row decoded (and cached) against its predecessor.
   *  The predecessor comes from the full ring, not the window, so the top row
   *  diffs correctly rather than reading as all-new. */
  const view = $derived(
    playing < 0 ? [] : all.slice(start, end).map((r, i) => traceRow(r, all[start + i - 1])),
  );

  /**
   * The column width the frame will hand out, computed here as well as there.
   *
   * `channelWindow` is pure and the width doesn't depend on the paging offset,
   * so this is the same number TrackGrid arrives at — and the cell size has to
   * be decided before the frame is rendered, since it sets the row height.
   */
  const colW = $derived(channelWindow(paneW, voiceCount, 0, MIN_CELL, GUTTER_W, MAX_CELL).colW);

  /**
   * Which cell size is in use.
   *
   * The large face is used only where it costs nothing — where the column shows
   * the same fields it would at the small one. A plain width breakpoint reads
   * well until you cross it: at the large size a field needs roughly twice the
   * room, so widening the pane past a fixed threshold would *drop* a column of
   * data to buy bigger type. This way growing the pane never takes information
   * away; it just eventually doubles the type.
   */
  const px = $derived(
    detail(colW, CELL_PX_LARGE) === detail(colW, CELL_PX_SMALL) ? CELL_PX_LARGE : CELL_PX_SMALL,
  );
  const rowH = $derived(px === CELL_PX_LARGE ? ROW_H_LARGE : ROW_H_SMALL);
  const headH = $derived(px === CELL_PX_LARGE ? HEAD_H_LARGE : HEAD_H_SMALL);

  const pct = (n: number, max: number) => `${Math.round((n / max) * 100)}%`;
  // Integer Hz. The tenth digit is below the resolution of anything you can read
  // at 50 frames a second — with vibrato it just strobes.
  const hz = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)}k` : String(Math.round(n)));
</script>

<div class="tr" bind:clientWidth={paneW} style:--c64-px="{px}px">
  {#if chips.length}
    <!-- Chip-wide: the filter every routed voice passes through, and the master
         volume — the register digi tunes hammer for sampled drums. Neither has a
         column to live in, and neither pages with the voices. -->
    {#each chips as chip (chip.index)}
      <div class="chip" aria-label="SID {chip.index + 1} filter and volume">
        {#if chips.length > 1}<span class="cnum">{chip.index + 1}</span>{/if}
        <span class="lbl">flt</span>
        <span class="modes">
          <i class:lit={chip.lowPass}>LP</i>
          <i class:lit={chip.bandPass}>BP</i>
          <i class:lit={chip.highPass}>HP</i>
        </span>
        <span class="bar" title="cutoff {chip.cutoff}"
          ><b style:width={pct(chip.cutoff, 2047)}></b></span
        >
        <span class="res" title="resonance {chip.resonance}">Q{chip.resonance}</span>
        <span class="lbl">vol</span>
        <span class="bar vol" title="master volume {chip.volume}">
          <b style:width={pct(chip.volume, 15)}></b>
        </span>
        {#if chip.voice3Off}<span class="res" title="voice 3 muted from output">3off</span>{/if}
      </div>
    {/each}
  {/if}

  {#if !view.length}
    <div class="tr-empty">{playback.current ? "no frames yet" : "nothing playing"}</div>
  {:else}
    <TrackGrid
      columns={voiceCount}
      rows={view.length}
      {rowH}
      {headH}
      centerRow={playing - start}
      centerAt={CENTER_AT}
      minCell={MIN_CELL}
      maxCell={MAX_CELL}
      gutterW={GUTTER_W}
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
</div>

{#snippet frameNumber(r: number)}
  <!-- The absolute frame index, so the grid reads as a position in the tune
       rather than a position in the scroll window. -->
  <span class="frm">{(start + r) % 1000}</span>
{/snippet}

{#snippet voiceHead(i: number, w: number)}
  {@const v = voices[i]}
  {@const on = held.has(i)}
  <!-- What the rows can't carry. The pitch, because the grid prints note names
       and a tune under vibrato or a slide is between them; and the routing bits,
       which have no column at all. A gated-off voice recedes rather than
       vanishing — the eye should land on what's sounding. -->
  <!-- No inline width: the frame's header cell is already the column width and
       carries the padding, and a child sized to the full column would render
       over it. -->
  <span class="vhead" class:on>
    <span class="vnum">V{i + 1}</span>
    {#if v}
      <span class="vstate">
        <span class="vhz">{on ? `${hz(v.hz)}Hz` : "—"}</span>
        {#if w >= fits([NOTE_CH, WAVE_CH, ADSR_CH], px)}
          <span class="flags">
            {#if v.ring}<i title="ring modulation">R</i>{/if}
            {#if v.sync}<i title="oscillator sync">S</i>{/if}
            {#if v.filtered}<i class="lit" title="routed through the filter">F</i>{/if}
            {#if v.test}<i title="test bit (oscillator held)">T</i>{/if}
          </span>
        {/if}
      </span>
    {/if}
  </span>
{/snippet}

{#snippet voiceCell(r: number, c: number, w: number)}
  {@const cell = view[r]?.[c]}
  {@const d = detail(w, px)}
  <span class="vcell" style:width="{w}px">
    {#if cell}
      <span class="note" class:hit={cell.note}>{cell.note ?? DOT.repeat(3)}</span>
      {#if d !== "bare"}
        <span class="wf" class:chg={cell.waveChanged}>{cell.wave}</span>
      {/if}
      {#if d === "full" || d === "mid"}
        <span class="adsr" class:chg={cell.adsrChanged}
          >{cell.adsrChanged ? cell.adsr : DOT.repeat(4)}</span
        >
      {/if}
      {#if d === "full"}
        <span class="pw" class:chg={cell.pulseChanged}
          >{cell.pulseChanged ? cell.pulse : DOT.repeat(3)}</span
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
  /* The chip strips take their height; the grid gets the rest. */
  .tr {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .tr :global(.tg) {
    flex: 1;
    min-height: 0;
    /* The frame is 100%-height on its own; as a flex item it takes what's left
       after the chip strips instead. */
    height: auto;
  }

  .tr-empty {
    display: grid;
    place-items: center;
    flex: 1;
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

  /* The C64 character ROM, for every surface that shows chip state. A SID is a
     C64 chip and its trace should read as one — see --font-c64. Never a bare
     var(): an undefined one drops to the default serif. */
  .chip,
  .frm,
  .vhead,
  .vcell {
    font-family: var(--font-c64, var(--font-mono-retro, ui-monospace, monospace));
    /* A bitmap face wants its pixels, not a smoothed approximation of them. */
    -webkit-font-smoothing: none;
  }

  .chip {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
    padding: 3px 8px;
    font-size: 8px;
    color: var(--muted);
    background: var(--surface-bar);
    border-bottom: 1px solid var(--surface-line-2);
  }
  .cnum {
    color: var(--surface-fg);
  }
  .lbl {
    letter-spacing: 0.06em;
  }
  .modes {
    display: flex;
    gap: 3px;
  }
  .modes i {
    font-style: normal;
    opacity: 0.35;
  }
  .modes i.lit {
    color: var(--accent);
    opacity: 1;
  }
  /* Fixed rather than flexed: the strip is as wide as the pane, and a cutoff
     bar that grows with it reads as a progress bar for the tune. A filter sweep
     is a small dial, and it should stay one. */
  .bar {
    flex: 0 0 96px;
    height: 4px;
    background: color-mix(in srgb, var(--border) 70%, transparent);
  }
  .bar b {
    display: block;
    height: 100%;
    background: var(--muted);
    /* Filter sweeps move every frame; easing over roughly one frame reads as a
       slide rather than a stutter. */
    transition: width 60ms linear;
  }
  .bar.vol {
    flex: 0 0 40px;
  }

  /* The gutter's own text size, not just the label's.

     The frame's row-number cell inherits the grid's 16px body size, which sets a
     16px line box inside it however small the label is. At the small cell size
     the rows are 12px, so that box overflows 2px top and bottom — and since the
     gutter is opaque and stacked above the rows, each row's number is then
     painted over by its neighbours and the digits come out shaved at both ends.
     Sizing the cell, not only the span inside it, is what actually fixes it. */
  .tr :global(.rownum) {
    font-size: 8px;
  }
  .frm {
    /* Held at the small size whatever the cells do — see GUTTER_W. */
    font-size: 8px;
    font-variant-numeric: tabular-nums;
  }

  .vhead {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    overflow: hidden;
    color: var(--surface-fg);
    /* A gated-off voice stays visible but recedes. */
    opacity: 0.45;
    transition: opacity 90ms linear;
  }
  .vhead.on {
    opacity: 1;
  }
  .vnum {
    font-size: var(--c64-px);
  }
  .vstate {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 8px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .flags {
    display: flex;
    gap: 3px;
  }
  .flags i {
    font-style: normal;
  }
  .flags i.lit {
    color: var(--accent);
  }

  .vcell {
    flex: 0 0 auto;
    display: flex;
    gap: 5px;
    align-items: center;
    /* The frame hands out an exact column width; padding must come out of it,
       not add to it, or every column renders 16px over and the strip overflows
       its own window. Both must match PAD/GAP, which decide what is drawn. */
    box-sizing: border-box;
    padding: 0 8px;
    font-size: var(--c64-px);
    /* Column dividers, matching the module grid's cells. */
    border-left: 1px solid var(--surface-line);
    overflow: hidden;
    /* The whole point of a grid is that a column stays a column while the
       numbers under it change. */
    font-variant-numeric: tabular-nums;
  }
  /* Widths in `ch` — the advance width of a digit — because every field holds a
     fixed number of monospace characters. `em` is the font SIZE, not its advance
     width; in this face they happen to be equal, but the module grid's face is
     half as wide and the rule has to survive either. */
  .note {
    flex: 0 0 auto;
    width: 3.2ch;
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
    width: 4.2ch;
  }
  .pw {
    width: 3.2ch;
  }
  .wf.chg,
  .adsr.chg,
  .pw.chg {
    color: var(--surface-fg);
    opacity: 1;
  }
</style>
