<script lang="ts">
  // A-Z quick-jump rail down the side of the library list: click a letter or drag
  // along it (a scrubber, handy on touch) to jump to the first group under that
  // letter. Owns its own drag state; the parent supplies the letter→row-index map
  // (items) and scrolls the virtualized list via onJump.
  let {
    items,
    onJump,
  }: {
    items: { letter: string; index: number | null }[];
    onJump: (index: number) => void;
  } = $props();

  let railEl = $state<HTMLElement>();
  let active = $state<string | null>(null);

  // Snap a rail position to the nearest letter that has a group, so dragging over
  // an empty letter still lands somewhere sensible instead of doing nothing.
  function railJump(target: number) {
    for (let d = 0; d < items.length; d++) {
      const a = items[target - d];
      const b = items[target + d];
      if (a?.index != null) return ((active = a.letter), onJump(a.index));
      if (b?.index != null) return ((active = b.letter), onJump(b.index));
    }
  }
  function indexAtY(clientY: number): number {
    if (!railEl) return 0;
    const r = railEl.getBoundingClientRect();
    const rel = (clientY - r.top) / r.height;
    return Math.max(0, Math.min(items.length - 1, Math.floor(rel * items.length)));
  }
  function down(e: PointerEvent) {
    railEl?.setPointerCapture(e.pointerId);
    railJump(indexAtY(e.clientY));
  }
  function move(e: PointerEvent) {
    if (railEl?.hasPointerCapture(e.pointerId)) railJump(indexAtY(e.clientY));
  }
  function up(e: PointerEvent) {
    railEl?.releasePointerCapture(e.pointerId);
    active = null;
  }
</script>

<div
  class="az-rail"
  bind:this={railEl}
  role="navigation"
  aria-label="jump to letter"
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
>
  {#each items as it (it.letter)}
    <button
      class="az-letter"
      class:present={it.index != null}
      class:active={active === it.letter}
      disabled={it.index == null}
      tabindex="-1"
      onclick={() => it.index != null && onJump(it.index)}>{it.letter}</button
    >
  {/each}
</div>

<style>
  .az-rail {
    position: absolute;
    right: 2px;
    top: 50%;
    transform: translateY(-50%);
    max-height: calc(100% - 88px);
    display: flex;
    flex-direction: column;
    align-items: stretch;
    z-index: 4;
    padding: 2px 1px;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
  }
  .az-letter {
    appearance: none;
    border: 0;
    background: none;
    margin: 0;
    padding: 0;
    width: 18px;
    height: 14px;
    line-height: 14px;
    font-size: 10px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    text-align: center;
    color: var(--muted);
    opacity: 0.3;
    cursor: pointer;
  }
  .az-letter.present {
    opacity: 0.8;
  }
  .az-letter.present:hover,
  .az-letter.active {
    opacity: 1;
    color: var(--accent);
  }
  .az-letter:disabled {
    cursor: default;
  }
</style>
