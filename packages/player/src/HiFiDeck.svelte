<script lang="ts">
  // Hi-fi: a 90s mini-system stack — a vacuum-fluorescent amplifier faceplate over a
  // cassette deck with a smoked door, and a speaker either side when the pane is wide
  // enough to stand them there.
  //
  // Two canvases, not one, and the seam between them is the point. The display is
  // @glowbox/vfd, which owns a canvas and everything inside the glass: the phosphor, the
  // filament haze in front of it, the filter plastic, the multiplex. Everything OUTSIDE
  // the glass — the brushed faceplate the display is screwed into, the door, the tape —
  // is ours, drawn on a 2D canvas underneath. The panel is built with `bezel: null`, so it
  // is transparent outside its own plate and the chassis shows through around it; the
  // chassis, for its part, cuts a black recess exactly where the plate lands and lays the
  // display's own light back over the metal around it.
  //
  // What makes the thing work is that almost none of it moves. The chassis is machined
  // objects, so it is painted once into an offscreen and blitted; the cassette's shell and
  // label are repainted only when the tape changes; the VFD stops rendering entirely once
  // its anodes settle. Per frame this leaves two tape packs, a door and a few lamps, which
  // is how a scene with this much surface detail costs less than the shaders do.
  //
  // The reels are not decoration. Tape moves at a constant linear speed between two packs
  // of different sizes, so the supply hub speeds up as it empties while the take-up slows
  // as it fills, the radii move as a square root of position, and the counter runs fast at
  // the head of a side and slow at the end. All of that comes out of cassette.ts rather
  // than out of a fudge factor — see the note there about why it is worth the trouble.
  import { onMount } from "svelte";

  import type { VfdPanel } from "@glowbox/vfd";
  import {
    counterText,
    type Deck,
    initialDeck,
    startSwap,
    stepDeck,
    stepSwap,
    type Swap,
    swapOpen,
  } from "./cassette";
  import {
    type Chassis,
    type ChassisInput,
    createChassis,
    type HifiButtonId,
    type Rect,
  } from "./hifi-chassis";
  import { moduleLines } from "./module-text";
  import {
    playNext,
    playPrev,
    setVolume,
    stop,
    togglePause,
    transportToggle,
  } from "./player.svelte";
  import { driveFrames } from "./raf";
  import { sampleBands } from "./scope";
  import { playback } from "./state.svelte";
  import {
    createFaceDriver,
    type FaceInput,
    type PanelFace,
    panelFrame,
    panelLayout,
    type PanelSize,
    panelZones,
    reelDots,
    stereoLevels,
  } from "./vfd-face";
  import { reelFrameAt, sampleReel, watchReel } from "./reel";
  import { setGrilles, setVfdFace, VFD_FACES, vfdView } from "./vfd-mode.svelte";

  let { active = true }: { active?: boolean } = $props();

  let host: HTMLDivElement;
  let chassisCanvas: HTMLCanvasElement | undefined = $state();
  let vfdCanvas: HTMLCanvasElement | undefined = $state();

  // The front panel's controls, published once the chassis has measured itself. Real
  // focusable buttons are laid over them — see the markup — rather than hit-testing the
  // canvas: that way the keyboard, the focus ring and the accessible name all come for
  // free, and the picture stays the only thing the canvas is responsible for.
  let controls = $state<{ id: HifiButtonId; rect: Rect; label: string; inert?: boolean }[]>([]);
  let pressed = $state<HifiButtonId | null>(null);
  /** The volume knob's box, when the stack is the machine on screen. The walkman has no
   *  knob — its volume wheel is on the edge, with the transport. */
  let knob = $state<Rect | null>(null);
  /** The speaker cabinets, when the pane is wide enough to stand them beside the stack.
   *  Each gets a control so the covers come off by touching a speaker. */
  let cabinets = $state<[Rect, Rect] | null>(null);
  /** The dimmer's three real positions: full, half, and the one you could barely read. */
  const DIM = [1, 0.55, 0.25];
  let dim = $state(0);
  let powered = $state(true);
  /** The walkman's HOLD switch: locks the press-the-plate gesture, which is what HOLD was
   *  for. Only that machine has one. */
  let held = $state(false);
  /**
   * Whether there is a cassette in the well.
   *
   * The one piece of state this machine has that the player does not. The player has no
   * "nothing selected" — there is always a current track — so an EJECT that only played an
   * animation and put the same tape back was a button that did nothing. Here it takes the
   * tape OUT and stops, and the deck sits open with its mechanism showing until PLAY, which
   * puts the same tape back in and starts it. That is what the key does on the real thing,
   * and it needs no concept the player is missing: the track stays selected throughout, it
   * is just not in the deck.
   */
  let loaded = $state(true);
  /** Which plate the display is. Follows the pane's shape: a portrait pane draws a personal
   *  stereo, which has room for one line rather than a whole faceplate. */
  let panelSize: PanelSize = "full";

  /** A module with no duration still has to spool plausibly, so an unknown length is
   *  treated as a five-minute side rather than pinning the reels at the head. */
  const NOMINAL_S = 300;

  function hashSeed(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return h >>> 0;
  }

  // What goes on the tape's label. Derived rather than read in the loop so a track change
  // is one repaint of the cassette offscreen instead of a per-frame text layout.
  const tapeOf = $derived.by(() => {
    const t = playback.current;
    return {
      title: String(t?.title || t?.filename || "UNTITLED"),
      artist: String(t?.artist || t?.group || ""),
      // Turn the tape over as the queue advances, the way you would.
      side: (playback.queueIndex > 0 && playback.queueIndex % 2 === 1 ? "B" : "A") as "A" | "B",
      seed: hashSeed(t?.hash ?? t?.filename ?? ""),
    };
  });

  // The composer's own words, for the text face. Joined into one run because the ticker
  // scrolls a continuous line rather than paging.
  const message = $derived(
    moduleLines(playback.current, playback.instruments, playback.samples, playback.notes)
      .filter(Boolean)
      .join("   ·   ") || "NO MESSAGE",
  );

  /**
   * The film a track can bring with it (see reel.ts), on the one display here that can
   * hold a picture: the window's dot field.
   *
   * It takes the window whichever face is selected, the same way it takes the flip board
   * and the cube — a tune that carries one is the event, not a mode you go looking for.
   * DISPLAY hands the window back, and that is also the way out.
   */
  const reels = watchReel(playback);
  let reelOn = $state(false);
  /** The window's job: the film while there is one, otherwise whatever DISPLAY chose. */
  const panelFace = $derived<PanelFace>(reelOn ? "reel" : vfdView.face);
  let film = new Uint8Array(0);

  // Re-declaring the plate is the expensive call on the panel handle (it re-compiles every
  // anode), so it happens on a face change and nowhere else. Assigned once the panel
  // exists; declared out here because an $effect has to be created during component init,
  // not inside the async setup below — same reason the scroller board does it this way.
  let reface: (() => void) | null = null;
  let redim: (() => void) | null = null;
  let repower: (() => void) | null = null;
  /** Repaint once, even if the frame loop has frozen itself on a stopped pane. */
  let poke: (() => void) | null = null;
  $effect(() => {
    void held;
    poke?.();
  });
  // The knob turns with the level, and the level can change from the transport while this
  // pane is paused and its loop frozen.
  $effect(() => {
    void playback.volume;
    poke?.();
  });
  // Same for the grille covers, which are the one thing you set by touching the picture
  // rather than a control — and most likely to be fiddled with while nothing is playing.
  $effect(() => {
    void vfdView.grilles;
    poke?.();
  });
  // The door has to move when the deck is emptied or reloaded, and both can happen with the
  // music stopped and the frame loop frozen.
  $effect(() => {
    void loaded;
    poke?.();
  });
  // A film arriving or ending re-wires the window, so it goes through the same
  // re-declaration a DISPLAY press does — the plate is a pure function of what the window
  // is showing, and `reel` is one of the things it can show.
  $effect(() => {
    void panelFace;
    reface?.();
  });
  $effect(() => {
    void dim;
    redim?.();
  });
  // POWER reaches two things: the panel handle switches the tube, and the chassis fades the
  // tube's light off the metal around it. The poke is what starts that fade on a stopped
  // pane — from there `settling` keeps the loop awake until it lands.
  $effect(() => {
    void powered;
    repower?.();
    poke?.();
  });

  // A track change ejects: the door drops, the cassette is swapped at the bottom of the
  // travel, the door closes. Kicked off here, run by the frame loop.
  let eject: (() => void) | null = null;
  let mounted = false;
  $effect(() => {
    void playback.current?.hash;
    if (!mounted) {
      mounted = true;
      return; // the first tape is already in the well
    }
    eject?.();
  });

  onMount(() => {
    let stopped = false;
    let panel: VfdPanel | null = null;
    let chassis: Chassis | null = null;
    let stopFrames: (() => void) | null = null;
    let ro: ResizeObserver | null = null;
    let themeWatch: MutationObserver | null = null;
    /** Something changed that the cached layers depend on — repaint once even if the music
     *  is stopped and the frame loop has frozen itself. */
    let dirty = false;
    /** The last frame's input, so a repaint outside the loop has something to draw. */
    let lastInput: ChassisInput | null = null;
    const redraw = () => {
      if (lastInput) chassis?.draw(lastInput);
    };
    // True while the door is in motion, so the frame driver keeps painting through an
    // eject that happens while the music is paused (it would otherwise freeze the loop
    // mid-travel and leave the door hanging).
    let swapping = false;

    void (async () => {
      const { createVfdPanel } = await import("@glowbox/vfd");
      if (stopped || !chassisCanvas || !vfdCanvas) return;

      chassis = createChassis(chassisCanvas);
      if (!chassis) return; // no 2D context — leave the pane empty rather than half-built

      panel = createVfdPanel(vfdCanvas, {
        frame: panelFrame(panelSize),
        layout: panelLayout(panelFace, panelSize),
        // The cyan-green ZnO:Zn classic behind green filter plastic: the combination every
        // mini system in this period used, and the reason the memory of them is that
        // particular colour rather than the phosphor's own.
        phosphor: "zn-o",
        filter: "green",
        zones: panelZones(panelFace, panelSize),
        // Low on purpose. Persistence here is a stylized control and the package's own
        // warning applies squarely to this panel: past ~0.45 a character field ghosts into
        // its previous value, and the title readout MARCHES a character at a time because
        // a segment field cannot do anything else. At 0.12 the analyser bars get a tail
        // and the text stays sharp.
        persistence: 0.12,
        glow: 0.75,
        // Transparent outside the plate, so the chassis painted underneath is the bezel.
        bezel: null,
        // The power-on self-test, because that is what happens when you switch a stereo on
        // and it is the one animation the panel can do that nothing else here can.
        selfTest: true,
        label: "the amplifier's display",
      });
      if (!panel) return;

      const driver = createFaceDriver();
      const deck = initialDeck();
      let swap: Swap | null = null;

      const measure = () => {
        const r = host.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;
        chassis!.resize(r.width, r.height, window.devicePixelRatio || 1);
        // A pane that changes shape can change which machine is on screen, and the two
        // carry different plates. Re-declare the hardware when it does — drive state comes
        // across by element name, so the readout keeps showing what it was showing.
        if (chassis!.panelSize !== panelSize) {
          panelSize = chassis!.panelSize;
          panel!.setLayout(panelLayout(panelFace, panelSize), panelFrame(panelSize));
          panel!.setOptions({ zones: panelZones(panelFace, panelSize) });
        }
        // Park the display canvas exactly on the cutout the chassis just drew for it.
        const g = chassis!.glass;
        const el = vfdCanvas!;
        el.style.left = `${g.x}px`;
        el.style.top = `${g.y}px`;
        el.style.width = `${g.w}px`;
        el.style.height = `${g.h}px`;
        panel!.resize();
        controls = chassis!.buttons;
        cabinets = chassis!.speakers;
        const v = chassis!.mode === "stack" ? chassis!.stack.volume : null;
        knob = v ? { x: v.x - v.r, y: v.y - v.r, w: v.r * 2, h: v.r * 2 } : null;
      };

      chassis.retape(tapeOf);
      measure();

      // Resizing sets the canvas's backing store, which CLEARS it — and the frame driver
      // tears its loop down entirely once the music stops (see raf.ts), so on a paused or
      // stopped pane nothing was left to draw the new size and the visualiser went blank
      // until playback resumed. `dirty` wakes the loop for one frame; `redraw` covers the
      // gap before it gets there, using the last frame's input so nothing has to be
      // recomputed.
      ro = new ResizeObserver(() => {
        measure();
        dirty = true;
        redraw();
      });
      ro.observe(host);

      // The finish follows the app's theme, which is published as `data-theme` on <html>.
      // Watched as an attribute rather than by importing the theme store: the attribute is
      // the actual contract, it is what the chassis reads, and it resolves `auto` for us.
      // Same freeze problem as resize — a theme switch on a paused pane repainted nothing.
      themeWatch = new MutationObserver(() => {
        dirty = true;
        redraw();
      });
      // `data-accent` too: the accent is orthogonal to light/dark, and the cassette's label
      // is printed in it — so a re-accent has to reach the cached tape layer as well.
      themeWatch.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "data-accent"],
      });

      reface = () => {
        // Drive state survives a re-declaration by element NAME, so the readouts and
        // annunciators the furniture owns keep showing what they were showing and only the
        // window changes job. The window plastic goes with it — see panelZones.
        panel?.setLayout(panelLayout(panelFace, panelSize), panelFrame(panelSize));
        panel?.setOptions({ zones: panelZones(panelFace, panelSize) });
      };
      redim = () => panel?.setOptions({ brightness: DIM[dim] });
      repower = () => panel?.power(powered);
      poke = () => {
        dirty = true;
        // `redraw` repaints from the LAST frame's input, which is the right thing for a
        // resize or a theme switch but wrong for the handful of values that change from
        // outside the loop — the loop is what builds that snapshot, and on a stopped pane
        // it is torn down and takes up to a watchdog tick to come back. Refreshing them
        // here is the difference between a knob that follows the transport and one that
        // catches up a quarter-second later.
        if (lastInput) {
          lastInput.hold = held;
          lastInput.volume = playback.volume;
          lastInput.grilles = vfdView.grilles;
          lastInput.loaded = loaded;
          lastInput.powered = powered;
        }
        redraw();
      };

      eject = () => {
        swap = startSwap();
        swapping = true;
      };

      stopFrames = driveFrames(
        (dt) => {
          if (!panel || !chassis) return;

          if (swap) {
            // stepSwap returns true exactly once, at the bottom of the door's travel —
            // the moment the well is hidden enough to exchange the cassette unseen.
            if (stepSwap(swap, dt)) chassis.retape(tapeOf);
            if (swap.left <= 0) {
              swap = null;
              swapping = false;
            }
          }

          const playing = playback.playing;
          const paused = playback.paused;
          // The door is open for a track-change swap, and it STAYS open while the deck is
          // empty — which is the whole difference between the two: a swap is a door that
          // comes back, an eject is a door left waiting for you.
          const ejecting = (!!swap && swapOpen(swap)) || !loaded;
          const mode: Deck = ejecting ? "eject" : paused ? "pause" : playing ? "play" : "stop";

          const dur = playback.duration > 0 ? playback.duration : NOMINAL_S;
          const frac = Math.min(1, Math.max(0, playback.position / dur));
          stepDeck(deck, dt, mode, frac);

          const bands = sampleBands();
          const [l, r] = stereoLevels(playback.vu);
          lastInput = {
            deck,
            title: tapeOf.title,
            artist: tapeOf.artist,
            side: tapeOf.side,
            seed: tapeOf.seed,
            bass: bands.bass,
            mid: bands.mid,
            treble: bands.treble,
            playing,
            paused,
            peakL: l,
            peakR: r,
            pressed,
            hold: held,
            volume: playback.volume,
            grilles: vfdView.grilles,
            powered,
            loaded,
          };
          chassis.draw(lastInput);
          dirty = false;

          // The film, if this tune brought one. Sampled here rather than in the driver
          // because the clip and the playhead are the component's; the plate only knows
          // how many dots its window has.
          reels.poll();
          const reel = reels.reel;
          reelOn = reel !== null;
          if (reel) {
            const { cols, rows } = reelDots(panelSize);
            if (film.length !== cols * rows) film = new Uint8Array(cols * rows);
            sampleReel(reel, reelFrameAt(reel, playback.position), cols, rows, film);
          }

          const input: FaceInput = {
            title: tapeOf.title,
            message,
            elapsed: playback.position,
            counter: counterText(frac),
            playing,
            paused,
            vu: playback.vu,
            mono: playback.mono,
            repeat: playback.repeat,
            shuffle: playback.shuffle,
            film: reel ? film : null,
          };
          driver.furniture(panel, panelFace, dt, input, panelSize);
          driver.window(panel, panelFace, dt, input, panelSize);
        },
        // Also live while a control is held or the door is moving, so a press gives
        // feedback and an eject finishes even with the music stopped — the frame driver
        // would otherwise have frozen the loop.
        {
          active: () =>
            active || swapping || pressed !== null || dirty || !loaded || !!chassis?.settling,
        },
      );
    })();

    return () => {
      stopped = true;
      reels.stop();
      stopFrames?.();
      ro?.disconnect();
      themeWatch?.disconnect();
      panel?.dispose();
      reface = null;
      redim = null;
      repower = null;
      poke = null;
      eject = null;
    };
  });

  /**
   * DISPLAY: step the window's job on.
   *
   * While a track carries a film, the film is one more position in the cycle rather than
   * something the first press throws away. It has to be: DISPLAY is the only control this
   * window has, so a press that dismissed the film for good stranded it — you pressed the
   * button to see the analyser, and the picture was gone for the rest of the tune with no
   * way back to it. That is what "it was there a moment ago" looks like from the outside.
   *
   * The position exists only while there is a clip, so no other tune grows a face that
   * shows nothing. Leaving the film dismisses it so the chosen face is what the plate is
   * declared for; coming round to it takes it back.
   */
  function cycleFace() {
    if (reels.reel) {
      reels.dismiss();
      reelOn = false;
      return;
    }
    const i = VFD_FACES.findIndex((f) => f.id === vfdView.face);
    if (i === VFD_FACES.length - 1 && reels.found) {
      reels.restore();
      return;
    }
    setVfdFace(VFD_FACES[(i + 1) % VFD_FACES.length].id);
  }

  /** What each control on the front actually does. */
  function press(id: HifiButtonId) {
    switch (id) {
      // The three buttons that belong to the display, doing what the buttons with those
      // names did: cycle the window's job, step the dimmer through its positions, and
      // switch the thing off — which on a VFD is not blank, since the undriven anodes and
      // the silkscreen are still sitting there behind the glass.
      case "display":
        // HOLD locks it, which is the whole job of a hold switch.
        return held ? undefined : cycleFace();
      case "hold":
        return void (held = !held);
      case "dimmer":
        return void (dim = (dim + 1) % DIM.length);
      case "power":
        return void (powered = !powered);
      // EJECT takes the tape out and stops. The door stays open, because that is where a
      // door goes when you eject and there is nothing to close it onto.
      case "eject":
        if (loaded) {
          loaded = false;
          stop();
        } else {
          loaded = true;
        }
        return;
      // The transport. REW and FF reach the previous and next track, which is what they
      // were for on a deck fed by a changer.
      case "rew":
        return playPrev();
      case "ff":
        return playNext();
      case "pause":
        return togglePause();
      // PLAY with the deck open loads the tape back and starts it. The track was never
      // deselected — it was out of the machine — so this is the same track it always was.
      case "play":
        if (!loaded) loaded = true;
        return transportToggle();
      case "stop":
        return stop();
      case "rec":
        return; // nothing here records
    }
  }
