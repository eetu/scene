<script lang="ts">
  // Alternate pattern view: free-scrolling rows (current row auto-centred) with
  // per-channel VU bars in the sticky channel header. Toggle against the locked
  // centerline view (PatternView.svelte) in the player bar.
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
  } from "@scene/player";

  const FIELDS = [0, 1, 2, 3, 4]; // note, inst, vol, fx, param

  let scroller = $state<HTMLDivElement | null>(null);

  // Cursor nav — mirrors PatternView (stops handled keys from reaching the
  // app's global arrows; unhandled keys still bubble).
  function onGridKey(e: KeyboardEvent) {
    // Edit mode: note/hex/field-nav entry (consumes the key if handled).
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
      setCursor(r, c); // place cursor, don't seek while editing
      if (fldEl) playback.cursorField = Number(fldEl.getAttribute("data-field"));
    } else {
      setCursor(r, c, true);
    }
  }

  const pattern = $derived(playback.song?.patterns?.[playback.pattern] ?? null);
  const editCells = $derived(playback.editing ? patternCells(playback.pattern) : null);
  const channels = $derived(playback.song?.channels ?? []);
  const vu = $derived(playback.vu);

  function hex2(n: number): string {
    return n.toString(16).toUpperCase().padStart(2, "0");
  }

  // Keep the playing row centred as it advances. Direct scrollTop (not smooth)
  // so it tracks fast tempos without lagging behind.
  $effect(() => {
    const r = playback.row;
    const el = scroller;
    if (!el) return;
    const rows = el.querySelectorAll<HTMLElement>(".prow");
    const target = rows[r];
    if (target) el.scrollTop = target.offsetTop - el.clientHeight / 2 + target.offsetHeight / 2;
  });
</script>

{#if pattern}
  <div
    class="pv"
    role="grid"
    tabindex="0"
    bind:this={scroller}
    onkeydown={onGridKey}
    onclick={onGridClick}
  >
    <div class="phead">
      <span class="rownum">··</span>
      {#each channels as ch, i (i)}
        <span class="cell head" class:muted={playback.channelMutes[i]}>
          <span class="hrow">
            <span class="chname">{ch || `ch ${i + 1}`}</span>
            {#if playback.canMuteChannels}
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
            {/if}
          </span>
          <span class="vu"><span class="vu-fill" style:width="{(vu[i] ?? 0) * 100}%"></span></span>
        </span>
      {/each}
    </div>
    {#each pattern.rows as cells, r (r)}
      <div
        class="prow"
        class:active={r === playback.row}
        class:beat={r % 4 === 0}
        class:measure={r % 16 === 0}
        data-r={r}
      >
        <span class="rownum">{hex2(r)}</span>
        {#each cells as cell, c (c)}
          {#if editCells}
            {@const ec = editCells[r]?.[c]}
            <span class="cell ecell" class:muted={playback.channelMutes[c]} data-c={c}>
              {#if ec}
                {#each FIELDS as f (f)}
                  <span
                    class="fld"
                    class:cursor={r === playback.cursorRow &&
                      c === playback.cursorCh &&
                      f === playback.cursorField}
                    data-field={f}>{cellFieldText(ec, f)}</span
                  >
                {/each}
              {/if}
            </span>
          {:else}
            <span
              class="cell"
              class:cursor={r === playback.cursorRow && c === playback.cursorCh}
              class:muted={playback.channelMutes[c]}
              data-c={c}>{cell}</span
            >
          {/if}
        {/each}
      </div>
    {/each}
  </div>
{:else}
  <div class="pv-empty">{playback.current ? "decoding pattern…" : "nothing playing"}</div>
{/if}

<style>
  .pv {
    height: 100%;
    overflow: auto;
    background: var(--surface);
    color: var(--surface-fg);
    font-family: var(--font-mono-retro);
    font-size: 16px;
    line-height: 1.2;
    white-space: nowrap;
    -webkit-overflow-scrolling: touch;
    /* Swipe between whole channel columns (x only — rows still scroll
		   freely on y); snap flush past the frozen row-number gutter. */
    scroll-snap-type: x mandatory;
    scroll-padding-left: 30px; /* = row-number gutter */
    scrollbar-width: none;
  }
  .pv::-webkit-scrollbar {
    display: none;
  }
  .phead {
    position: sticky;
    top: 0;
    display: flex;
    background: var(--surface-bar);
    color: var(--accent);
    border-bottom: 1px solid var(--surface-line-2);
    z-index: 1;
  }
  .prow {
    display: flex;
    align-items: center;
  }
  .prow.beat {
    background: var(--surface-2);
  }
  /* Measure line (every 16th row) — a stronger cue than the beat rows. */
  .prow.measure {
    background: color-mix(in srgb, var(--accent) 12%, var(--surface-2));
  }
  .prow.active {
    background: color-mix(in srgb, var(--accent) 28%, var(--surface-2));
    color: var(--surface-fg-active);
  }
  .rownum {
    flex: 0 0 auto;
    width: 30px;
    text-align: right;
    padding: 0 6px;
    color: var(--surface-fg-dim);
    position: sticky;
    left: 0;
    z-index: 2;
    background: inherit;
  }
  .cell {
    flex: 0 0 auto;
    min-width: 112px;
    padding: 0 8px;
    border-left: 1px solid var(--surface-line);
    letter-spacing: 0.02em;
    scroll-snap-align: start;
  }
  .cell.cursor {
    box-shadow: inset 0 0 0 1px var(--accent);
    background: color-mix(in srgb, var(--accent) 18%, transparent);
  }
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
  .pv:focus-visible {
    outline: 1px solid color-mix(in srgb, var(--accent) 60%, transparent);
    outline-offset: -1px;
  }
  .cell.head {
    display: flex;
    flex-direction: column;
    gap: 2px;
    justify-content: center;
    overflow: hidden;
  }
  .cell.head.muted .chname {
    opacity: 0.5;
  }
  .hrow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
  }
  .chname {
    overflow: hidden;
    text-overflow: ellipsis;
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
  .vu {
    height: 4px;
    background: var(--surface-line);
    overflow: hidden;
  }
  .vu-fill {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.08s linear;
  }
  .pv-empty {
    display: grid;
    place-items: center;
    height: 100%;
    color: var(--muted);
  }
</style>
