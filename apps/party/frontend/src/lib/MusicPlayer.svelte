<script lang="ts">
	// Music player surface: the scrolling pattern grid + output scope + a
	// transport bar. Drives the shared `playback` store from @scene/player.
	import { Pause, Play, Repeat, Shuffle, SkipBack, SkipForward, Square } from '@lucide/svelte';
	import {
		PatternView,
		playback,
		playNext,
		playPrev,
		Scope,
		seekSeconds,
		stop,
		toggleRepeat,
		toggleShuffle,
		transportToggle
	} from '@scene/player';

	// The pattern grid uses the Amiga TopazPlus font only for Amiga-platform
	// productions; PC tracker music (FastTracker/ScreamTracker here) uses the
	// CP437 VGA pixel font.
	let { platform = 'pc' }: { platform?: string } = $props();

	function fmt(s: number): string {
		if (!Number.isFinite(s) || s < 0) return '0:00';
		const m = Math.floor(s / 60);
		const ss = Math.floor(s % 60);
		return `${m}:${ss.toString().padStart(2, '0')}`;
	}

	const playing = $derived(playback.playing && !playback.paused);
</script>

<div
	class="player"
	style:--tracker-font={platform === 'amiga' ? 'var(--font-amiga)' : 'var(--font-dos)'}
>
	<div class="pattern"><PatternView /></div>
	<div class="scope"><Scope /></div>

	<div class="transport">
		<div class="buttons">
			<button onclick={playPrev} title="Previous" aria-label="Previous"><SkipBack size={18} /></button>
			<button class="big" onclick={transportToggle} title="Play/pause" aria-label="Play/pause">
				{#if playing}<Pause size={20} />{:else}<Play size={20} />{/if}
			</button>
			<button onclick={playNext} title="Next" aria-label="Next"><SkipForward size={18} /></button>
			<button onclick={stop} title="Stop" aria-label="Stop"><Square size={16} /></button>
			<button class:on={playback.shuffle} onclick={toggleShuffle} title="Shuffle" aria-label="Shuffle">
				<Shuffle size={16} />
			</button>
			<button class:on={playback.repeat} onclick={toggleRepeat} title="Repeat" aria-label="Repeat">
				<Repeat size={16} />
			</button>
		</div>

		<input
			class="seek"
			type="range"
			min="0"
			max={Math.max(1, playback.duration)}
			step="0.5"
			value={playback.position}
			oninput={(e) => seekSeconds(Number(e.currentTarget.value))}
			aria-label="Seek"
		/>
		<span class="time">{fmt(playback.position)} / {fmt(playback.duration)}</span>
	</div>

	{#if playback.error}<p class="err">playback error: {playback.error}</p>{/if}
</div>

<style>
	.player {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-height: 0;
	}
	.pattern {
		height: 320px;
		border: 1px solid var(--border);
		border-radius: 6px;
		overflow: hidden;
	}
	.scope {
		height: 48px;
		border: 1px solid var(--border);
		border-radius: 6px;
		overflow: hidden;
	}
	.transport {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}
	.buttons {
		display: flex;
		gap: 4px;
	}
	button {
		display: grid;
		place-items: center;
		width: 34px;
		height: 34px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--panel);
		color: var(--text);
		cursor: pointer;
	}
	button:hover {
		border-color: var(--accent);
	}
	button.big {
		width: 42px;
		height: 42px;
		background: var(--accent);
		color: #0f0f0f;
		border-color: var(--accent);
	}
	button.on {
		color: var(--accent);
		border-color: var(--accent);
	}
	.seek {
		flex: 1;
		min-width: 160px;
		accent-color: var(--accent);
	}
	.time {
		font-family: var(--tracker-font, var(--font-dos));
		color: var(--muted);
		font-size: 13px;
	}
	.err {
		color: #ff4136;
		margin: 0;
		font-size: 13px;
	}
</style>
