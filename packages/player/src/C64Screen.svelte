<script lang="ts">
  // A C64 booting a tune and then running a demo for it.
  //
  // The one visualiser that draws with *characters*: the C64's whole display was
  // 40×25 cells of an 8×8 character ROM, so a screen made of anything else isn't
  // a C64 screen. C64 Pro Mono maps that ROM into the Private Use Area by screen
  // code, which is what makes this practical — the model in c64-screen.ts is real
  // screen RAM and colour RAM, the parts in c64-parts.ts poke it, and c64-demo.ts
  // is the running order.
  //
  // Two things keep it looking like hardware rather than like text in a browser.
  // It renders to a fixed 640×400 buffer at exactly 16px — twice the 8px cell, so
  // every glyph lands on whole pixels — and that buffer is then blitted with
  // smoothing off, which scales the pixels rather than resampling them. Drawing at
  // the pane's own size instead would put glyphs on fractional pixels and the
  // whole thing would go soft, which is the one thing a bitmap face must not do.
  //
  // Cells are blitted from a pre-rendered atlas rather than drawn with fillText.
  // A full-screen part fills all 1000 of them every frame, and shaping a glyph a
  // thousand times a frame to draw the same 256 shapes is the one thing here that
  // would actually cost something — the atlas turns it into a memcpy.
  import { fitCanvas2d } from "./canvas2d";
  import { createDemo, type Feed, stepDemo } from "./c64-demo";
  import { rgb, VIC_PALETTE } from "./c64-palette";
  import { COLS, ROWS, SPACE } from "./c64-screen";
  import { moduleLines } from "./module-text";
  import { playback, readScope, sampleBands, SCOPE_SIZE } from "./player.svelte";
  import { driveFrames } from "./raf";

  let { active = true }: { active?: boolean } = $props();

  let canvas: HTMLCanvasElement | null = $state(null);

  /** Cell size in the offscreen buffer: 2× the C64's 8×8, so the bitmap face is
   *  pixel-exact. The baseline sits at 0.875em — the font's ascent is 1792 of
   *  2048 units, and its descent makes up the rest of the em. */
  const CELL = 16;
  const BASELINE = 14;
  const SCREEN_W = COLS * CELL;
  const SCREEN_H = ROWS * CELL;
  /** Border, in cells. A real one is ~4 characters top and bottom on PAL. */
  const BORDER = 3;
  const FRAME_W = SCREEN_W + BORDER * 2 * CELL;
  const FRAME_H = SCREEN_H + BORDER * 2 * CELL;
  /** Screen codes, and how many colours the atlas holds a copy in. */
  const CODES = 256;
  const COLORS = VIC_PALETTE.length;

  /** The script the scroller reads — the same text the split-flap board and the
   *  hi-fi's text face use, which for a SID is its title, artist and STIL notes. */
  const script = $derived(
    moduleLines(playback.current, playback.instruments, playback.samples, playback.notes),
  );

  /** Every screen code in every colour, laid out code-across by colour-down. */
  function buildAtlas(font: string): HTMLCanvasElement {
    const a = document.createElement("canvas");
    a.width = CODES * CELL;
    a.height = COLORS * CELL;
    const g = a.getContext("2d")!;
    g.font = font;
    g.textBaseline = "alphabetic";
    for (let c = 0; c < COLORS; c++) {
      g.fillStyle = rgb(c);
      for (let code = 0; code < CODES; code++) {
        if (code === SPACE) continue; // nothing to draw, and it's most of a screen
        // Screen code → the font's Private Use Area image of the character ROM.
        g.fillText(String.fromCharCode(0xee00 + code), code * CELL, c * CELL + BASELINE);
      }
    }
    return a;
  }

  $effect(() => {
    const el = canvas;
    if (!el) return;

    let w = 0;
    let h = 0;
    const fit = fitCanvas2d(el, (fw, fh) => {
      w = fw;
      h = fh;
    });
    if (!fit) return;
    const g2 = fit.ctx;

    const buf = document.createElement("canvas");
    buf.width = FRAME_W;
    buf.height = FRAME_H;
    const bg = buf.getContext("2d")!;
    bg.imageSmoothingEnabled = false;

    // The family the app declares for the character ROM. Read off the live theme
    // the way the visualisers read --accent, so the package never hard-depends on
    // an app token.
    const family =
      getComputedStyle(el).getPropertyValue("--font-c64").trim() || "ui-monospace, monospace";
    const font = `${CELL}px ${family}`;

    // Build now so there is always something to blit, and again once the face has
    // actually loaded — the first atlas would otherwise be a screenful of the
    // fallback, frozen in place for the life of the visualiser. Never awaited: if
    // the font never arrives (a test harness that neutralises the retro tokens, a
    // cold cache) the demo still runs.
    let atlas = buildAtlas(font);
    document.fonts
      ?.load(font)
      .then(() => {
        atlas = buildAtlas(font);
      })
      .catch(() => {});

    const wave = new Uint8Array(SCOPE_SIZE);
    let demo = createDemo(playback.current?.hash ?? "");
    let bootedFor = playback.current?.hash ?? null;

    const stopFrames = driveFrames(
      (dt) => {
        // Re-boot when the track changes: the LOAD line names the tune, so a new
        // one has to load rather than inherit the last one's screen.
        const key = playback.current?.hash ?? null;
        if (key !== bootedFor) {
          bootedFor = key;
          demo = createDemo(key ?? "");
        }

        const bands = sampleBands();
        const feed: Feed = {
          bass: bands.bass,
          mid: bands.mid,
          treble: bands.treble,
          beat: playback.beat,
          wave: readScope(wave) ? wave : [],
          title: playback.current?.title || playback.current?.filename || "",
          lines: script,
        };
        stepDemo(demo, dt, feed);

        const { chars, colors, border, background } = demo.screen;
        bg.fillStyle = rgb(border);
        bg.fillRect(0, 0, FRAME_W, FRAME_H);
        bg.fillStyle = rgb(background);
        bg.fillRect(BORDER * CELL, BORDER * CELL, SCREEN_W, SCREEN_H);

        for (let i = 0; i < chars.length; i++) {
          const code = chars[i];
          if (code === SPACE) continue;
          bg.drawImage(
            atlas,
            code * CELL,
            (colors[i] & 0x0f) * CELL,
            CELL,
            CELL,
            (BORDER + (i % COLS)) * CELL,
            (BORDER + Math.floor(i / COLS)) * CELL,
            CELL,
            CELL,
          );
        }

        // Whole-pixel scaling, letterboxed to the C64's aspect. Smoothing off:
        // these pixels are the picture, and interpolating them is the one way to
        // make an 8×8 face look wrong.
        const scale = Math.min(w / FRAME_W, h / FRAME_H);
        const dw = FRAME_W * scale;
        const dh = FRAME_H * scale;
        g2.fillStyle = "#000";
        g2.fillRect(0, 0, w, h);
        g2.imageSmoothingEnabled = false;
        g2.drawImage(buf, (w - dw) / 2, (h - dh) / 2, dw, dh);
      },
      { active: () => active },
    );

    return () => {
      stopFrames();
      fit.stop();
    };
  });
</script>

<canvas bind:this={canvas} aria-label="C64 demo screen"></canvas>

<style>
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    background: #000;
  }
</style>
