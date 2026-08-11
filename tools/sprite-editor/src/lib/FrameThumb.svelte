<script lang="ts">
  // One frame's thumbnail.
  //
  // Its own component so the paint is an $effect over the rows it draws: as an
  // action on the parent's canvas it only re-ran when the *index* changed, so
  // opening a different sprite left every thumbnail showing the previous one's
  // art — with the previous one's colours.
  import { cellColour, type SpriteFile } from "@scene/player/sprite-file";

  import { editor } from "./editor.svelte";

  let { sprite, index }: { sprite: SpriteFile; index: number } = $props();

  let canvas: HTMLCanvasElement | null = $state(null);

  $effect(() => {
    const el = canvas;
    const rows = sprite.frames[index];
    if (!el || !rows) return;
    el.width = sprite.w;
    el.height = sprite.h;
    const g = el.getContext("2d");
    if (!g) return;
    const tint = editor.tint;
    g.clearRect(0, 0, el.width, el.height);
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y];
      for (let x = 0; x < row.length; x++) {
        const colour = cellColour(sprite, row[x], tint);
        if (!colour) continue;
        g.fillStyle = colour;
        g.fillRect(x, y, 1, 1);
      }
    }
  });
</script>

<canvas bind:this={canvas} style:aspect-ratio={`${sprite.w} / ${sprite.h}`}></canvas>

<style>
  canvas {
    display: block;
    width: 100%;
    image-rendering: pixelated;
    /* Wide sprites (72×18) and tall ones (5×26) share a strip, so the box is
       fixed and the art letterboxes inside it rather than the row jumping. */
    max-height: 3rem;
    object-fit: contain;
  }
</style>