</script>

<div class="hifi" bind:this={host} data-testid="hifi-deck">
  <canvas class="chassis" bind:this={chassisCanvas}></canvas>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <canvas class="vfd" bind:this={vfdCanvas} onpointerdown={() => press("display")}></canvas>
  <!-- The front panel's controls.
       This visualiser has no chip row, unlike the flip-dot board and the split-flap, and
       that is the point: it drew a DISPLAY button, so the DISPLAY button is the control.
       Bolting a row of chips over a picture of a stereo that already has the right button
       on it would be admitting the picture was only a picture.
       What lives here is the half a canvas cannot be. Each of these is a real <button>,
       invisible, sized and positioned onto the hardware the chassis drew — so the
       keyboard, the focus ring, the accessible name and the hit region all come from the
       platform instead of from pointer maths, and the canvas stays responsible only for
       what it looks like. Same division as the scroller board's range slider. -->
  {#each controls as c (c.id)}
    <button
      class="hw"
      class:inert={c.inert}
      style:left="{c.rect.x}px"
      style:top="{c.rect.y}px"
      style:width="{c.rect.w}px"
      style:height="{c.rect.h}px"
      disabled={c.inert}
      aria-label={c.label}
      aria-pressed={c.id === "hold" ? held : undefined}
      title={c.label}
      onpointerdown={() => (pressed = c.id)}
      onpointerup={() => (pressed = null)}
      onpointerleave={() => (pressed = null)}
      onpointercancel={() => (pressed = null)}
      onclick={() => press(c.id)}
    ></button>
  {/each}
  {#if knob}
    <!-- The volume knob is a KNOB, so it takes a drag rather than a press — which is why it
         gets a range rather than a button. Invisible and laid over the drawn knob, the same
         division as the scroller board's scrubber: the canvas owns the picture, this owns the
         semantics, the keyboard model and the focus ring.
         Vertical, so dragging up turns it up. A horizontal range over a round control tells
         you the wrong thing about which way it moves. -->
    <input
      class="vol"
      type="range"
      min="0"
      max="1"
      step="0.01"
      value={playback.volume}
      aria-label="Volume"
      title="Volume"
      style:left="{knob.x}px"
      style:top="{knob.y}px"
      style:width="{knob.w}px"
      style:height="{knob.h}px"
      oninput={(e) => setVolume(Number(e.currentTarget.value))}
    />
  {/if}
  <!-- The grille covers. Clipping them on and pulling them off is a thing you do by taking
       hold of the SPEAKER, so the control is the speaker — the same argument that put the
       display's job on the DISPLAY button instead of on a chip row.
       Both cabinets toggle together, from either one. A stereo pair with one cover on and
       one off doesn't read as a choice, it reads as a mistake. -->
  {#each cabinets ?? [] as cab, i (i)}
    <button
      class="hw"
      style:left="{cab.x}px"
      style:top="{cab.y}px"
      style:width="{cab.w}px"
      style:height="{cab.h}px"
      aria-label="Speaker grille covers"
      aria-pressed={vfdView.grilles}
      title={vfdView.grilles ? "Take the grille covers off" : "Put the grille covers on"}
      onclick={() => setGrilles(!vfdView.grilles)}
    ></button>
  {/each}
</div>

<style>
  /* The room the hardware is standing in, matched to whichever finish the chassis is going
     to paint (see PALETTES in hifi-parts.ts). Unlike the flip-dot board and the scroller,
     this one DOES follow the theme: those are objects that only read in a dark room, but a
     silver-faced stereo in a lit room is exactly what the light theme is, and a black pane
     behind it would be a hole rather than a surround.

     Only ever visible for the frame before the canvas paints — but that frame is the one
     you see when the tab opens. */
  .hifi {
    position: relative;
    width: 100%;
    height: 100%;
    /* Both zeroed, not just the height.
       A flex item defaults to `min-size: auto` on the MAIN axis, which floors it at its
       content's min-content size. The app's viz stage is a ROW flex, so that floor is a
       WIDTH — and this component's content is a canvas the chassis sizes with an explicit
       inline `width: NNNpx`. The result was a pane that followed the window's height and
       ignored its width completely: once laid out at 960 it could never be narrower than
       960, so the ResizeObserver never saw a width change and the stack never gave way to
       the walkman. Hosts set `min-height: 0` out of habit and almost never set
       `min-width: 0`, so this belongs here rather than in either app. */
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: #08090b;
  }
  :global(html[data-theme="light"]) .hifi {
    background: #b9bcc2;
  }
  /* Out of flow, like the display and the controls. It carries an explicit pixel size (the
     chassis owns its own backing store), and an in-flow element with an explicit size is
     exactly what gives an ancestor flex item a min-content floor to get stuck on — see the
     note on .hifi. Absolutely positioned it contributes nothing to intrinsic sizing, so the
     pane is free to shrink in both directions. */
  .chassis {
    position: absolute;
    left: 0;
    top: 0;
    display: block;
  }
  /* Parked on the faceplate's cutout by the resize pass. Absolutely positioned rather than
     laid out, because where it goes is decided by the chassis drawing rather than by CSS —
     the recess and the plate have to line up to the pixel or the illusion is a canvas
     sitting on a picture of a stereo. */
  .vfd {
    position: absolute;
    left: 0;
    top: 0;
    z-index: 2;
    display: block;
    cursor: pointer;
  }
  /* Invisible, but present. Laid exactly over the button the chassis drew, so a click and
     a tap land where the picture says they should and focus lands somewhere that matches
     what is on screen.
     Transparent rather than display:none or visibility:hidden — both of those take an
     element back out of the accessibility tree, which is the entire reason these exist.
     (The same distinction the scroller board's slider and @glowbox/crt both needed.) */
  .hw {
    position: absolute;
    z-index: 3;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: transparent;
    cursor: pointer;
    /* No touch-action delay, and no text selection when a key is held down. */
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  .hw.inert {
    cursor: default;
  }
  /* The one time they show themselves: a focus ring is worthless if you can't see it, and
     these are the only way to reach the transport from a keyboard. */
  .hw:focus-visible {
    outline: 2px solid var(--accent, #f78f08);
    outline-offset: 2px;
    border-radius: 3px;
  }
  /* Same treatment as .hw, and vertical so a drag up turns it up. */
  .vol {
    position: absolute;
    z-index: 3;
    margin: 0;
    padding: 0;
    opacity: 0;
    cursor: ns-resize;
    writing-mode: vertical-lr;
    direction: rtl;
    touch-action: none;
  }
  .vol:focus-visible {
    opacity: 1;
  }
  /* Touch: the faceplate's own buttons are drawn at hardware scale, which on a phone is
     well under the 44px both platforms ask for. The drawn button stays the size it should
     be and the pressable area grows past it — the usual answer, and it works here because
     nothing else on the faceplate is pressable for it to steal from. */
  @media (pointer: coarse) {
    .hw {
      min-width: 2.75rem;
      min-height: 2.75rem;
    }
  }
</style>
