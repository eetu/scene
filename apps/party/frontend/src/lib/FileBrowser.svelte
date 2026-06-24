<script lang="ts">
	// Generic file browser: a list of a production's files on the left, a single
	// viewer pane on the right that dispatches on the file's kind/MIME — runnable
	// exe → DOS (js-dos), disk image → C64/Amiga (EmulatorJS), module → the
	// libopenmpt music player, text → NfoView, native image → canvas, native
	// video → <video>, and a download card for everything else. The "star" of a
	// production (its primary file) is selected by default, so a demo opens
	// straight into the emulator and a graphics entry into the image — one
	// consistent layout for every production type.
	import { Download, File, FileText, Film, Image as ImageIcon, Monitor, Music } from '@lucide/svelte';

	import { assetUrl, bundleUrl, diskUrl, fileUrl, type ProductionFile } from './api';
	import EjsEmulator from './EjsEmulator.svelte';
	import Emulator from './Emulator.svelte';
	import ImageCanvas from './ImageCanvas.svelte';
	import { listKeys } from './listkeys';
	import MusicPlayer from './MusicPlayer.svelte';
	import NfoView from './NfoView.svelte';

	let {
		files,
		primary = null,
		platform = 'na',
		prodId,
		kickstart = null
	}: {
		files: ProductionFile[];
		primary?: string | null;
		platform?: string;
		prodId: string;
		kickstart?: string | null;
	} = $props();

	const NATIVE_IMG = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/bmp']);
	const NATIVE_VIDEO = new Set(['video/mp4', 'video/webm', 'video/quicktime']);

	// Files under a `.support` dir (e.g. a custom-packaged Amiga disk image that
	// sits alongside the scraped scene.org originals) are hidden from the list:
	// they're our own additions, not part of the release. They stay available as
	// the production's primary, so the emulator still boots them.
	function hidden(f: ProductionFile): boolean {
		return f.rel_path.split('/').some((seg) => seg.startsWith('.'));
	}
	const visible = $derived(files.filter((f) => !hidden(f)));

	// Runnable in-browser: a PC executable (DOS) or a C64/Amiga disk image.
	function runnable(f: ProductionFile): boolean {
		if (f.kind === 'exe') return platform === 'pc';
		if (f.kind === 'diskimage') return platform === 'c64' || platform === 'amiga';
		return false;
	}
	function showable(f: ProductionFile): boolean {
		return (
			runnable(f) ||
			f.kind === 'music' ||
			f.mime.startsWith('text/') ||
			f.mime.startsWith('image/') ||
			f.mime.startsWith('video/')
		);
	}

	// Keyed/selected by rel_path, not hash — duplicate files (identical bytes)
	// share a content hash, which would collide as an {#each} key.
	let selectedPath = $state<string | null>(null);
	// Default to the production's primary file (the star), so a demo opens on its
	// emulator and a graphics entry on its image; else the first showable file,
	// else the first file.
	$effect(() => {
		// Primary first (it may be a hidden .support disk — that's the point); then
		// the first showable visible file, else the first visible file.
		const prim = files.find((f) => f.hash === primary);
		const show = visible.find(showable);
		selectedPath = (prim ?? show ?? visible[0] ?? files[0])?.rel_path ?? null;
	});
	const selected = $derived(files.find((f) => f.rel_path === selectedPath) ?? null);
	// An emulator sizes itself (4:3, its own max-height); the scrollable, height-
	// capped view pane meant for text/images would just clip it and add scrollbars.
	const isEmu = $derived(selected ? runnable(selected) : false);

	function iconFor(f: ProductionFile) {
		if (f.mime.startsWith('text/')) return FileText;
		if (f.mime.startsWith('image/')) return ImageIcon;
		if (f.mime.startsWith('video/')) return Film;
		if (f.mime.startsWith('audio/') || f.kind === 'music') return Music;
		if (f.kind === 'exe' || f.kind === 'diskimage') return Monitor;
		return File;
	}

	function fmtBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
		return `${(n / 1024 / 1024).toFixed(1)} MB`;
	}
</script>

