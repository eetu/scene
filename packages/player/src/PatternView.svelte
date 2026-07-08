<script lang="ts">
  import { untrack } from "svelte";

  import { CELL_W, channelWindow, ROWNUM_W } from "./channel-window";
  import ChannelPager from "./ChannelPager.svelte";
  import ChannelScope from "./ChannelScope.svelte";
  import { pageSwipe } from "./pageSwipe";
  import {
    cellFieldText,
    handleEditKey,
    isChannelSolo,
    moveCursor,
    patternCells,
    playback,
    seekToCursor,
    setCursor,
    soloChannel,
    toggleChannelMute,
  } from "./player.svelte";

  const FIELDS = [0, 1, 2, 3, 4]; // note, inst, vol, fx, param

  // Fixed-metrics tracker layout (px). Topaz is 8×16, so 8px/char. Channel width
  // + row-number gutter are shared with the scroll view (channel-window.ts).
  const ROW_H = 18;
  const BAR_W = 10;
  const VU_MAX = ROW_H * 6; // tallest VU bar

  let vpH = $state(0); // viewport height, for centering the current row
  let vpW = $state(0); // viewport width, for the channel window
  let gridEl = $state<HTMLDivElement | null>(null);

  // Focus the grid when entering edit mode so QWERTY note entry works at once.
  $effect(() => {
    if (playback.editing) gridEl?.focus();
  });

  const pattern = $derived(playback.song?.patterns?.[playback.pattern] ?? null);
  const editCells = $derived(playback.editing ? patternCells(playback.pattern) : null);
  const channels = $derived(playback.song?.channels ?? []);
  const vu = $derived(playback.vu);

  // Channel window: only whole channels show; page through them (chevrons/swipe).
  // `offset` is stored unclamped and re-clamped on every read via channelWindow,
  // so a resize that shrinks how many fit self-corrects.
  let offset = $state(0);
  const win = $derived(channelWindow(vpW, channels.length, offset));
  const stripW = $derived(channels.length * CELL_W);
  const shiftX = $derived(-win.offset * CELL_W);
  function page(dir: 1 | -1) {
    offset = win.offset + dir; // based on the clamped offset; channelWindow re-clamps
  }
  // In EDIT mode, follow the edit cursor's channel when arrows walk it off the
  // window. Tracks only cursorCh (win/offset read untracked) so it reacts to the
  // cursor moving — not to manual paging, which it would otherwise fight (paging
  // right with the cursor at ch0 used to snap straight back).
  $effect(() => {
    if (!playback.editing) return;
    const c = playback.cursorCh;
    untrack(() => {
      if (c < win.offset) offset = c;
      else if (c >= win.offset + win.visible) offset = c - win.visible + 1;
    });
  });

  // Translate the rows so the tracked row sits on the fixed centerline; the
  // pattern moves under the line "like a stick in the river". In edit mode the
  // centerline follows the EDIT CURSOR (so entered notes stay in view); otherwise
  // it follows the playing row.
  const centerRow = $derived(playback.editing ? playback.cursorRow : playback.row);
  const translateY = $derived(vpH / 2 - (centerRow + 0.5) * ROW_H);

  function hex2(n: number): string {
    return n.toString(16).toUpperCase().padStart(2, "0");
  }
  function colXin(i: number): number {
    return i * CELL_W + (CELL_W - BAR_W) / 2; // within the (translated) channel strip
  }

  // Cursor nav — only while the grid is focused. stopPropagation on handled keys
  // so the app's global arrows (track switch) don't also fire; unhandled keys
  // (e.g. space = play/pause) still bubble through.
  function onGridKey(e: KeyboardEvent) {
    if (playback.editing && handleEditKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const d: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    if (e.key in d) {
      moveCursor(...d[e.key]);
    } else if (e.key === "Enter") {
      seekToCursor();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }
  function onGridClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const rowEl = t.closest?.("[data-r]");
    const cellEl = t.closest?.("[data-c]");
    if (!rowEl || !cellEl) return;
    const r = Number(rowEl.getAttribute("data-r"));
    const c = Number(cellEl.getAttribute("data-c"));
    if (playback.editing) {
      const fldEl = t.closest?.("[data-field]");
      setCursor(r, c);
      if (fldEl) playback.cursorField = Number(fldEl.getAttribute("data-field"));
    } else {
      setCursor(r, c, true);
    }
  }
</script>

{#if pattern}
  <div
    class="pv"
    role="grid"
    tabindex="0"
    bind:this={gridEl}
    bind:clientHeight={vpH}
    bind:clientWidth={vpW}
    onkeydown={onGridKey}
    onclick={onGridClick}
    use:pageSwipe={{ onPage: page }}
  >
    {#if playback.canMuteChannels}
      <!-- Column-aligned channel header (mute/solo), windowed with the columns. -->
      <div class="phead" class:edit={playback.editing}>
        <span class="hgutter" style:width="{ROWNUM_W}px"></span>
        <div class="clip" style:width="{win.windowW}px" style:margin-left="{win.leftEdgeW}px">
          <div class="strip" style:width="{stripW}px" style:transform="translateX({shiftX}px)">
            {#each channels as _ch, i (i)}
              <span class="chead" class:muted={playback.channelMutes[i]} style:width="{CELL_W}px">
                <span class="chead-top">
                  <span class="chnum">{String(i + 1).padStart(2, "0")}</span>
                  <span class="ms-wrap">
                    <button
                      class="ms m"
                      class:on={playback.channelMutes[i]}
                      aria-pressed={playback.channelMutes[i]}
                      title="mute channel {i + 1}"
                      onclick={() => toggleChannelMute(i)}>M</button
                    >
                    <button
                      class="ms s"
                      class:on={isChannelSolo(i)}
                      aria-pressed={isChannelSolo(i)}
                      title="solo channel {i + 1}"
                      onclick={() => soloChannel(i)}>S</button
                    >
                  </span>
                </span>
                {#if playback.editing}<ChannelScope ch={i} h={14} />{/if}
              </span>
            {/each}
          </div>
        </div>
      </div>
    {/if}
    <div class="centerline" style:height="{ROW_H}px"></div>
    <div class="rows" style:transform="translateY({translateY}px)">
      {#each pattern.rows as cells, r (r)}
        <div
          class="prow"
          class:beat={r % 4 === 0}
          class:measure={r % 16 === 0}
          class:active={r === playback.row}
          class:playhead={playback.seqPlaying && r === playback.seqRow}
          data-r={r}
          style:height="{ROW_H}px"
        >
          <span class="rownum" style:width="{ROWNUM_W}px">{hex2(r)}</span>
          <div class="clip" style:width="{win.windowW}px" style:margin-left="{win.leftEdgeW}px">
            <div class="strip" style:width="{stripW}px" style:transform="translateX({shiftX}px)">
              {#each cells as cell, c (c)}{#if editCells}{@const ec = editCells[r]?.[c]}<span
                    class="cell ecell"
                    class:muted={playback.channelMutes[c]}
                    style:width="{CELL_W}px"
                    data-c={c}
                    >{#if ec}{#each FIELDS as f (f)}<span
                          class="fld"
                          class:cursor={r === playback.cursorRow &&
                            c === playback.cursorCh &&
                            f === playback.cursorField}
                          data-field={f}>{cellFieldText(ec, f)}</span
                        >{/each}{/if}</span
                  >{:else}<span
                    class="cell"
                    class:cursor={r === playback.cursorRow && c === playback.cursorCh}
                    class:muted={playback.channelMutes[c]}
                    style:width="{CELL_W}px"
                    data-c={c}>{cell}</span
                  >{/if}{/each}
            </div>
          </div>
        </div>
      {/each}
    </div>
    <!-- Per-channel VU bars rising from the centerline (ProTracker style), windowed. -->
    <div class="vu-overlay" style:left="{ROWNUM_W + win.leftEdgeW}px" style:width="{win.windowW}px">
      <div class="vu-strip" style:width="{stripW}px" style:transform="translateX({shiftX}px)">
        {#each channels as _ch, i (i)}
          <div
            class="vubar"
            style:left="{colXin(i)}px"
            style:width="{BAR_W}px"
            style:height="{Math.min(1, vu[i] ?? 0) * VU_MAX}px"
          ></div>
        {/each}
      </div>
    </div>
    <ChannelPager
      canLeft={win.canLeft}
      canRight={win.canRight}
      leftEdgeW={win.leftEdgeW}
      rightEdgeW={win.rightEdgeW}
      gutterW={ROWNUM_W}
      onPage={page}
    />
  </div>
{:else}
  <div class="pv-empty">{playback.current ? "decoding pattern…" : "nothing playing"}</div>
{/if}

<style>
  .pv {
    height: 100%;
    overflow: hidden;
    position: relative;
    background: var(--surface);
    color: var(--surface-fg);
    /* App sets --tracker-font (party: per-platform DOS/Amiga). Fall back to the
			   retro mono font both apps define, then a universal monospace — never an
			   undefined var (which would drop to the default serif/sans). */
    font-family: var(--tracker-font, var(--font-mono-retro, ui-monospace, monospace));
    font-size: 16px;
    line-height: 1;
    white-space: nowrap;
    /* Vertical is fixed (centerline); horizontal swipe pages channels (pageSwipe). */
    touch-action: none;
  }
  /* Clip/slide wrapper for one whole-channel window; the strip inside holds every
     channel and translates by whole columns (animated) so paging glides. */
  .clip {
    flex: 0 0 auto;
    overflow: hidden;
  }
  .strip {
    display: flex;
    transition: transform 0.18s ease;
  }
  /* The fixed current-row line. */
  .centerline {
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    transform: translateY(-50%);
    background: color-mix(in srgb, var(--accent) 22%, var(--surface-2));
    box-shadow:
      0 -1px 0 var(--surface-line-2),
      0 1px 0 var(--surface-line-2);
    z-index: 0;
  }
  .rows {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 1;
  }
  /* Column-aligned channel header (mute/solo), pinned to the top. */
  .phead {
    position: absolute;
    top: 0;
    left: 0;
    display: flex;
    height: 22px;
    z-index: 3;
  }
  .phead.edit {
    height: 40px; /* room for the per-channel scope under the number/mute row */
  }
  .hgutter {
    flex: 0 0 auto;
    background: var(--surface-bar);
    border-bottom: 1px solid var(--surface-line-2);
  }
  .chead {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    /* Horizontal padding matches .cell (8px) so the header lines up with the
       columns below; the 2px top/bottom keeps the header compact. */
    padding: 2px 8px;
    /* Carved column divider (matches the cells below). */
    border-left: 1px solid color-mix(in srgb, var(--surface-line) 70%, #000);
    box-shadow: inset 1px 0 0 color-mix(in srgb, var(--surface-line) 70%, #fff);
    border-bottom: 1px solid var(--surface-line-2);
    background: var(--surface-bar);
    color: var(--accent);
    font-size: 11px;
    line-height: 1;
  }
  .chead-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
  }
  .chead.muted {
    opacity: 0.55;
  }
  .ms-wrap {
    flex: 0 0 auto;
    display: flex;
    gap: 2px;
  }
  .ms {
    width: 18px;
    height: 15px;
    padding: 0;
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
    border: 1px solid var(--surface-line);
    border-radius: 2px;
    background: var(--surface);
    color: var(--surface-fg);
    cursor: pointer;
  }
  .ms:hover {
    color: var(--surface-fg-active);
  }
  .ms.m.on {
    background: color-mix(in srgb, #ff4136 70%, var(--surface));
    border-color: #ff4136;
    color: #fff;
  }
  .ms.s.on {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--bg);
  }
  .prow {
    display: flex;
    align-items: center;
  }
  /* Beat (every 4th row) + measure (every 16th) tints — the FT2/OpenMPT grid
     rhythm cue. Measure is stronger; both stay subtle so text keeps priority. */
  .prow.beat {
    color: var(--surface-fg-beat);
    background: color-mix(in srgb, var(--surface-fg) 6%, transparent);
  }
  .prow.measure {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .prow.active {
    color: var(--surface-fg-active);
  }
  /* Sequencer playhead — a bold, sweeping row bar, clearly distinct from the
     per-cell edit cursor box (so both are legible at once in edit mode). */
  .prow.playhead {
    background: color-mix(in srgb, var(--accent) 30%, transparent);
    box-shadow: inset 3px 0 0 var(--accent);
    color: var(--surface-fg-active);
  }
  .rownum {
    flex: 0 0 auto;
    text-align: right;
    padding: 0 6px;
    /* --surface-fg (muted), NOT --surface-fg-dim: the dim token is halo's lightest
       text and is near-invisible on the light theme. This stays legible on both. */
    color: var(--surface-fg);
    background: var(--surface);
    z-index: 2;
  }
  .cell {
    flex: 0 0 auto;
    padding: 0 8px;
    /* Carved column divider (FT2 feel): a dark rule + a light inset highlight to
       its right = a subtle recessed groove between channels, theme-relative. */
    border-left: 1px solid color-mix(in srgb, var(--surface-line) 70%, #000);
    box-shadow: inset 1px 0 0 color-mix(in srgb, var(--surface-line) 70%, #fff);
    overflow: hidden;
  }
  /* Muted channel — dim the whole column so it reads as silenced. */
  .cell.muted {
    opacity: 0.34;
  }
  /* Edit mode: per-field spans so the cursor can target note/inst/vol/fx/param. */
  .ecell {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .fld {
    padding: 0 1px;
  }
  .fld.cursor {
    box-shadow: inset 0 0 0 1px var(--accent);
    background: color-mix(in srgb, var(--accent) 22%, transparent);
  }
  /* Edit cursor — outlined cell (inset so it reads inside the column border). */
  .cell.cursor {
    box-shadow: inset 0 0 0 1px var(--accent);
    background: color-mix(in srgb, var(--accent) 18%, transparent);
  }
  .pv:focus-visible {
    outline: 1px solid color-mix(in srgb, var(--accent) 60%, transparent);
    outline-offset: -1px;
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
  .vubar {
    position: absolute;
    bottom: 50%;
    background: linear-gradient(to top, #2ecc40, #ffdc00 55%, #ff4136);
    background-size: 100% 108px;
    background-position: bottom;
    transition: height 0.05s linear;
  }
  .pv-empty {
    display: grid;
    place-items: center;
    height: 100%;
    color: var(--muted);
  }
</style>
