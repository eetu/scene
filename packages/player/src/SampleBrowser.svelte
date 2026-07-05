<script lang="ts">
  // The samples view (FT2/IT tradition): a narrow list of instruments + samples
  // on the left, and a detail pane on the right (name, waveform, jam keyboard).
  // Self-contained over the shared `playback` store so BOTH the shared
  // PlayerStage and the tracker's own player page render the identical UI — the
  // one place this lives, to avoid the "looks similar but isn't" drift.
  //
  // Selection is plain UI state (always works); the waveform + jam keyboard gate
  // on the custom-build capabilities (playback.canReadSamples / canJam), so on
  // the stock build the list still works and the panels degrade to a note.
  import JamKeyboard from "./JamKeyboard.svelte";
  import { exportSampleWav, playback, readSample, type SampleData } from "./player.svelte";
  import SampleWave from "./SampleWave.svelte";

  const instruments = $derived(playback.song?.instruments ?? []);
  const samples = $derived(playback.song?.samples ?? []);
  const hasInstruments = $derived(instruments.length > 0);

  let selSample = $state(1); // 1-based, drives the waveform pane
  let selInst = $state(0); // 0-based instrument selection
  let selKind = $state<"smp" | "inst">("smp"); // which list was last picked

  // Reset selection when the module changes.
  $effect(() => {
    void playback.song;
    selSample = 1;
    selInst = 0;
    selKind = hasInstruments ? "inst" : "smp";
  });

  // The keyboard jams the selected SAMPLE's PCM directly (Web Audio), so what you
  // see is what you play — no instrument/sample index juggling.
  const selSampleName = $derived(samples[selSample - 1] || "");
  const jamLabel = $derived(selSampleName || `smp ${hex2(selSample)}`);

  // Fetch the selected sample's data once (waveform + properties); pass to the
  // wave component so it doesn't re-fetch.
  let sampleData = $state<SampleData | null>(null);
  $effect(() => {
    const idx = selSample;
    if (!playback.canReadSamples || samples.length === 0) {
      sampleData = null;
      return;
    }
    let stale = false;
    void readSample(idx).then((d) => {
      if (!stale) sampleData = d;
    });
    return () => {
      stale = true;
    };
  });

  const info = $derived(sampleData?.info ?? null);
  const secs = $derived(info && info.rate ? info.length / info.rate : 0);
  const loopType = $derived.by(() => {
    const f = info?.flags ?? 0;
    if (!(f & 1)) return "none";
    return f & 2 ? "ping-pong" : "forward";
  });

  // Function declaration (hoisted) — used by the deriveds above.
  function hex2(n: number): string {
    return n.toString(16).toUpperCase().padStart(2, "0");
  }

  // Up/down navigate the active list (samples, or instruments if one's picked).
  // Left/right track-switch is handled globally by the app; it suppresses itself
  // while a jam key is held (playback.jamHeld) so you can browse mid-jam.
  function onNavKey(e: KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    const dir = e.key === "ArrowDown" ? 1 : -1;
    if (selKind === "inst" && hasInstruments) {
      selInst = Math.max(0, Math.min(instruments.length - 1, selInst + dir));
    } else if (samples.length) {
      selSample = Math.max(1, Math.min(samples.length, selSample + dir));
      selKind = "smp";
    }
    e.preventDefault();
  }
</script>

<svelte:window onkeydown={onNavKey} />