<div class="browser">
	<ul class="list" use:listKeys>
		{#each visible as f (f.rel_path)}
			<li>
				<button
					class:sel={f.rel_path === selectedPath}
					onclick={() => (selectedPath = f.rel_path)}
					onfocus={() => (selectedPath = f.rel_path)}
				>
					{#key f.hash}
						{@const Icon = iconFor(f)}
						<Icon size={14} />
					{/key}
					<span class="fn">{f.filename}</span>
					<span class="fs">{fmtBytes(f.size)}</span>
				</button>
			</li>
		{/each}
	</ul>

	<div class="view" class:emu={isEmu}>
		{#if !selected}
			<p class="muted">No file selected.</p>
		{:else if selected.kind === 'exe' && platform === 'pc'}
			<!-- DOS: js-dos mounts the whole production folder and autoruns the
			     primary executable, so it's keyed on the production, not the file. -->
			{#key prodId}<Emulator bundleUrl={bundleUrl(prodId)} />{/key}
		{:else if selected.kind === 'diskimage' && platform === 'c64'}
			{#key selected.hash}
				<EjsEmulator core="c64" gameUrl={diskUrl(selected.hash, selected.filename)} />
			{/key}
		{:else if selected.kind === 'diskimage' && platform === 'amiga'}
			{#key selected.hash}
				<!-- No ROM → PUAE uses its built-in AROS Kickstart (lower AGA compat);
				     a configured Kickstart 3.1 overrides it. -->
				<EjsEmulator
					core="amiga"
					gameUrl={diskUrl(selected.hash, selected.filename)}
					biosUrl={kickstart ?? undefined}
				/>
			{/key}
		{:else if selected.kind === 'music'}
			<MusicPlayer {platform} />
		{:else if selected.mime.startsWith('text/')}
			<NfoView hash={selected.hash} />
		{:else if selected.mime.startsWith('image/')}
			<!-- Native formats stream raw; others are transcoded to PNG on demand. -->
			<ImageCanvas
				src={NATIVE_IMG.has(selected.mime) ? fileUrl(selected.hash) : assetUrl(selected.hash, 'png')}
				alt={selected.filename}
			/>
			<a class="dl sub" href={fileUrl(selected.hash)} download><Download size={13} /> Original</a>
		{:else if selected.mime.startsWith('video/')}
			<!-- svelte-ignore a11y_media_has_caption -->
			<video
				class="vid"
				src={NATIVE_VIDEO.has(selected.mime) ? fileUrl(selected.hash) : assetUrl(selected.hash, 'mp4')}
				controls
			></video>
			<a class="dl sub" href={fileUrl(selected.hash)} download><Download size={13} /> Original</a>
		{:else}
			{@const Icon = iconFor(selected)}
			<div class="ph">
				<Icon size={26} />
				<p>{selected.filename} · {fmtBytes(selected.size)} · {selected.mime}</p>
				{#if selected.kind === 'exe' && platform === 'amiga'}
					<p class="hint">No Amiga disk image yet — package an *(AGA).hdf into this folder to run it.</p>
				{/if}
				<a class="dl" href={fileUrl(selected.hash)} download><Download size={14} /> Download</a>
			</div>
		{/if}
	</div>
</div>

<style>
	.browser {
		display: grid;
		grid-template-columns: minmax(180px, 240px) 1fr;
		gap: 14px;
		border: 1px solid var(--border);
		border-radius: 8px;
		overflow: hidden;
		/* Fill the detail pane's remaining height so the list scrolls internally
		   and the viewer (emulator/image/video) scales to the available space. */
		flex: 1;
		min-height: 200px;
	}
	.list {
		list-style: none;
		margin: 0;
		padding: 6px;
		border-right: 1px solid var(--border);
		background: var(--panel);
		overflow: auto;
		min-height: 0;
	}
	.list button {
		display: flex;
		align-items: center;
		gap: 7px;
		width: 100%;
		text-align: left;
		padding: 5px 7px;
		border: 0;
		border-radius: 5px;
		background: transparent;
		color: var(--text);
		cursor: pointer;
		font-size: 13px;
	}
	.list button:hover {
		background: var(--panel-hi);
	}
	.list button.sel {
		background: var(--accent-dim);
	}
	.fn {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono-retro);
	}
	.fs {
		color: var(--muted);
		font-size: 11px;
		white-space: nowrap;
	}
	.view {
		padding: 14px;
		overflow: auto;
		min-height: 0;
	}
	/* The emulator fills the pane (see .emu/.screen): no inner scroll, no clip. */
	.view.emu {
		overflow: hidden;
	}
	.vid {
		width: 100%;
		max-height: 65vh;
		background: #000;
		border-radius: 6px;
	}
	.ph {
		display: grid;
		place-items: center;
		gap: 10px;
		padding: 40px;
		color: var(--muted);
		text-align: center;
	}
	.hint {
		font-size: 12px;
		max-width: 360px;
	}
	.dl {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 7px 12px;
		border: 1px solid var(--accent);
		border-radius: 6px;
		color: var(--accent);
		text-decoration: none;
	}
	.dl.sub {
		margin-top: 10px;
		padding: 4px 9px;
		font-size: 12px;
	}
	.muted {
		color: var(--muted);
	}
	@media (max-width: 640px) {
		.browser {
			grid-template-columns: 1fr;
		}
		.list {
			border-right: 0;
			border-bottom: 1px solid var(--border);
			max-height: 30vh;
		}
	}
</style>
