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
    /* Recessed frame matching the carved column dividers (FT2 feel): a dark rule
       + light highlight facing the channels, and a darker inner shadow on the
       outer side — so the edge reads as the pattern's carved outer frame. */
    background: var(--surface-2);
  }
  .edge.left {
    border-right: 1px solid color-mix(in srgb, var(--surface-line) 70%, #000);
    box-shadow:
      inset -1px 0 0 color-mix(in srgb, var(--surface-line) 70%, #fff),
      inset 2px 0 0 color-mix(in srgb, var(--surface) 60%, #000);
  }
  .edge.right {
    right: 0;
    border-left: 1px solid color-mix(in srgb, var(--surface-line) 70%, #000);
    box-shadow:
      inset 1px 0 0 color-mix(in srgb, var(--surface-line) 70%, #fff),
      inset -2px 0 0 color-mix(in srgb, var(--surface) 60%, #000);
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
