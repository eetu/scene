<script lang="ts">
	// Shared transport bar: seek strip + prev/play/next/shuffle/repeat, the
	// now-playing title/artist, and time + order/pattern/row readouts. Drives the
	// `playback` store. Layout-agnostic (no fixed positioning) — the host app
	// places it (tracker docks it at the bottom; party shows it inline).
	import { Pause, Play, Repeat, Shuffle, SkipBack, SkipForward } from '@lucide/svelte';

	import {
		playback,
		playNext,
		playPrev,
		seekSeconds,
		toggleRepeat,
		toggleShuffle,
		transportToggle
	} from './player.svelte';

	let {
		onOpenView,
		showPos = true
	}: {
		/** If given, the title/artist becomes a button that calls this (e.g. open a
		 *  full-screen pattern view). Otherwise it's static text. */
		onOpenView?: () => void;
		/** Show the order/pattern/row teaser (hidden on narrow screens anyway). */
		showPos?: boolean;
	} = $props();

	const hasPrev = $derived(playback.queueIndex > 0);
	const hasNext = $derived(
		playback.queueIndex >= 0 &&
			(playback.shuffle
				? playback.queueLength > 1
				: playback.queueIndex + 1 < playback.queueLength)
	);

	function fmtTime(sec: number): string {
		if (!sec || !isFinite(sec)) return '0:00';
		const m = Math.floor(sec / 60);
		const s = Math.floor(sec % 60);
		return `${m}:${s.toString().padStart(2, '0')}`;
	}

	function seekClick(e: MouseEvent) {
		if (!playback.duration) return;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
		seekSeconds(frac * playback.duration);
	}
</script>

{#if playback.current}
	<div class="transport">
		<button class="seek" onclick={seekClick} aria-label="seek" title="seek">
			<div
				class="seek-fill"
				style:width="{playback.duration ? (playback.position / playback.duration) * 100 : 0}%"
			></div>
		</button>
		<div class="t-controls">
			<button class="t-btn" onclick={playPrev} disabled={!hasPrev} aria-label="previous">
				<SkipBack size={16} />
			</button>
			<button
				class="t-btn t-play"
				onclick={transportToggle}
				aria-label={playback.playing && !playback.paused ? 'pause' : 'play'}
			>
				{#if playback.playing && !playback.paused}<Pause size={16} />{:else}<Play size={16} />{/if}
			</button>
			<button class="t-btn" onclick={playNext} disabled={!hasNext} aria-label="next">
				<SkipForward size={16} />
			</button>
			{#if onOpenView}
				<button class="t-info" onclick={onOpenView} title="open player view">
					<span class="t-title">{playback.current.title || playback.current.filename}</span>
					<span class="t-meta">
						{playback.current.group ?? ''}{playback.current.artist
							? ` · ${playback.current.artist}`
							: ''}
						{#if playback.error}· <span class="t-err">{playback.error}</span>{/if}
					</span>
				</button>
			{:else}
				<div class="t-info">
					<span class="t-title">{playback.current.title || playback.current.filename}</span>
					<span class="t-meta">
						{playback.current.group ?? ''}{playback.current.artist
							? ` · ${playback.current.artist}`
							: ''}
						{#if playback.error}· <span class="t-err">{playback.error}</span>{/if}
					</span>
				</div>
			{/if}
			<button
				class="t-btn t-mode"
				class:on={playback.shuffle}
				onclick={toggleShuffle}
				aria-label="shuffle"
				title="shuffle"
			>
				<Shuffle size={16} />
			</button>
			<button
				class="t-btn t-mode"
				class:on={playback.repeat}
				onclick={toggleRepeat}
				aria-label="repeat"
				title="repeat (loop)"
			>
				<Repeat size={16} />
			</button>
			<div class="t-time">
				{playback.duration
					? `${fmtTime(playback.position)} / ${fmtTime(playback.duration)}`
					: fmtTime(playback.position)}
			</div>
			{#if showPos}
				<div class="t-pos">
					ord <span class="num">{playback.order}</span> · pat
					<span class="num">{playback.pattern}</span> · row
					<span class="num">{playback.row}</span>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.transport {
		display: flex;
		flex-direction: column;
		background: var(--panel);
		border-top: 1px solid var(--border);
	}
	.seek {
		display: block;
		width: 100%;
		height: 8px;
		padding: 0;
		border: none;
		border-radius: 0;
		background: var(--panel-hi);
		cursor: pointer;
	}
	.seek-fill {
		height: 100%;
		background: var(--accent);
		pointer-events: none;
	}
	.t-controls {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 8px 14px;
	}
	.t-btn {
		flex: 0 0 auto;
		min-width: 40px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 5px 10px;
		background: var(--panel-hi);
		border: 1px solid var(--border);
		border-radius: 4px;
		color: var(--accent);
		cursor: pointer;
		font: inherit;
	}
	.t-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.t-btn.on {
		color: var(--bg);
		background: var(--accent);
		border-color: var(--accent);
	}
	/* Play/pause is the primary control — accent-filled and a touch wider. */
	.t-play {
		color: var(--bg);
		background: var(--accent);
		border-color: var(--accent);
		min-width: 48px;
	}
	/* Shuffle/repeat are secondary toggles — ghost buttons, accent only when on. */
	.t-mode {
		min-width: 0;
		background: none;
		border-color: transparent;
		color: var(--muted);
	}
	.t-mode.on {
		color: var(--accent);
		background: none;
		border-color: transparent;
	}
	.t-btn :global(svg) {
		display: block;
		stroke-width: 2.5;
		stroke-linecap: square;
		stroke-linejoin: miter;
	}
	.t-info {
		flex: 1;
		min-width: 0;
		background: none;
		border: none;
		padding: 0;
		text-align: left;
		cursor: pointer;
		color: inherit;
	}
	.t-title {
		display: block;
		font-family: var(--font-retro, ui-monospace, monospace);
		font-size: 13px;
		color: var(--accent);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.t-meta {
		display: block;
		margin-top: 3px;
		font-family: var(--font-retro, ui-monospace, monospace);
		font-size: 11px;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.t-err {
		color: var(--halo-error);
	}
	.t-time {
		flex: 0 0 auto;
		color: var(--muted);
		font-size: 13px;
		font-family: var(--font-mono-retro, ui-monospace, monospace);
		font-variant-numeric: tabular-nums;
	}
	.t-pos {
		flex: 0 0 auto;
		color: var(--muted);
		font-size: 12px;
		font-family: var(--font-mono-retro, ui-monospace, monospace);
		font-variant-numeric: tabular-nums;
	}
	.num {
		display: inline-block;
		min-width: 2ch;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	@media (max-width: 640px) {
		.t-pos {
			display: none;
		}
		.t-controls {
			flex-wrap: wrap;
			gap: 6px;
			row-gap: 8px;
			padding: 8px 8px;
		}
		.t-info {
			order: -1;
			flex-basis: 100%;
		}
		.t-controls .t-btn {
			flex: 1;
			min-width: 0;
			padding: 8px 0;
		}
		.t-time {
			order: 1;
			align-self: center;
			padding-left: 4px;
		}
	}
</style>
