<script lang="ts">
  // Static edge dividers that frame the windowed channels on both sides, each
  // with its ‹ / › paging chevron embedded (shown only when there are hidden
  // channels that way). Borderless, tall chevrons so they read as part of the
  // divider, never overlapping the grid cells. Only present when paging (edge
  // widths > 0). Absolutely positioned over the grid.
  let {
    canLeft,
    canRight,
    leftEdgeW,
    rightEdgeW,
    onPage,
  }: {
    canLeft: boolean;
    canRight: boolean;
    leftEdgeW: number;
    rightEdgeW: number;
    onPage: (dir: 1 | -1) => void;
  } = $props();
</script>

{#if leftEdgeW > 0}
  <div class="edge left" style:left="0px" style:width="{leftEdgeW}px">
    {#if canLeft}
      <button class="chev" aria-label="previous channels" onclick={() => onPage(-1)}
        ><span>‹</span></button
      >
    {/if}
  </div>
{/if}
{#if rightEdgeW > 0}
  <div class="edge right" style:width="{rightEdgeW}px">
    {#if canRight}
      <button class="chev" aria-label="next channels" onclick={() => onPage(1)}
        ><span>›</span></button
      >
    {/if}
  </div>
{/if}

<style>
  .edge {
    position: absolute;
    top: 0;
    height: 100%;
    z-index: 4;
    display: flex;
    align-items: center;
    justify-content: center;
    /* A single-line divider on the channel-facing side only (matches the column
       dividers); no border on the OUTER side, so the edge blends into the frame. */
    background: var(--surface-2);
  }
  .edge.left {
    border-right: 1px solid var(--surface-line);
  }
  .edge.right {
    right: 0;
    border-left: 1px solid var(--surface-line);
  }
  /* Borderless, tall, embedded — no button box, just the glyph. */
  .chev {
    width: 20px;
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