<div class="samples">
  <!-- Left: narrow list(s) — instruments (if any) + samples. -->
  <div class="slist">
    {#if hasInstruments}
      <h4>Instruments</h4>
      <ol>
        {#each instruments as name, i (i)}
          <li>
            <button
              type="button"
              class="row"
              class:sel={selKind === "inst" && selInst === i}
              onclick={() => {
                selInst = i;
                selKind = "inst";
              }}
            >
              <span class="sx">{hex2(i + 1)}</span><span class="sn">{name || "—"}</span>
            </button>
          </li>
        {/each}
      </ol>
    {/if}
    <h4>Samples</h4>
    <ol>
      {#each samples as name, i (i)}
        <li>
          <button
            type="button"
            class="row"
            class:sel={selKind === "smp" && selSample === i + 1}
            onclick={() => {
              selSample = i + 1;
              selKind = "smp";
            }}
          >
            <span class="sx">{hex2(i + 1)}</span><span class="sn">{name || "—"}</span>
          </button>
        </li>
      {:else}
        <li class="none">no samples</li>
      {/each}
    </ol>
  </div>

  <!-- Right: detail pane for the selected sample. -->
  <div class="sdetail">
    {#if samples.length > 0}
      <div class="dhead">
        <span class="dx">{hex2(selSample)}</span>
        <span class="dn">{selSampleName || "(unnamed sample)"}</span>
        {#if playback.canReadSamples && info && info.length > 0}
          <label class="oneshot" title="play once — ignore the sample's loop">
            <input type="checkbox" bind:checked={playback.jamOneShot} />
            1-shot
          </label>
          <button
            type="button"
            class="wav"
            title="download this sample as WAV (original format)"
            onclick={() => exportSampleWav(selSample, selSampleName || `sample-${hex2(selSample)}`)}
          >
            ⬇ WAV
          </button>
        {/if}
      </div>

      {#if playback.canReadSamples}
        <SampleWave data={sampleData} index={selSample} />

        {#if info && info.length > 0}
          <div class="props">
            <dl>
              <dt>length</dt>
              <dd>{info.length} · {secs.toFixed(2)}s</dd>
              <dt>rate</dt>
              <dd>{info.rate} Hz</dd>
              <dt>format</dt>
              <dd>{info.bits}-bit {info.channels > 1 ? "stereo" : "mono"}</dd>
              <dt>volume</dt>
              <dd>{Math.round((info.volume / 256) * 100)}%</dd>
            </dl>
            <dl>
              <dt>loop</dt>
              <dd>{loopType}{info.flags & 1 ? ` ${info.loopStart}–${info.loopEnd}` : ""}</dd>
              {#if info.flags & 4}
                <dt>sustain</dt>
                <dd>{info.sustainStart}–{info.sustainEnd}</dd>
              {/if}
              <dt>finetune</dt>
              <dd>{info.finetune}</dd>
              <dt>rel. note</dt>
              <dd>{info.relativeNote > 0 ? "+" : ""}{info.relativeNote}</dd>
              {#if info.panning >= 0}
                <dt>panning</dt>
                <dd>{Math.round((info.panning / 256) * 100)}%</dd>
              {/if}
            </dl>
          </div>
        {/if}

        <JamKeyboard sample={selSample} label={jamLabel} />
      {:else}
        <p class="dnote">waveform needs the custom libopenmpt build</p>
      {/if}
    {:else}
      <p class="dnote">no samples in this module</p>
    {/if}
  </div>
</div>

<style>
  /* FT2/IT layout: narrow list column on the left, sample detail on the right. */
  .samples {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: row;
    font-family: var(--tracker-font, var(--font-mono-retro, ui-monospace, monospace));
    font-size: 15px;
  }
  .slist {
    flex: 0 0 200px;
    min-width: 0;
    overflow: auto;
    padding: 4px 6px 64px;
    border-right: 1px solid var(--surface-line-2, var(--surface-line, var(--border)));
    -webkit-overflow-scrolling: touch;
  }
  .sdetail {
    flex: 1;
    min-width: 0;
    overflow: auto;
    padding: 10px 12px 64px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    -webkit-overflow-scrolling: touch;
  }
  .dhead {
    display: flex;
    gap: 10px;
    align-items: baseline;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--surface-line-2, var(--surface-line, var(--border)));
  }
  .dhead .dx {
    color: var(--accent);
    font-weight: 700;
  }
  .dhead .dn {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dhead .oneshot {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
  }
  .dhead .oneshot input {
    accent-color: var(--accent);
  }
  .dhead .wav {
    flex: 0 0 auto;
    padding: 2px 8px;
    font: inherit;
    font-size: 11px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--panel-hi, var(--panel));
    color: var(--text);
    cursor: pointer;
  }
  .dhead .wav:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  /* Two grouped columns (Sample specs | Playback/loop) sized to content so they
     sit close together, wrapping to one column only when there's no room. */
  .props {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 40px;
    font-size: 12px;
  }
  .props dl {
    display: grid;
    grid-template-columns: max-content max-content;
    gap: 2px 10px;
    margin: 0;
    align-content: start;
  }
  .props dt {
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .props dd {
    margin: 0;
  }
  .dnote {
    color: var(--muted);
    font-size: 12px;
    margin: 4px 0;
  }
  @media (max-width: 560px) {
    .samples {
      flex-direction: column;
    }
    .slist {
      flex: 0 0 30%;
      padding-bottom: 12px;
      border-right: none;
      border-bottom: 1px solid var(--surface-line-2, var(--surface-line, var(--border)));
    }
    .props {
      font-size: 11px;
    }
  }
  h4 {
    color: var(--accent);
    margin: 10px 0 4px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  h4:first-child {
    margin-top: 2px;
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: flex;
    padding: 0;
    border-bottom: 1px solid var(--surface-line, var(--border));
  }
  .row {
    display: flex;
    gap: 10px;
    align-items: center;
    width: 100%;
    padding: 3px 4px;
    border: 0;
    border-radius: 3px;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .row:hover {
    background: var(--panel-hi, var(--panel));
  }
  .row.sel {
    background: color-mix(in srgb, var(--accent) 22%, transparent);
  }
  .row.sel .sx {
    color: var(--accent);
  }
  .sx {
    color: var(--surface-fg-dim, var(--muted));
    flex: 0 0 auto;
    width: 24px;
  }
  .sn {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .none {
    color: var(--muted);
    padding: 4px;
  }
</style>
