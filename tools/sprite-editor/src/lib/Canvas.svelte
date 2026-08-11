<script lang="ts">
  // The drawing surface: one canvas, nearest-neighbour, plus a live preview of
  // the shape being dragged so a rectangle can be placed before it is painted.
  //
  // Drawn rather than laid out as DOM cells. A 72×18 sprite is 1296 cells and a
  // div per cell is survivable, but the sprites this tool exists for are the
  // ones that grow, and a canvas costs the same at any size.
  //
  // The gesture vocabulary is nib's, because these are the same hands: pinch to
  // zoom, two-finger scroll to pan, ⌘/ctrl-wheel to zoom at the cursor, space or
  // middle-drag to pan, and a plain drag paints. Two fingers down means the
  // gesture belongs to the viewport, so a pinch never leaves a stray pixel.
  import { cellColour, shapePoints, TRANSPARENT } from "@scene/player/sprite-file";

  import {
    editor,
    fillAt,
    hasSelection,
    isSelected,
    nudgeSelection,
    paint,
    pickAt,
    selectBox,
    selection,
    selectShapeAt,
    strokePoints,
  } from "./editor.svelte";
  import { type Backdrop, cell, fit, panBy, viewport, zoomBy } from "./viewport.svelte";

  let { backdrop = "checker" as Backdrop }: { backdrop?: Backdrop } = $props();

  let pane: HTMLDivElement | null = $state(null);
  let canvas: HTMLCanvasElement | null = $state(null);
  let drag: { x: number; y: number } | null = $state(null);
  let hover: { x: number; y: number } | null = $state(null);
  let shift = $state(false);
  let space = $state(false);
  let panning = $state(false);
  /** The box being dragged out by the select tool, before it becomes a selection. */
  let marquee: { from: { x: number; y: number }; to: { x: number; y: number } } | null =
    $state(null);
  /** A drag that is carrying the selection. `last` is where the block was when
   *  the pointer last crossed a cell boundary, so travel is whole cells only. */
  let moving: { last: { x: number; y: number } } | null = $state(null);
  let flashOn = $state(false);

  // A fresh selection flashes: on a dense sprite a one-pixel dashed outline is
  // easy to miss, and "did that click select what I meant?" is the question the
  // tool has to answer instantly.
  $effect(() => {
    if (!selection.flash) return;
    flashOn = true;
    const t = setTimeout(() => (flashOn = false), 180);
    return () => clearTimeout(t);
  });

  const sprite = $derived(editor.sprite);
  const px = $derived(cell());

  // Live pointers, so two fingers can be told from one. Screen coordinates,
  // relative to the pane.
  let pointers: { id: number; x: number; y: number }[] = [];
  let pinch: { dist: number; mx: number; my: number } | null = null;

  const at = (e: PointerEvent | WheelEvent | { clientX: number; clientY: number }) => {
    const r = pane?.getBoundingClientRect();
    return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: 0, y: 0 };
  };

  function setPointer(id: number, p: { x: number; y: number }) {
    const found = pointers.find((q) => q.id === id);
    if (found) {
      found.x = p.x;
      found.y = p.y;
    } else pointers.push({ id, ...p });
  }

  function pinchState() {
    const [a, b] = pointers;
    return {
      dist: Math.hypot(b.x - a.x, b.y - a.y),
      mx: (a.x + b.x) / 2,
      my: (a.y + b.y) / 2,
    };
  }

  /** Pointer position in sprite pixels. Floor, not round: the pixel under the
   *  cursor is the one you are pointing at, not the nearest boundary. */
  function cellAt(e: PointerEvent): { x: number; y: number } | null {
    const el = canvas;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * sprite.w);
    const y = Math.floor(((e.clientY - r.top) / r.height) * sprite.h);
    return x >= 0 && y >= 0 && x < sprite.w && y < sprite.h ? { x, y } : null;
  }

  const isShape = (t: string) => t === "line" || t === "rect" || t === "ellipse";

  function down(e: PointerEvent) {
    setPointer(e.pointerId, at(e));
    // A second finger takes the gesture away from the tools: abort whatever the
    // first one was drawing rather than finishing it under a pinch.
    if (pointers.length >= 2) {
      drag = null;
      if (pointers.length === 2) pinch = pinchState();
      return;
    }
    // Capture so a stroke that leaves the canvas still ends on this element.
    // Guarded: a pointer id the browser doesn't know — a synthetic event from a
    // test, or a device that has already released — throws here, and an
    // exception at the top of the handler swallows the whole stroke.
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* not a live pointer; the stroke still works, it just isn't captured */
    }
    if (space || e.button === 1) {
      panning = true;
      return;
    }
    if (e.button !== 0) return;
    const p = cellAt(e);
    if (!p) return;
    shift = e.shiftKey;
    if (editor.tool === "picker") return pickAt(p.x, p.y);
    if (editor.tool === "fill") return fillAt(p.x, p.y);
    if (editor.tool === "select") {
      // Inside an existing selection the drag carries it; anywhere else it
      // starts a new box. Same button, and where you press says which you meant.
      if (hasSelection() && isSelected(p.x, p.y)) moving = { last: p };
      else marquee = { from: p, to: p };
      return;
    }
    drag = p;
    if (!isShape(editor.tool)) paint([[p.x, p.y]], true);
  }

  function move(e: PointerEvent) {
    if (pointers.some((q) => q.id === e.pointerId)) setPointer(e.pointerId, at(e));
    if (pinch && pointers.length >= 2) {
      const next = pinchState();
      if (pinch.dist > 0) zoomBy(next.dist / pinch.dist, { x: next.mx, y: next.my });
      panBy(next.mx - pinch.mx, next.my - pinch.my);
      pinch = next;
      return;
    }
    if (panning) {
      panBy(e.movementX, e.movementY);
      return;
    }
    const p = cellAt(e);
    hover = p;
    shift = e.shiftKey;
    if (moving && p) {
      nudgeSelection(p.x - moving.last.x, p.y - moving.last.y);
      moving.last = p;
      return;
    }
    if (marquee && p) {
      marquee = { from: marquee.from, to: p };
      return;
    }
    if (!drag || !p) return;
    if (isShape(editor.tool)) return; // preview only until release
    // Join to the previous cell: a fast drag skips pixels otherwise, and a
    // dotted line is the classic tell of a per-event paint.
    paint(strokePoints("line", drag, p, false), false);
    drag = p;
  }

  function up(e: PointerEvent) {
    pointers = pointers.filter((q) => q.id !== e.pointerId);
    if (pointers.length < 2) pinch = null;
    panning = false;
    const p = cellAt(e) ?? hover;
    if (moving) {
      moving = null;
      return;
    }
    if (marquee) {
      const end = p ?? marquee.to;
      // A press that never left its cell is a click, and a click picks the shape
      // under it. Anything with travel in it is the box it drew.
      if (end.x === marquee.from.x && end.y === marquee.from.y) selectShapeAt(end.x, end.y);
      else selectBox(marquee.from, end, e.altKey);
      marquee = null;
      return;
    }
    if (drag && p && isShape(editor.tool)) paint(strokePoints(editor.tool, drag, p, shift), true);
    drag = null;
  }

  /** A cancelled pointer (an OS gesture taking over, a lost capture) must not
   *  commit, and must not leave a stale finger wedging a phantom pinch. */
  function cancel(e: PointerEvent) {
    pointers = pointers.filter((q) => q.id !== e.pointerId);
    if (pointers.length < 2) pinch = null;
    panning = false;
    drag = null;
    marquee = null;
    moving = null;
  }

  // Chromium and Firefox deliver a trackpad pinch as ctrl+wheel; ⌘/ctrl+wheel is
  // the mouse zoom. A plain wheel — including a two-finger scroll — pans.
  const WHEEL_ZOOM_SENS = 0.01;
  function wheel(e: WheelEvent) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Clamp so one big mouse notch can't jump the whole zoom range.
      const dz = Math.max(-50, Math.min(50, e.deltaY));
      zoomBy(Math.exp(-dz * WHEEL_ZOOM_SENS), at(e));
    } else {
      panBy(-e.deltaX, -e.deltaY);
    }
  }

  // Safari sends a trackpad pinch as WebKit gesture events rather than a
  // ctrl+wheel. `scale` is cumulative since gesturestart, so zoom by the step
  // ratio. Bound through Svelte's event system so the viewport change is
  // flushed to the DOM with the gesture.
  const PINCH_GAIN = 1.6;
  type GestureLike = Event & { scale: number; clientX: number; clientY: number };
  let gestureLast = 1;
  const gestures = {
    ongesturestart: (e: Event) => {
      e.preventDefault();
      gestureLast = (e as GestureLike).scale || 1;
    },
    ongesturechange: (e: Event) => {
      e.preventDefault();
      const g = e as GestureLike;
      if (gestureLast > 0 && g.scale > 0) zoomBy((g.scale / gestureLast) ** PINCH_GAIN, at(g));
      gestureLast = g.scale;
    },
    ongestureend: (e: Event) => e.preventDefault(),
  };

  // Space held = pan, the way every editor with a canvas does it.
  function keydown(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (e.code === "Space" && !(t?.tagName === "INPUT" || t?.isContentEditable)) {
      e.preventDefault();
      space = true;
    }
  }
  const keyup = (e: KeyboardEvent) => {
    if (e.code === "Space") space = false;
  };

  // Fit on load and on a pane resize — but never once the zoom has been touched
  // by hand, or the view would snap back mid-edit.
  $effect(() => {
    const w = sprite.w;
    const h = sprite.h;
    void viewport.paneW;
    void viewport.paneH;
    if (!viewport.manual) fit(w, h);
  });

  $effect(() => {
    const el = canvas;
    if (!el) return;
    el.width = sprite.w;
    el.height = sprite.h;
    const g = el.getContext("2d");
    if (!g) return;

    // Track every dependency the paint below reads.
    const rows = sprite.frames[editor.frame] ?? [];
    const prev = editor.onion && editor.frame > 0 ? sprite.frames[editor.frame - 1] : null;
    const pts = preview;
    const hint = hoverShape;
    const mq = marquee;
    const ink = editor.tool === "eraser" ? TRANSPARENT : editor.ink;
    void editor.tint; // the tint changes what every cell looks like
    void flashOn; // and the flash changes what the selection looks like

    g.clearRect(0, 0, el.width, el.height);
    // The frame behind, faint: the reason multi-frame sprites line up at all.
    if (prev) {
      g.globalAlpha = 0.28;
      paintRows(g, prev);
      g.globalAlpha = 1;
    }
    paintRows(g, rows);
    // Preview sits on top at full strength — it is about to be real.
    if (pts.length) {
      g.globalAlpha = 0.75;
      g.fillStyle =
        ink === TRANSPARENT ? "#ffffff" : (cellColour(sprite, ink, editor.tint) ?? "#ffffff");
      for (const [x, y] of pts) g.fillRect(x, y, 1, 1);
      g.globalAlpha = 1;
    }

    // The selection, drawn as tinted CELLS rather than as an outline: a flood
    // selection is rarely box-shaped, and the outline of its bounds would claim
    // it holds pixels it does not. The bounds get a dashed frame in the DOM on
    // top of this, which is what makes the extent readable at low zoom.
    // What a click would take, before it takes it. Fainter than the selection
    // itself by a wide margin: this is a hint, and it moves with every pixel of
    // cursor travel, so it has to stay out of the way of the art.
    // Cool rather than white, so a hover is never mistaken for a selection: one
    // is what you would get, the other is what you have.
    if (hint.length) {
      g.fillStyle = "rgba(150,205,255,0.16)";
      for (const [hx, hy] of hint) g.fillRect(hx, hy, 1, 1);
    }
    const sel = selection.cells;
    if (sel.size) {
      g.fillStyle = flashOn ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.15)";
      for (const k of sel) {
        const [sx, sy] = k.split(",");
        g.fillRect(Number(sx), Number(sy), 1, 1);
      }
    }
    // The box being dragged out, before it is a selection.
    if (mq) {
      const x0 = Math.min(mq.from.x, mq.to.x);
      const y0 = Math.min(mq.from.y, mq.to.y);
      g.fillStyle = "rgba(255,255,255,0.22)";
      g.fillRect(x0, y0, Math.abs(mq.to.x - mq.from.x) + 1, Math.abs(mq.to.y - mq.from.y) + 1);
    }
  });

  /** Points the current drag would paint — drawn as an overlay, not committed. */
  const preview = $derived.by(() => {
    if (!drag || !hover || !isShape(editor.tool)) return [];
    return strokePoints(editor.tool, drag, hover, shift);
  });

  /** What a click would select, under the cursor. Answering "which pixels does
   *  this take?" before the click is cheaper than answering it afterwards with an
   *  undo — and on a sprite where two shapes touch by a corner, the difference
   *  between them is a pixel you cannot see until something shows you. */
  const hoverShape = $derived.by(() => {
    if (editor.tool !== "select" || !hover || marquee || moving) return [];
    return shapePoints(sprite.frames[editor.frame] ?? [], hover.x, hover.y);
  });

  /** One rule for what a cell looks like, shared with the renderer that bakes
   *  the atlas — so the editor shows what the scene will actually draw, tint
   *  and all. */
  function paintRows(g: CanvasRenderingContext2D, rows: string[]) {
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y];
      for (let x = 0; x < row.length; x++) {
        const colour = cellColour(sprite, row[x], editor.tint);
        if (!colour) continue;
        g.fillStyle = colour;
        g.fillRect(x, y, 1, 1);
      }
    }
  }
