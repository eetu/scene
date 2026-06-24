<script lang="ts">
	// DOS emulator surface (js-dos v8, self-hosted under /vendor/js-dos/). The
	// runtime + WASM (~1.4 MB+) load only when the user clicks Launch — never on
	// page view. Everything is same-origin, so the strict CSP is unchanged.
	import { onDestroy } from 'svelte';

	import { Maximize, Play, Power } from '@lucide/svelte';

	let { bundleUrl }: { bundleUrl: string } = $props();

	// js-dos KBD_ keycode for ESC (from the vendored bundle's keymap).
	const KBD_ESC = 256;

	let host = $state<HTMLDivElement | null>(null);
	let started = $state(false);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let dosProps: DosProps | null = null;
	let ci = $state<DosCommandInterface | null>(null);

	let scriptPromise: Promise<void> | null = null;
	function loadJsDos(): Promise<void> {
		if (window.Dos) return Promise.resolve();
		if (scriptPromise) return scriptPromise;
		scriptPromise = new Promise((resolve, reject) => {
			const css = document.createElement('link');
			css.rel = 'stylesheet';
			css.href = '/vendor/js-dos/js-dos.css';
			document.head.appendChild(css);
			const s = document.createElement('script');
			s.src = '/vendor/js-dos/js-dos.js';
			s.onload = () => resolve();
			s.onerror = () => reject(new Error('failed to load js-dos'));
			document.head.appendChild(s);
		});
		return scriptPromise;
	}

	async function launch() {
		if (started) return;
		started = true;
		loading = true;
		error = null;
		try {
			await loadJsDos();
			if (!host || !window.Dos) throw new Error('js-dos unavailable');
			// Effective app theme (the layout writes it to <html data-theme>), so the
			// js-dos chrome matches. kiosk hides the sidebar drawer entirely — both
			// the white panel and the thin strip that lingers in fullscreen — and we
			// provide our own fullscreen button instead.
			const appTheme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
			dosProps = window.Dos(host, {
				url: bundleUrl,
				pathPrefix: '/vendor/js-dos/emulators/',
				autoStart: true,
				kiosk: true,
				theme: appTheme,
				// The command interface arrives here once the emulator is running,
				// so we can inject keys (ESC etc.) the kiosk UI no longer offers.
				onEvent: (event, commandInterface) => {
					if (event === 'ci-ready' && commandInterface) ci = commandInterface;
				}
			});
		} catch (e) {
			error = String(e);
			started = false;
		} finally {
			loading = false;
		}
	}

	function fullscreen() {
		host?.requestFullscreen?.().catch(() => {});
	}

	// Inject ESC straight into DOSBox — works in fullscreen too, where the
	// physical Esc key would just exit the browser's fullscreen instead. Useful
	// for demos that quit on ESC; many ignore it, hence Exit below.
	function sendEsc() {
		ci?.simulateKeyPress(KBD_ESC);
	}

	// Hard stop: tear the emulator down and return to the launch state — the way
	// out for demos that don't respond to ESC at all.
	function exitEmu() {
		try {
			dosProps?.stop?.();
		} catch {
			/* already gone */
		}
		dosProps = null;
		ci = null;
		started = false;
		host?.replaceChildren();
	}

	onDestroy(() => {
		try {
			dosProps?.stop?.();
		} catch {
			/* nothing to tear down */
		}
	});
</script>

<div class="emu">
	{#if !started}
		<button class="launch" onclick={launch}>
			<Play size={20} /> Launch
		</button>
		<p class="hint">Loads the emulator (~1.5 MB) on demand.</p>
	{/if}
	{#if loading}<p class="hint">starting…</p>{/if}
	{#if error}<p class="err">{error}</p>{/if}
	{#if started && !error}
		<div class="bar">
			<button onclick={sendEsc} disabled={!ci} title="Send ESC to the demo">ESC</button>
			<button onclick={fullscreen} title="Fullscreen" aria-label="Fullscreen">
				<Maximize size={16} /> Fullscreen
			</button>
			<button class="exit" onclick={exitEmu} title="Stop the emulator">
				<Power size={16} /> Exit
			</button>
		</div>
	{/if}
	<div class="screen" class:live={started} bind:this={host}></div>
</div>

<style>
	.emu {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		height: 100%;
		min-height: 0;
	}
	.launch {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 12px 20px;
		border: 1px solid var(--accent);
		border-radius: 8px;
		background: var(--accent);
		color: #0f0f0f;
		font-size: 15px;
		cursor: pointer;
	}
	.hint {
		color: var(--muted);
		font-size: 12px;
		margin: 0;
	}
	.bar {
		align-self: flex-end;
		display: flex;
		gap: 6px;
	}
	.bar button {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 10px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--panel);
		color: var(--text);
		font-size: 12px;
		cursor: pointer;
	}
	.bar button:hover:not(:disabled) {
		border-color: var(--accent);
	}
	.bar button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.bar button.exit:hover {
		border-color: #ff4136;
		color: #ff4136;
	}
	.err {
		color: #ff4136;
	}
	.screen {
		width: 100%;
		flex: 1;
		min-height: 0;
		background: #000;
		border-radius: 6px;
		overflow: hidden;
	}
	.screen:not(.live) {
		display: none;
	}
</style>
