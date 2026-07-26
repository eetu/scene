<script lang="ts">
  // Dancer viz: an echo-trailed silhouette over two interfering fields of
  // concentric circles, with a VFD readout of the track's elapsed time — after
  // Spaceballs' "State of the Art" (Amiga, 1992), whose dancers were rotoscoped
  // from filmed footage.
  //
  // The readout is @glowbox/seven-segment (via the Svelte wrapper): one canvas
  // per digit, so MM:SS is a row of five slots with a narrow one for the colon.
  // VFD rather than LED — cyan-green is complementary to the magenta figure,
  // where a red LED adds a third hue that fights both it and the mono backdrop.
  // It's used here for the things a font can't do — the per-segment cross-fade
  // that smears a digit as it changes, and `age`, which gives this unit the
  // uneven wear of hardware that's been powered on for decades.
  //
  // The backdrop and dancer are one WebGL scene (./sota-scene), lazy-imported so
  // three.js stays out of the main bundle. The model is optional — with none
  // present the backdrop and readout still run, only the figure is missing.
  import { SevenSegment } from "@glowbox/svelte";
  import { onMount } from "svelte";

  import type { SotaScene } from "./sota-scene";
  import { crt } from "./crt.svelte";
  import { beatBpm, playback, sampleBands } from "./player.svelte";
  import { driveFrames } from "./raf";

  let { active = true }: { active?: boolean } = $props();

  // The dancer model, built by ./assets/build-dancer.py. Resolved at build time,
  // so an absent asset is an empty object rather than a build error — see
  // ./assets/README.md. `?url` because it's binary: it has to resolve to an
  // emitted asset URL, not be parsed as a module (which the SSR pass would try).
  const DANCER_GLOB = import.meta.glob<string>("./assets/dancer.{glb,fbx}", {
    eager: true,
    query: "?url",
    import: "default",
  });
  const dancerUrl = Object.values(DANCER_GLOB)[0] ?? null;

  let stage: HTMLDivElement;
  let sceneHost: HTMLDivElement | undefined = $state();

  // MM:SS as five display slots. Minutes clamp at 99 — a tracker module that
  // long has bigger problems than its clock.
  let slots = $state<(string | null)[]>(["0", "0", ":", "0", "0"]);
  let glow = $state(0.7);
  // Slow positional drift for the readout, in cqh. Everything else on screen is
  // in constant motion and mitigates itself; the digits are the one bright,
  // static element, which is exactly what burns into an OLED. Two incommensurate
  // periods so the path doesn't retrace, over minutes rather than seconds — the
  // point is to move, not to be seen moving.
  let driftX = $state(0);
  let driftY = $state(0);

  // Tapping the scene hides the readout, for when you just want the picture.
  // Persisted, because it's a preference about how you like to watch rather than
  // a per-session accident — and remembering it is the whole convenience.
  const SHOW_KEY = "scene-dancer-readout";
  let showClock = $state(true);

  // The readout's unlit face. Shared by the CSS panel and by each digit canvas's own
  // background, so the row is one continuous colour whether or not the CRT screen is
  // compositing it (see the note on the SevenSegment below).
  const PANEL = "#06050b";

  function toggleClock() {
    showClock = !showClock;
    try {
      localStorage.setItem(SHOW_KEY, showClock ? "1" : "0");
    } catch {
      /* no storage — the choice just won't outlive the session */
    }
  }
  // Painted flat with PANEL and resized with the row; see the note in the markup.
  let faceEl: HTMLCanvasElement | undefined = $state();
  $effect(() => {
    const el = faceEl;
    if (!el) return;
    const paint = () => {
      const r = el.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      el.width = Math.max(1, Math.round(r.width * dpr));
      el.height = Math.max(1, Math.round(r.height * dpr));
      const g = el.getContext("2d");
      if (!g) return;
      g.fillStyle = PANEL;
      g.fillRect(0, 0, el.width, el.height);
    };
    paint();
    const ro = new ResizeObserver(paint);
    ro.observe(el);
    return () => ro.disconnect();
  });

  // Gates the display row until after first layout. @glowbox/seven-segment paints
  // in a mount effect and throws on a zero-width canvas, and the row is sized in
  // container-query units — which are 0 until the container has been laid out.
  let laidOut = $state(false);

  // Rotate the dance and the trail colours between tracks, so a long listen isn't
  // one loop in one palette forever. Derived from the track's content hash rather
  // than chosen at random, so a given tune always looks the same — moves and
  // colours that changed on every replay would read as a glitch, not as variety.
  // The two use different offsets, so pairings vary independently.
  function pickLook() {
    const key = playback.current?.hash ?? playback.current?.filename ?? "";
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
    h = Math.abs(h);
    scene?.setClip(h);
    scene?.setPalette(h >> 3);
  }

  function timeSlots(total: number): string[] {
    const t = Math.max(0, total);
    const mm = Math.min(99, Math.floor(t / 60))
      .toString()
      .padStart(2, "0");
    const ss = Math.floor(t % 60)
      .toString()
      .padStart(2, "0");
    return [mm[0], mm[1], ":", ss[0], ss[1]];
  }

  let scene: SotaScene | null = null;

  // The viz outlives a track change (the stage persists across auto-advance), so
  // the look has to be re-picked rather than only chosen at mount.
  $effect(() => {
    void playback.current?.hash;
    pickLook();
  });

  onMount(() => {
    let stopped = false;
    try {
      showClock = localStorage.getItem(SHOW_KEY) !== "0";
    } catch {
      /* no storage — default to shown */
    }
    const raf = requestAnimationFrame(() => (laidOut = true));

    // The scene owns the backdrop as well as the dancer, so it's created whether
    // or not a model is present — a missing .fbx costs the figure, not the viz.
    void (async () => {
      try {
        const { createSotaScene } = await import("./sota-scene");
        if (stopped || !sceneHost) return;
        const built = await createSotaScene(sceneHost, { url: dancerUrl, stepFps: 12 });
        // Re-check AFTER the await. That call is slow — three.js plus a 1.12 MB glb —
        // so the component can be torn down while it's in flight, and the old code
        // assigned the finished scene to a `scene` that nobody would ever dispose. Its
        // WebGL context then leaked, and since a browser keeps only ~16 alive, a few
        // quick visualiser switches were enough for it to start dropping live ones and
        // blacking out the pane. This is the dancer's own leak, separate from anything
        // the CRT screen does.
        if (stopped) {
          built.dispose();
          return;
        }
        scene = built;
        pickLook();
      } catch {
        scene = null;
      }
    })();

    let pulse = 0;
    let onScreen = 0; // seconds shown, paused or not — burn-in doesn't care
    const stopFrames = driveFrames(
      (dt) => {
        onScreen += dt;
        driftX = Math.sin((onScreen / 173) * Math.PI * 2) * 1.6;
        driftY = Math.cos((onScreen / 227) * Math.PI * 2) * 1.1;

        pulse = Math.max(active ? sampleBands().bass : 0, pulse - dt * 1.6);

        // Bass swells the display's halo. Floor it well above zero so the unit
        // still reads as "on" between hits.
        glow = 0.55 + pulse * 0.4;

        const next = timeSlots(playback.position || 0);
        if (next.some((v, i) => v !== slots[i])) slots = next;

        scene?.setPulse(pulse);
        scene?.setActive(active);
        if (active) scene?.advance(dt, beatBpm());
      },
      { fps: () => (active ? 30 : 8) },
    );

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stopFrames();
      scene?.dispose();
    };
  });