</script>

<svelte:window onkeydown={keydown} onkeyup={keyup} />

<div
  class="pane"
  data-bg={backdrop}
  bind:this={pane}
  bind:clientWidth={viewport.paneW}
  bind:clientHeight={viewport.paneH}
  class:panning={panning || space}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={cancel}
  onpointerleave={() => (hover = null)}
  onwheel={wheel}
  {...gestures}
  role="application"
  aria-label="Sprite canvas"
>
  <div
    class="stage"
    style:width={`${sprite.w * px}px`}
    style:height={`${sprite.h * px}px`}
    style:transform={`translate(-50%, -50%) translate(${viewport.tx}px, ${viewport.ty}px)`}
    style:--cell={`${px}px`}
    class:grid={editor.grid && px >= 6}
  >
    <canvas bind:this={canvas}></canvas>
    {#if hasSelection()}
      <!-- The extent, as a marching outline. Sits outside the cells by a hair so
           it never hides the edge pixels it is describing. -->
      <div
        class="ants"
        style:left={`${selection.x0 * px}px`}
        style:top={`${selection.y0 * px}px`}
        style:width={`${(selection.x1 - selection.x0 + 1) * px}px`}
        style:height={`${(selection.y1 - selection.y0 + 1) * px}px`}
      ></div>
    {/if}
  </div>

  <p class="read">
    {sprite.w}×{sprite.h} · ×{px}
    {#if hover}· {hover.x},{hover.y}{/if}
  </p>
</div>

<style>
  .pane {
    position: relative;
    overflow: hidden;
    touch-action: none; /* the gestures are ours */
    background: #101014;
  }
  .pane.panning {
    cursor: grab;
  }
  .pane[data-bg="night"] {
    background: #0b0714;
  }
  .pane[data-bg="dark"] {
    background: #141414;
  }
  .pane[data-bg="light"] {
    background: #e9e9ee;
  }
  .stage {
    position: absolute;
    left: 50%;
    top: 50%;
    /* The transparency checker, drawn by the container so the canvas itself
       stays a plain sprite with real alpha. */
    background-image:
      linear-gradient(45deg, #2a2a2a 25%, transparent 25%),
      linear-gradient(-45deg, #2a2a2a 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #2a2a2a 75%),
      linear-gradient(-45deg, transparent 75%, #2a2a2a 75%);
    background-size: 12px 12px;
    background-position:
      0 0,
      0 6px,
      6px -6px,
      -6px 0;
    background-color: #1e1e1e;
    box-shadow: 0 0 0 1px var(--halo-border);
  }
  .pane[data-bg="night"] .stage,
  .pane[data-bg="dark"] .stage,
  .pane[data-bg="light"] .stage {
    background-image: none;
  }
  .pane[data-bg="night"] .stage {
    background-color: #0b0714;
  }
  .pane[data-bg="dark"] .stage {
    background-color: #141414;
  }
  .pane[data-bg="light"] .stage {
    background-color: #e9e9ee;
  }
  .stage.grid::after {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    background-image:
      repeating-linear-gradient(
        to right,
        rgba(255, 255, 255, 0.13) 0 1px,
        transparent 1px var(--cell)
      ),
      repeating-linear-gradient(
        to bottom,
        rgba(255, 255, 255, 0.13) 0 1px,
        transparent 1px var(--cell)
      );
  }
  /* Marching ants: four dashed gradients, one per edge, with the dash phase
     animated. The box itself must not move a hair — it is describing which cells
     are selected — so what travels is the pattern, not the element. */
  .ants {
    position: absolute;
    pointer-events: none;
    background-image:
      repeating-linear-gradient(to right, #fff 0 3px, transparent 3px 6px),
      repeating-linear-gradient(to right, #fff 0 3px, transparent 3px 6px),
      repeating-linear-gradient(to bottom, #fff 0 3px, transparent 3px 6px),
      repeating-linear-gradient(to bottom, #fff 0 3px, transparent 3px 6px);
    background-size:
      100% 1px,
      100% 1px,
      1px 100%,
      1px 100%;
    background-position:
      0 0,
      0 100%,
      0 0,
      100% 0;
    background-repeat: no-repeat;
    filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.9));
    animation: crawl 0.5s linear infinite;
  }
  @keyframes crawl {
    to {
      background-position:
        6px 0,
        -6px 100%,
        0 -6px,
        100% 6px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ants {
      animation: none;
    }
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    touch-action: none;
    cursor: crosshair;
  }
  .panning canvas {
    cursor: grab;
  }
  .read {
    position: absolute;
    left: 0.6rem;
    bottom: 0.4rem;
    margin: 0;
    font-variant-numeric: tabular-nums;
    color: var(--halo-text-muted);
    font-size: 0.8rem;
    pointer-events: none;
  }
</style>
