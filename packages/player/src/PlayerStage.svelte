<script lang="ts">
	// The player "stage": a partial header of tabs (pattern / samples / viz) over
	// a content area that switches between the scrolling pattern grid + scope, the
	// instrument/sample name lists, and the visualizers. The "viz" tab holds its
	// own sub-selector for the equalizer bars and the Amiga boing ball. Fills its
	// container's height. Pair it with <Transport/>. Shared by tracker + party.
	import BoingBall from './BoingBall.svelte';
	import CopperBars from './CopperBars.svelte';
	import Equalizer from './Equalizer.svelte';
	import GlowWave from './GlowWave.svelte';
	import PatternView from './PatternView.svelte';
	import { playback } from './player.svelte';
	import Plasma from './Plasma.svelte';
	import Scope from './Scope.svelte';
	import Starfield from './Starfield.svelte';
	import VuMeters from './VuMeters.svelte';

	type VizMode = 'bars' | 'wave' | 'vu' | 'stars' | 'copper' | 'plasma' | 'ball';
	const VIZ: VizMode[] = ['bars', 'wave', 'vu', 'stars', 'copper', 'plasma', 'ball'];

	let { tab = $bindable<'pattern' | 'samples' | 'viz'>('pattern') } = $props();
	// Which visualizer the "viz" tab shows. Persists across tab switches.
	let vizMode = $state<VizMode>('bars');

	const energy = $derived(playback.vu.length ? Math.max(...playback.vu) : 0);
	const playing = $derived(playback.playing && !playback.paused);
	const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

	// Module format (file extension) — drives the boing ball's pixelation.
	const format = $derived.by(() => {
		const f = playback.current?.filename ?? '';
		const dot = f.lastIndexOf('.');
		return dot >= 0 ? f.slice(dot + 1).toLowerCase() : '';
	});
</script>

<div class="stage">
	<div class="tabs">
		<button class:on={tab === 'pattern'} onclick={() => (tab = 'pattern')}>pattern</button>
		<button class:on={tab === 'samples'} onclick={() => (tab = 'samples')}>samples</button>
		<button class:on={tab === 'viz'} onclick={() => (tab = 'viz')}>viz</button>
	</div>
	<div class="wrap">
		{#if tab === 'pattern'}
			<div class="scope-strip"><Scope /></div>
			<div class="pfill"><PatternView /></div>
		{:else if tab === 'viz'}
			<div class="viz">
				<div class="vizpick">
					{#each VIZ as m (m)}
						<button class:on={vizMode === m} onclick={() => (vizMode = m)}>{m}</button>
					{/each}
				</div>
				<div class="vizbody">
					{#if vizMode === 'bars'}
						<Equalizer active={playing} />
					{:else if vizMode === 'wave'}
						<GlowWave active={playing} />
					{:else if vizMode === 'vu'}
						<VuMeters active={playing} />
					{:else if vizMode === 'stars'}
						<Starfield active={playing} />
					{:else if vizMode === 'copper'}
						<CopperBars active={playing} />
					{:else if vizMode === 'plasma'}
						<Plasma active={playing} />
					{:else}
						<BoingBall energy={playing ? energy : 0} {format} />
					{/if}
				</div>
			</div>
		{:else}
			<div class="samples">
				{#if (playback.song?.instruments?.length ?? 0) > 0}
					<h4>Instruments</h4>
					<ol>
						{#each playback.song?.instruments ?? [] as name, i (i)}
							<li><span class="sx">{hex2(i + 1)}</span><span class="sn">{name || '—'}</span></li>
						{/each}
					</ol>
				{/if}
				<h4>Samples</h4>
				<ol>
					{#each playback.song?.samples ?? [] as name, i (i)}
						<li><span class="sx">{hex2(i + 1)}</span><span class="sn">{name || '—'}</span></li>
					{:else}
						<li class="none">no samples</li>
					{/each}
				</ol>
			</div>
		{/if}
	</div>
</div>

<style>
	.stage {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--surface, var(--panel));
	}
	.tabs {
		flex: 0 0 auto;
		display: flex;
		gap: 4px;
		padding: 6px 8px;
		border-bottom: 1px solid var(--surface-line-2, var(--border));
	}
	.tabs button {
		padding: 4px 10px;
		font-size: 12px;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--panel-hi);
		color: var(--text);
		cursor: pointer;
	}
	.tabs button.on {
		color: var(--bg);
		background: var(--accent);
		border-color: var(--accent);
	}
	.wrap {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.scope-strip {
		flex: 0 0 auto;
		height: 64px;
		border-bottom: 1px solid var(--surface-line-2, var(--border));
	}
	.pfill {
		flex: 1;
		min-height: 0;
	}
	.viz {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.vizpick {
		flex: 0 0 auto;
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		padding: 6px 8px;
		border-bottom: 1px solid var(--surface-line-2, var(--border));
	}
	.vizpick button {
		padding: 2px 9px;
		font-size: 11px;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--panel-hi);
		color: var(--muted);
		cursor: pointer;
	}
	.vizpick button.on {
		color: var(--bg);
		background: var(--accent);
		border-color: var(--accent);
	}
	.vizbody {
		flex: 1;
		min-height: 0;
	}
	.samples {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding: 8px 12px 48px;
		font-family: var(--tracker-font, var(--font-mono-retro, ui-monospace, monospace));
		font-size: 16px;
		-webkit-overflow-scrolling: touch;
	}
	.samples h4 {
		color: var(--accent);
		margin: 12px 0 6px;
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.samples ol {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.samples li {
		display: flex;
		gap: 10px;
		padding: 2px 0;
		border-bottom: 1px solid var(--surface-line, var(--border));
	}
	.samples .sx {
		color: var(--surface-fg-dim, var(--muted));
		flex: 0 0 auto;
		width: 24px;
	}
	.samples .sn {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.samples .none {
		color: var(--muted);
	}
</style>
