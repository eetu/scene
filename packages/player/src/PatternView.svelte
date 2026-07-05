<script lang="ts">
  import { moveCursor, playback, seekToCursor, setCursor } from "./player.svelte";

  // Fixed-metrics tracker layout (px). Topaz is 8×16, so 8px/char.
  const ROW_H = 18;
  const ROWNUM_W = 30;
  const CELL_W = 130;
  const BAR_W = 10;
  const VU_MAX = ROW_H * 6; // tallest VU bar

  let vpH = $state(0); // viewport height, for centering the current row

  const pattern = $derived(playback.song?.patterns?.[playback.pattern] ?? null);
  const channels = $derived(playback.song?.channels ?? []);
  const vu = $derived(playback.vu);
  const contentW = $derived(ROWNUM_W + channels.length * CELL_W);

  // Translate the rows so the current row sits on the fixed centerline; the
  // pattern moves under the line "like a stick in the river".
  const translateY = $derived(vpH / 2 - (playback.row + 0.5) * ROW_H);

  function hex2(n: number): string {
    return n.toString(16).toUpperCase().padStart(2, "0");
  }
  function colX(i: number): number {
    return ROWNUM_W + i * CELL_W + (CELL_W - BAR_W) / 2;
  }

  // Cursor nav — only while the grid is focused. stopPropagation on handled keys
  // so the app's global arrows (track switch) don't also fire; unhandled keys
  // (e.g. space = play/pause) still bubble through.
  function onGridKey(e: KeyboardEvent) {
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
    if (rowEl && cellEl) {
      setCursor(Number(rowEl.getAttribute("data-r")), Number(cellEl.getAttribute("data-c")), true);
    }
  }
</script>

{#if pattern}
  <div
    class="pv"
    role="grid"
    tabindex="0"
    bind:clientHeight={vpH}
    onkeydown={onGridKey}
    onclick={onGridClick}
  >
    <div class="content" style:width="{contentW}px">
      <div class="centerline" style:height="{ROW_H}px"></div>
      <div class="rows" style:transform="translateY({translateY}px)">
        {#each pattern.rows as cells, r (r)}
          <div
            class="prow"
            class:beat={r % 4 === 0}
            class:measure={r % 16 === 0}
            class:active={r === playback.row}
            data-r={r}
            style:height="{ROW_H}px"
          >
            <span class="rownum">{hex2(r)}</span>
            {#each cells as cell, c (c)}<span
                class="cell"
                class:cursor={r === playback.cursorRow && c === playback.cursorCh}
                data-c={c}>{cell}</span
              >{/each}
          </div>
        {/each}
      </div>
      <!-- Per-channel VU bars rising from the centerline (ProTracker style). -->
      <div class="vu-overlay">
        {#each channels as _ch, i (i)}
          <div
            class="vubar"
            style:left="{colX(i)}px"
            style:width="{BAR_W}px"
            style:height="{Math.min(1, vu[i] ?? 0) * VU_MAX}px"
          ></div>
        {/each}
      </div>
    </div>
  </div>
{:else}
  <div class="pv-empty">{playback.current ? "decoding pattern…" : "nothing playing"}</div>
{/if}

<style>
  .pv {
    height: 100%;
    overflow-x: auto;
    overflow-y: hidden;
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
    -webkit-overflow-scrolling: touch;
    /* Swipe between whole channel columns: snap each column flush past the
		   frozen row-number gutter, so a column is never half-cut. */
    scroll-snap-type: x mandatory;
    scroll-padding-left: 30px; /* = ROWNUM_W (frozen gutter) */
    scrollbar-width: none; /* Firefox — no scrollbar, swipe only */
  }
  .pv::-webkit-scrollbar {
    display: none;
  } /* WebKit/Blink */
  .content {
    position: relative;
    height: 100%;
    min-width: 100%;
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
    z-index: 1;
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
  .rownum {
    flex: 0 0 auto;
    width: 30px;
    text-align: right;
    padding: 0 6px;
    color: var(--surface-fg-dim);
    /* Frozen left gutter so row numbers stay put while channels scroll. */
    position: sticky;
    left: 0;
    z-index: 2;
    background: var(--surface);
  }
  .cell {
    flex: 0 0 auto;
    width: 130px;
    padding: 0 8px;
    border-left: 1px solid var(--surface-line);
    overflow: hidden;
    scroll-snap-align: start;
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
    inset: 0;
    z-index: 2;
    pointer-events: none;
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
