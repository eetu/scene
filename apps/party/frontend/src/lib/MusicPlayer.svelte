<script lang="ts">
	// Music player surface: the tabbed stage (pattern / samples / ball) + the
	// shared transport bar, both from @scene/player. Fills the available height.
	import { PlayerStage, Transport } from '@scene/player';

	// The pattern grid uses the Amiga TopazPlus font only for Amiga-platform
	// productions; PC tracker music (FastTracker/ScreamTracker here) uses the
	// CP437 VGA pixel font.
	let { platform = 'pc' }: { platform?: string } = $props();
</script>

<div
	class="player"
	style:--tracker-font={platform === 'amiga' ? 'var(--font-amiga)' : 'var(--font-dos)'}
>
	<div class="stage"><PlayerStage /></div>
	<Transport />
</div>

<style>
	.player {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		gap: 8px;
	}
	.stage {
		flex: 1;
		min-height: 0;
		border: 1px solid var(--border);
		border-radius: 6px;
		overflow: hidden;
	}
</style>
