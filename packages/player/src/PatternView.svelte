<script lang="ts">
  // The module pattern grid: rows of tracker cells, one column per channel.
  //
  // The frame it sits in — the centerline the pattern slides under, whole-channel
  // paging, the VU bars rising off that line — is TrackGrid, shared with the
  // SID trace. This file is now just what a *module* row is: pattern cells, the
  // edit cursor, and per-channel mute/solo.
  import { untrack } from "svelte";

  import ChannelScope from "./ChannelScope.svelte";
  import { hex2 } from "./format";
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
  import TrackGrid from "./TrackGrid.svelte";

  const FIELDS = [0, 1, 2, 3, 4]; // note, inst, vol, fx, param

  // Topaz is 8×16, so the row height is fixed rather than derived.
  const ROW_H = 18;

  let grid = $state<ReturnType<typeof TrackGrid> | null>(null);

  // Focus the grid when entering edit mode so QWERTY note entry works at once.
  $effect(() => {
    if (playback.editing) untrack(() => grid?.focus());
  });

  const pattern = $derived(playback.song?.patterns?.[playback.pattern] ?? null);
  const editCells = $derived(playback.editing ? patternCells(playback.pattern) : null);
  const channels = $derived(playback.song?.channels ?? []);

  // In edit mode the centerline follows the EDIT CURSOR (so entered notes stay
  // in view); otherwise it follows the playing row.
  const centerRow = $derived(playback.editing ? playback.cursorRow : playback.row);

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
  <TrackGrid
    bind:this={grid}
    columns={channels.length}
    rows={pattern.rows.length}
    rowH={ROW_H}
    {centerRow}
    vu={playback.vu}
    headH={playback.canMuteChannels ? (playback.editing ? 40 : 22) : 0}
    interactive
    followColumn={playback.editing ? playback.cursorCh : undefined}
    onkeydown={onGridKey}
    onclick={onGridClick}
    rowClass={(r) =>
      [
        r === playback.row ? "active" : "",
        playback.seqPlaying && r === playback.seqRow ? "playhead" : "",
        r % 4 === 0 ? "beat" : "",
        r % 16 === 0 ? "measure" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    stripClass={(r) => (r % 16 === 0 ? "measure" : r % 4 === 0 ? "beat" : "")}
    rowLabel={rowNumber}
    headCell={channelHead}
    cell={patternCell}
  />
{:else}
  <div class="pv-empty">{playback.current ? "decoding pattern…" : "nothing playing"}</div>
{/if}

{#snippet rowNumber(r: number)}{hex2(r)}{/snippet}

{#snippet channelHead(i: number)}
  <span class="chead" class:muted={playback.channelMutes[i]}>
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
{/snippet}

{#snippet patternCell(r: number, c: number, w: number)}
  {#if editCells}
    {@const ec = editCells[r]?.[c]}
    <span class="cell ecell" class:muted={playback.channelMutes[c]} style:width="{w}px" data-c={c}>
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
      style:width="{w}px"
      data-c={c}>{pattern?.rows[r]?.[c] ?? ""}</span
    >
  {/if}
{/snippet}

<style>
  .chead {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    color: var(--accent);
    font-size: 11px;
    line-height: 1;
  }
  /* Group the channel number + M/S together (left-aligned) rather than stranding
     them at opposite ends of a wide column. */
  .chead-top {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 8px;
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

  .cell {
    flex: 0 0 auto;
    /* The frame hands out an exact column width; padding comes out of it. */
    box-sizing: border-box;
    padding: 0 8px;
    /* Single-line column divider (no dark bevel) — a clean --surface-line rule. */
    border-left: 1px solid var(--surface-line);
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

  .pv-empty {
    display: grid;
    place-items: center;
    height: 100%;
    color: var(--muted);
  }
</style>
