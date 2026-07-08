<script lang="ts">
  // The thick edge divider that fills the slack past the last whole channel, with
  // the ‹ › paging chevrons living INSIDE it (so they never overlap the grid
  // cells). Auto-shown per direction; the whole thing only exists when channels
  // overflow (slack > 0). Absolutely positioned over the right of the grid.
  let {
    canLeft,
    canRight,
    slack,
    onPage,
  }: {
    canLeft: boolean;
    canRight: boolean;
    slack: number;
    onPage: (dir: 1 | -1) => void;
  } = $props();
</script>

{#if slack > 0}
  <div class="edge" style:width="{slack}px">
    <div class="pager">
      {#if canLeft}
        <button class="chev" aria-label="previous channels" onclick={() => onPage(-1)}
          ><span>‹</span></button
        >
      {/if}
      {#if canRight}
        <button class="chev" aria-label="next channels" onclick={() => onPage(1)}
          ><span>›</span></button
        >
      {/if}
    </div>
  </div>
{/if}

<style>
  .edge {
    position: absolute;
    top: 0;
    right: 0;
    height: 100%;
    z-index: 4;
    display: flex;
    align-items: center;
    justify-content: center;
    /* Soft "end of channels": a surface-line rule + faint fill, with only a thin
       accent hint at the seam — not a loud bar. */
    background: color-mix(in srgb, var(--surface-bar) 55%, transparent);
    border-left: 2px solid var(--surface-line);
    box-shadow: inset 2px 0 0 color-mix(in srgb, var(--accent) 22%, transparent);
  }
  .pager {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0;
  }
  /* Borderless, tall, embedded in the divider — no button box, just the glyph. */
  .chev {
    width: 24px;
    height: 40vh;
    max-height: 220px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    background: none;
    color: var(--surface-fg);
    cursor: pointer;
  }
  /* Stretch the chevron glyph vertically so it reads as a tall nav arrow. */
  .chev span {
    display: block;
    font-size: 22px;
    line-height: 1;
    transform: scaleY(2.4);
  }
  .chev:hover {
    color: var(--accent);
  }
</style>
