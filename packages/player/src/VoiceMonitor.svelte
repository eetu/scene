<script lang="ts">
  // The SID's answer to the pattern grid.
  //
  // A tracker module has rows to show; a SID has none — its music is 6502 code
  // writing chip registers 50 times a second. So instead of a grid this shows
  // the thing that actually makes the sound: each voice's oscillator, envelope
  // and routing, read live off the chip and synced to the audio you're hearing
  // (the registers ride the same audio-synced relay as the position and VU).
  //
  // Reads `playback.sidRegs`, which is empty for module playback — the player
  // only offers this tab when the engine reports no pattern support.
  import { decodeChips, noteFor, type Voice, type Waveform } from "./sid/registers";
  import { playback } from "./state.svelte";

  /** In register order, so the lamps read left-to-right as the chip lays them out. */
  const WAVES: Waveform[] = ["triangle", "saw", "pulse", "noise"];
  const GLYPH: Record<Waveform, string> = {
    triangle: "△",
    saw: "◺",
    pulse: "▭",
    noise: "▨",
  };

  const chips = $derived(decodeChips(playback.sidRegs));
  /** Per-voice level from the VU feed, index-aligned with the decoded voices. */
  const level = (v: Voice) => playback.vu[v.index] ?? 0;

  const pct = (n: number, max: number) => `${Math.round((n / max) * 100)}%`;
  // Integer Hz. The tenth digit is below the resolution of anything you can read
  // at 43 frames a second — with vibrato it just strobes.
  const hz = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)}k` : String(Math.round(n)));

  // Gate hold.
  //
  // The registers are sampled once per audio chunk — ~43 Hz — while the tune
  // drives the chip from a 50 Hz raster interrupt. The two rates don't divide,
  // so consecutive samples land at different phases of each frame and a voice
  // that is retriggering steadily reads as gate-on, gate-off, gate-on… The strip
  // then strobes between its two opacities and never settles.
  //
  // So the display holds a voice "active" briefly after the last sample that saw
  // it gated. That's honest — a voice retriggering every frame IS continuously
  // sounding — and it's the same peak-hold a VU meter uses for the same reason.
  const HOLD_MS = 140;
  const lastGated = new Map<number, number>();
  /** Voice indices currently held active. */
  let active = $state(new Set<number>());
  /** Last note name seen while a voice was gated, so the readout doesn't blank
   *  and re-fill between retriggers. */
  const lastNote = new Map<number, string>();

  $effect(() => {
    const now = performance.now();
    const next = new Set<number>();
    for (const chip of chips) {
      for (const v of chip.voices) {
        if (v.gate) {
          lastGated.set(v.index, now);
          const n = noteFor(v.hz);
          if (n) lastNote.set(v.index, n);
        }
        if (now - (lastGated.get(v.index) ?? -Infinity) < HOLD_MS) next.add(v.index);
        else lastNote.delete(v.index);
      }
    }
    active = next;
  });

  const isActive = (v: Voice) => active.has(v.index);
  const noteOf = (v: Voice) => (v.gate ? noteFor(v.hz) : lastNote.get(v.index)) || "—";
</script>

<div class="vm" aria-label="SID voice monitor">
  {#if !chips.length}
    <p class="idle">waiting for the chip…</p>
  {/if}
  {#each chips as chip (chip.index)}
    <section class="chip">
      {#if chips.length > 1}
        <h4 class="chip-title">SID {chip.index + 1}</h4>
      {/if}

      {#each chip.voices as v (v.index)}
        {@const lv = level(v)}
        <!-- One strip per voice. `on` is the gate: the single clearest signal of
             whether this voice is currently making a sound. -->
        <div class="voice" class:on={isActive(v)}>
          <span class="num">{v.index + 1}</span>

          <span class="note" title="{v.freq} → {v.hz.toFixed(2)} Hz">
            {noteOf(v)}
            <!-- Always rendered, even when empty: it holds a line of the strip's
                 height, and letting it collapse resized every row below it
                 dozens of times a second (see voice-monitor.svelte.test.ts). -->
            <small>{isActive(v) ? `${hz(v.hz)}Hz` : ""}</small>
          </span>

          <!-- Combined waveforms are legal and common, so these are flags, not
               a single selection. None lit = silence, whatever the gate says. -->
          <span class="waves">
            {#each WAVES as w (w)}
              <i class="w" class:lit={v.waveforms.includes(w)} title={w}>{GLYPH[w]}</i>
            {/each}
          </span>

          <!-- ADSR as four bars: the envelope shape at a glance, which is what
               distinguishes a pluck from a pad without reading numbers. -->
          <span
            class="adsr"
            title="attack {v.attack} decay {v.decay} sustain {v.sustain} release {v.release}"
          >
            {#each [v.attack, v.decay, v.sustain, v.release] as n, i (i)}
              <i class="seg"><b style:height={pct(n, 15)}></b></i>
            {/each}
          </span>

          <span class="flags">
            {#if v.waveforms.includes("pulse")}
              <i class="flag pw" title="pulse width {v.pulseWidth}">
                <b style:width={pct(v.pulseWidth, 4095)}></b>
              </i>
            {/if}
            {#if v.ring}<i class="flag tag" title="ring modulation">R</i>{/if}
            {#if v.sync}<i class="flag tag" title="oscillator sync">S</i>{/if}
            {#if v.filtered}<i class="flag tag on" title="routed through the filter">F</i>{/if}
            {#if v.test}<i class="flag tag" title="test bit (oscillator held)">T</i>{/if}
          </span>

          <span class="level"><b style:width={pct(lv, 1)}></b></span>
        </div>
      {/each}

      <!-- Chip-wide: the filter every routed voice passes through, and the
           master volume — the register digi tunes hammer for sampled drums. -->
      <div class="filter">
        <span class="lbl">filter</span>
        <span class="modes">
          <i class:lit={chip.lowPass}>LP</i>
          <i class:lit={chip.bandPass}>BP</i>
          <i class:lit={chip.highPass}>HP</i>
        </span>
        <span class="bar" title="cutoff {chip.cutoff}"
          ><b style:width={pct(chip.cutoff, 2047)}></b></span
        >
        <span class="res" title="resonance {chip.resonance}">Q{chip.resonance}</span>
        <span class="lbl">vol</span>
        <span class="bar vol" title="master volume {chip.volume}">
          <b style:width={pct(chip.volume, 15)}></b>
        </span>
        {#if chip.voice3Off}<span class="res" title="voice 3 muted from output">3·off</span>{/if}
      </div>
    </section>
  {/each}
</div>

<style>
  .vm {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px 12px;
    font-family: var(--font-retro, monospace);
    font-size: 12px;
    color: var(--surface-fg);
  }
  .idle {
    color: var(--muted);
  }
  .chip {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .chip-title {
    margin: 2px 0;
    font-size: 11px;
    color: var(--muted);
  }

  .voice {
    display: grid;
    grid-template-columns: 16px 74px 62px 30px 1fr 56px;
    align-items: center;
    gap: 8px;
    padding: 3px 6px;
    background: var(--panel-hi);
    border: 1px solid var(--border);
    /* A gated-off voice stays visible but recedes — the eye should land on
       what's sounding. */
    opacity: 0.45;
    transition: opacity 90ms linear;
  }
  .voice.on {
    opacity: 1;
  }
  .num {
    color: var(--muted);
  }
  .note {
    display: flex;
    flex-direction: column;
    line-height: 1.15;
    /* The note name changes width (C-4 vs C#4); a fixed column stops the Hz
       readout under it sliding sideways on every note. */
    font-variant-numeric: tabular-nums;
  }
  .note small {
    font-size: 9px;
    color: var(--muted);
    /* Reserve the line whether or not there's a reading. An empty flex item is
       zero-height, which shrank the strip and shifted the whole list. */
    min-height: 1.15em;
    font-variant-numeric: tabular-nums;
  }

  .waves {
    display: flex;
    gap: 2px;
  }
  .w {
    font-style: normal;
    color: var(--muted);
    opacity: 0.35;
  }
  .w.lit {
    color: var(--accent);
    opacity: 1;
  }

  .adsr {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 14px;
  }
  .adsr .seg {
    display: block;
    width: 5px;
    height: 100%;
    background: color-mix(in srgb, var(--border) 70%, transparent);
    position: relative;
  }
  .adsr .seg b {
    position: absolute;
    inset: auto 0 0 0;
    background: var(--surface-fg);
  }

  .flags {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .flag {
    font-style: normal;
    font-size: 9px;
  }
  .tag {
    padding: 0 3px;
    color: var(--muted);
    border: 1px solid var(--border);
  }
  .tag.on {
    color: var(--accent);
    border-color: var(--accent);
  }
  .pw {
    display: block;
    width: 42px;
    height: 4px;
    background: color-mix(in srgb, var(--border) 70%, transparent);
  }
  .pw b {
    display: block;
    height: 100%;
    background: var(--muted);
    /* Pulse-width modulation is a per-frame sweep on many tunes; easing it over
       roughly one sample interval reads as a slide rather than a stutter. Same
       treatment the level meter already gets. */
    transition: width 60ms linear;
  }

  .level {
    display: block;
    height: 6px;
    background: color-mix(in srgb, var(--border) 70%, transparent);
  }
  .level b {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 60ms linear;
  }

  .filter {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 6px;
    font-size: 10px;
    color: var(--muted);
  }
  .lbl {
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .modes {
    display: flex;
    gap: 3px;
  }
  .modes i {
    font-style: normal;
    opacity: 0.35;
  }
  .modes i.lit {
    color: var(--accent);
    opacity: 1;
  }
  .bar {
    flex: 1;
    height: 4px;
    background: color-mix(in srgb, var(--border) 70%, transparent);
  }
  .bar b {
    display: block;
    height: 100%;
    background: var(--muted);
    /* Filter sweeps move every frame — same reasoning as the pulse-width bar. */
    transition: width 60ms linear;
  }
  .bar.vol {
    flex: 0 0 40px;
  }

  @media (max-width: 640px) {
    .voice {
      grid-template-columns: 14px 62px 54px 26px 1fr 40px;
      gap: 5px;
    }
  }
</style>