</script>

<div class="room" bind:this={stage} data-testid="dancer-viz">
  <!-- The toggle covers the whole scene rather than the readout itself: once the
       readout is hidden there'd be nothing left to click to bring it back. A real
       button, so it's keyboard-reachable and announced, sized to fill and made
       invisible rather than faked with a click handler on a div. Named by its own
       visually-hidden label and NOT by `title`: a title on a full-bleed button pops a
       tooltip over the middle of the picture on any hover. -->
  <button class="tap" type="button" onclick={toggleClock} aria-pressed={showClock}>
    <span class="sr">{showClock ? "Hide the clock" : "Show the clock"}</span>
  </button>
  <!-- Backdrop + dancer, one canvas. Two interfering ring fields: the fringes
       sweep far further than the centres move, which CSS gradients can't do. -->
  <div class="scene" bind:this={sceneHost} data-testid="dancer-scene"></div>

  {#if !dancerUrl}
    <!-- No model: say so quietly rather than leaving a mystery gap. -->
    <p class="nodancer">no dancer model</p>
  {/if}

  {#if showClock}
    <div class="display" class:inset={crt.on} style="--dx: {driftX}; --dy: {driftY}">
      <!-- The unlit face the digits sit on, as a CANVAS rather than a CSS background.
           SevenSegment's own `background` is a translucent window tint (alpha ~40/255,
           and only over the window body — the corners stay clear), which assumes a
           housing behind it. That housing used to be this element's CSS background,
           but the CRT screen composites canvases and not CSS, so under CRT the digits
           ended up floating on the backdrop with no face at all. -->
      <canvas class="face" bind:this={faceEl}></canvas>
      {#each laidOut ? slots : [] as slot, i (i)}
        <div class="slot" class:narrow={slot === ":"}>
          <!-- Each digit carries its own opaque background rather than sitting
               transparent over the panel's CSS one. The CRT screen composites
               CANVASES and not CSS, so a transparent digit over a CSS panel loses
               its backing entirely and the segments end up glowing against bare
               black with nothing to read against. Owning the colour per canvas
               works the same either way; the gap is 0 so the row still reads as one
               continuous panel rather than five tiles. -->
          <SevenSegment
            value={slot}
            displayStyle="vfd"
            background={PANEL}
            glow={slot === ":" ? glow * 0.9 : glow}
            age={0.28}
            transition={70}
            label={slot === ":" ? "" : undefined}
          />
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* Deliberately dark and NOT theme-following: a lit display only reads in a
     dark room, same reasoning as the nixie scene. */
  .room {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    background: #07060a;
    container-type: size;
  }

  /* A transparent full-bleed button over the scene. Above the canvas so it
     catches the click, below the readout so the digits still draw over it. */
  .tap {
    position: absolute;
    inset: 0;
    z-index: 1;
    appearance: none;
    border: 0;
    padding: 0;
    background: none;
    cursor: pointer;
  }
  .tap:focus-visible {
    outline: 0.3cqh solid #ffffffb0;
    outline-offset: -0.6cqh;
  }
  /* Visually hidden, still announced. */
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* The scene canvas fills the room; the display floats over it. */
  .scene {
    position: absolute;
    inset: 0;
  }
  .nodancer {
    position: absolute;
    inset: auto 0 4cqh 0;
    margin: 0;
    text-align: center;
    font:
      500 2.4cqh/1 ui-monospace,
      monospace;
    letter-spacing: 0.08em;
    color: #ffffff40;
  }

  /* An overlay readout, not an object: no bezel, no window, no cast light. A
     modelled radio floating over pure abstraction was a category mismatch — the
     digits alone read as instrumentation, which is what the rest of the frame is.
     Sized in `cqh` on both axes so the digits keep their aspect; a full-width row
     stretches each slot and stops looking like a clock. */
  .display {
    position: absolute;
    /* No z-index, and isolated. `.room` is position:relative with z-index auto, so it
       creates no stacking context — a z-index in here competes in the viz pane's
       context instead, and a positive one lifted this panel ABOVE the CRT screen's
       output canvas: it then painted un-composited over the tube while its digit
       canvases stayed hidden, i.e. an empty box. Plain DOM order already puts the
       readout over .scene, so none was needed. `isolation` contains any that gets
       added later. */
    isolation: isolate;
    pointer-events: none; /* the tap target underneath owns the whole surface */
    right: 4cqw;
    bottom: 5cqh;
    width: 26cqh;
    height: 9cqh;
    display: flex;
    align-items: stretch;
    justify-content: center;
    gap: 0.4cqh;
    /* The panel behind the digits. Still here for the rounded corners and the
       padding halo when the CRT screen is off; the digits no longer depend on it
       for their backing. */
    padding: 0.9cqh 1.2cqh;
    border-radius: 1.6cqh;
    background: #06050b;
    /* See driftX/driftY: an imperceptible wander so no pixel holds a lit segment
       for hours. Deliberately NOT disabled under reduced motion — it's measured
       in minutes, far below the threshold for perceived movement, and an OLED
       burns the same either way. */
    transform: translate(calc(var(--dx) * 1cqh), calc(var(--dy) * 1cqh));
  }
  /* Pulled well clear of the corner while the CRT screen is on. Barrel distortion
     is strongest at the very edge of the tube face, and out at 4cqw the readout
     lands in it and squashes into something you can't read. */
  .display.inset {
    right: 10cqw;
    bottom: 12cqh;
  }
  /* Fills the panel, behind the digits. Rounded to match when the CRT screen is off;
     under CRT it composites as the plain rectangle it is, which the bezel and the
     digits sit happily on. */
  .face {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border-radius: 1.6cqh;
    display: block;
  }
  /* The min-widths are load-bearing: @glowbox/seven-segment throws on a canvas
     narrower than ~5px, and these slots are sized in `cqh`, which collapses in a
     small pane. */
  .slot {
    flex: 1 1 0;
    min-width: 9px;
    /* Positioned, so the digits paint ABOVE the face. The face is absolute and these
       were static, and a positioned element paints over a non-positioned sibling
       whatever the DOM order — so the face covered the digits and the readout went to a
       solid black box. It only looked right under the CRT screen, which composites by
       DOM order and so put the digits on top regardless. */
    position: relative;
  }
  /* The colon fits by height, so a slim slot keeps the dots full size. */
  .slot.narrow {
    flex: 0 0 auto;
    width: 2.2cqh;
    min-width: 7px;
  }
</style>
