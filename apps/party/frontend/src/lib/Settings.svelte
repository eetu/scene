<script lang="ts">
	// Header settings: a gear button (always visible) opening a modal with the
	// theme selector — mirrors tracker's settings. Self-contained; drop <Settings/>
	// into any header.
	import { Monitor, Moon, Settings as Gear, Sun } from '@lucide/svelte';

	import { setTheme, theme } from '@scene/design';

	let open = $state(false);

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') open = false;
	}
</script>

<svelte:window onkeydown={onKey} />

<button class="gear" onclick={() => (open = true)} title="Settings" aria-label="Settings">
	<Gear size={18} />
</button>

{#if open}
	<div class="modal-bg">
		<button class="modal-scrim" aria-label="close" onclick={() => (open = false)}></button>
		<div class="modal" role="dialog" aria-modal="true" aria-label="settings">
			<h3>settings</h3>
			<div class="setting">
				<span class="setting-label">theme</span>
				<div class="seg">
					<button class:on={theme.mode === 'light'} onclick={() => setTheme('light')}>
						<Sun size={15} /> light
					</button>
					<button class:on={theme.mode === 'dark'} onclick={() => setTheme('dark')}>
						<Moon size={15} /> dark
					</button>
					<button class:on={theme.mode === 'auto'} onclick={() => setTheme('auto')}>
						<Monitor size={15} /> auto
					</button>
				</div>
			</div>
			<div class="modal-actions">
				<button class="close" onclick={() => (open = false)}>close</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.gear {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--panel);
		color: var(--text);
		cursor: pointer;
	}
	.gear:hover {
		border-color: var(--accent);
	}
	.modal-bg {
		position: fixed;
		inset: 0;
		z-index: 20;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 16px;
	}
	.modal-scrim {
		position: absolute;
		inset: 0;
		border: none;
		background: rgba(0, 0, 0, 0.5);
		cursor: pointer;
	}
	.modal {
		position: relative;
		z-index: 1;
		width: 100%;
		max-width: 420px;
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.modal h3 {
		margin: 0;
		font-size: 14px;
	}
	.setting {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.setting-label {
		font-size: 12px;
		color: var(--muted);
	}
	.seg {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.seg button {
		flex: 1;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 8px 10px;
		white-space: nowrap;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--panel-hi);
		color: var(--text);
		cursor: pointer;
	}
	.seg button:hover {
		border-color: var(--accent);
	}
	.seg button.on {
		color: var(--bg);
		background: var(--accent);
		border-color: var(--accent);
	}
	.modal-actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 4px;
	}
	.modal-actions .close {
		padding: 6px 14px;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--panel-hi);
		color: var(--text);
		cursor: pointer;
	}
	.modal-actions .close:hover {
		border-color: var(--accent);
	}
</style>
