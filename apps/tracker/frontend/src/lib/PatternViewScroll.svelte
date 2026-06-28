<script lang="ts">
  // Alternate pattern view: free-scrolling rows (current row auto-centred) with
  // per-channel VU bars in the sticky channel header. Toggle against the locked
  // centerline view (PatternView.svelte) in the player bar.
  import { playback } from "@scene/player";

  let scroller = $state<HTMLDivElement | null>(null);

  const pattern = $derived(playback.song?.patterns?.[playback.pattern] ?? null);
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
  <div class="pv" bind:this={scroller}>
    <div class="phead">
      <span class="rownum">··</span>
      {#each channels as ch, i (i)}
        <span class="cell head">
          <span class="chname">{ch || `ch ${i + 1}`}</span>
          <span class="vu"><span class="vu-fill" style:width="{(vu[i] ?? 0) * 100}%"></span></span>
        </span>
      {/each}
    </div>
    {#each pattern.rows as cells, r (r)}
      <div class="prow" class:active={r === playback.row} class:beat={r % 4 === 0}>
        <span class="rownum">{hex2(r)}</span>
        {#each cells as cell, c (c)}
          <span class="cell">{cell}</span>
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
  .cell.head {
    display: flex;
    flex-direction: column;
    gap: 2px;
    justify-content: center;
    overflow: hidden;
  }
  .chname {
    overflow: hidden;
    text-overflow: ellipsis;
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
