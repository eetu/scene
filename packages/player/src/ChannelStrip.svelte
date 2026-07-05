<script lang="ts">
  // Per-channel mute/solo strip for the pattern editor. Applies to the LIVE
  // module (chan_mute), so the song's own render drops muted channels. Shown only
  // on the custom build (canMuteChannels) with >1 channel; party's stock build
  // hides it. View-independent — sits above whichever pattern grid is active.
  import { clearChannelMutes, playback, soloChannel, toggleChannelMute } from "./player.svelte";

  const channels = $derived(playback.song?.channels ?? []);
  const mutes = $derived(playback.channelMutes);
  const anyMuted = $derived(mutes.some(Boolean));

  // A channel is "soloed" when it's the only audible one (every other muted).
  function isSolo(i: number): boolean {
    return anyMuted && !mutes[i] && channels.every((_c, j) => j === i || mutes[j]);
  }
</script>

{#if playback.canMuteChannels && channels.length > 1}
  <div class="strip" role="group" aria-label="channel mute and solo">
    {#each channels as ch, i (i)}
      <div class="chan" class:muted={mutes[i]} title={ch || `channel ${i + 1}`}>
        <span class="num">{String(i + 1).padStart(2, "0")}</span>
        <div class="btns">
          <button
            class="ms m"
            class:on={mutes[i]}
            aria-pressed={mutes[i]}
            title="mute channel {i + 1}"
            onclick={() => toggleChannelMute(i)}>M</button
          >
          <button
            class="ms s"
            class:on={isSolo(i)}
            aria-pressed={isSolo(i)}
            title="solo channel {i + 1}"
            onclick={() => soloChannel(i)}>S</button
          >
        </div>
      </div>
    {/each}
    <button
      class="clear"
      disabled={!anyMuted}
      title="unmute all"
      onclick={() => clearChannelMutes()}>all</button
    >
  </div>
{/if}

<style>
  .strip {
    display: flex;
    align-items: stretch;
    gap: 4px;
    padding: 4px 6px;
    overflow-x: auto;
    background: var(--surface-bar);
    border-bottom: 1px solid var(--surface-line-2);
    scrollbar-width: thin;
  }
  .chan {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 2px 3px;
    border: 1px solid var(--surface-line-2);
    border-radius: 3px;
    background: var(--surface-2);
  }
  .chan.muted {
    opacity: 0.6;
  }
  .num {
    font-family: var(--font-mono-retro);
    font-size: 11px;
    color: var(--surface-fg);
    line-height: 1;
  }
  .btns {
    display: flex;
    gap: 2px;
  }
  .ms {
    width: 18px;
    height: 16px;
    padding: 0;
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
    border: 1px solid var(--surface-line);
    border-radius: 2px;
    background: var(--surface);
    color: var(--surface-fg-dim);
    cursor: pointer;
  }
  .ms:hover {
    color: var(--surface-fg-active);
  }
  .ms.m.on {
    background: color-mix(in srgb, #ff4136 70%, var(--surface));
    border-color: #ff4136;
    color: #fff;
  }
  .ms.s.on {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--bg);
  }
  .clear {
    flex: 0 0 auto;
    align-self: center;
    padding: 2px 8px;
    font-size: 11px;
    border: 1px solid var(--surface-line-2);
    border-radius: 3px;
    background: var(--surface-2);
    color: var(--surface-fg);
    cursor: pointer;
  }
  .clear:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .clear:not(:disabled):hover {
    color: var(--surface-fg-active);
  }
</style>
