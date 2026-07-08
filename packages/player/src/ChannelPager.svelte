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
        <button class="chev" aria-label="previous channels" onclick={() => onPage(-1)}>‹</button>
      {/if}
      {#if canRight}
        <button class="chev" aria-label="next channels" onclick={() => onPage(1)}>›</button>
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
    gap: 2px;
  }
  .chev {
    width: 20px;
    height: 52px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 22px;
    line-height: 1;
    color: var(--surface-fg-active);
    background: color-mix(in srgb, var(--surface-bar) 70%, transparent);
    border: 1px solid var(--surface-line);
    border-radius: 5px;
    cursor: pointer;
  }
  .chev:hover {
    background: var(--surface-bar);
    border-color: var(--accent);
  }
</style>
