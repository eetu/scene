<script lang="ts">
  // Overlay for the windowed pattern grid: the thick edge divider that fills the
  // slack past the last whole channel, plus floating ‹ › chevrons that page the
  // channel window (auto-shown only when there are hidden channels that way).
  // Absolutely positioned over the grid; the grid keeps rendering the columns.
  let {
    canLeft,
    canRight,
    slack,
    gutterW,
    onPage,
  }: {
    canLeft: boolean;
    canRight: boolean;
    slack: number;
    gutterW: number;
    onPage: (dir: 1 | -1) => void;
  } = $props();
</script>

{#if slack > 0}
  <!-- Fills the leftover width past the last whole column (the "no partial
       channel" gap) — reads as the end of the channel strip. -->
  <div class="edge" style:width="{slack}px"></div>
{/if}
{#if canLeft}
  <button
    class="chev left"
    style:left="{gutterW + 2}px"
    aria-label="previous channels"
    onclick={() => onPage(-1)}>‹</button
  >
{/if}
{#if canRight}
  <button
    class="chev right"
    style:right="{slack + 4}px"
    aria-label="next channels"
    onclick={() => onPage(1)}>›</button
  >
{/if}

<style>
  .edge {
    position: absolute;
    top: 0;
    right: 0;
    height: 100%;
    z-index: 4;
    pointer-events: none;
    /* Soft "end of channels": a surface-line rule + faint fill, with only a thin
       accent hint at the seam — not a loud bar. */
    background: color-mix(in srgb, var(--surface-bar) 55%, transparent);
    border-left: 2px solid var(--surface-line);
    box-shadow: inset 2px 0 0 color-mix(in srgb, var(--accent) 22%, transparent);
  }
  .chev {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    width: 26px;
    height: 54px;
    z-index: 5;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 22px;
    line-height: 1;
    color: var(--surface-fg-active);
    background: color-mix(in srgb, var(--surface-bar) 82%, transparent);
    border: 1px solid var(--surface-line);
    border-radius: 5px;
    cursor: pointer;
    /* Sit above the fixed transport, comfortable tap target on touch. */
    backdrop-filter: blur(2px);
  }
  .chev:hover {
    background: var(--surface-bar);
    border-color: var(--accent);
  }
</style>
