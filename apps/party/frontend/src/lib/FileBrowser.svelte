<script lang="ts">
	// Generic file browser: a list of a production's files on the left, a single
	// viewer pane on the right that dispatches on the file's kind/MIME — runnable
	// exe → DOS (js-dos), disk image → C64/Amiga (EmulatorJS), module → the
	// libopenmpt music player, text → NfoView, native image → canvas, native
	// video → <video>, and a download card for everything else. The "star" of a
	// production (its primary file) is selected by default, so a demo opens
	// straight into the emulator and a graphics entry into the image — one
	// consistent layout for every production type.
	import {
		Download,
		File,
		FileText,
		Film,
		Image as ImageIcon,
		Monitor,
		Music,
		PanelLeft
	} from '@lucide/svelte';

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
		kickstart = null,
		initialFile = null,
		onfile
	}: {
		files: ProductionFile[];
		primary?: string | null;
		platform?: string;
		prodId: string;
		kickstart?: string | null;
		/** rel_path to pre-select (from the URL ?f param); used on load/restore. */
		initialFile?: string | null;
		/** Called when the user picks a file, so the URL can reflect it. */
		onfile?: (relPath: string) => void;
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
		// Re-pick a default whenever the file set changes (i.e. a different
		// production). Honour the URL-provided `initialFile` if it's valid for this
		// set; else primary first (it may be a hidden .support disk — that's the
		// point), then the first showable visible file, else the first visible file.
		// This is the auto-default path — it must NOT call onfile (no URL write);
		// only an explicit user pick does.
		const pre = initialFile && files.some((f) => f.rel_path === initialFile) ? initialFile : null;
		const prim = files.find((f) => f.hash === primary);
		const show = visible.find(showable);
		selectedPath = pre ?? (prim ?? show ?? visible[0] ?? files[0])?.rel_path ?? null;
	});

	function pick(relPath: string) {
		selectedPath = relPath;
		onfile?.(relPath);
	}
	const selected = $derived(files.find((f) => f.rel_path === selectedPath) ?? null);
	// Emulator + music player manage their own size and should fill the pane (no
	// inner scroll); text/images keep the scrollable, padded pane.
	const fills = $derived(selected ? runnable(selected) || selected.kind === 'music' : false);

	// The file list is a collapsible drawer — hide it to give the content (player /
	// emulator / image) the full width.
	let listOpen = $state(true);

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
	<div class="bhead">
		<button
			class="toggle"
			onclick={() => (listOpen = !listOpen)}
			title={listOpen ? 'Hide file list' : 'Show file list'}
			aria-label="Toggle file list"
			aria-expanded={listOpen}
		>
			<PanelLeft size={16} />
		</button>
		<span class="bname">{selected?.filename ?? ''}</span>
	</div>

	<div class="panes" class:list-hidden={!listOpen}>
		<div class="listpane">
			<ul class="list" use:listKeys>
				{#each visible as f (f.rel_path)}
					<li>
						<button
							class:sel={f.rel_path === selectedPath}
							onclick={() => pick(f.rel_path)}
							onfocus={() => pick(f.rel_path)}
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
		</div>

		<div class="view" class:fill={fills}>
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
					src={NATIVE_IMG.has(selected.mime)
						? fileUrl(selected.hash)
						: assetUrl(selected.hash, 'png')}
					alt={selected.filename}
				/>
				<a class="dl sub" href={fileUrl(selected.hash)} download><Download size={13} /> Original</a>
			{:else if selected.mime.startsWith('video/')}
				<!-- svelte-ignore a11y_media_has_caption -->
				<video
					class="vid"
					src={NATIVE_VIDEO.has(selected.mime)
						? fileUrl(selected.hash)
						: assetUrl(selected.hash, 'mp4')}
					controls
				></video>
				<a class="dl sub" href={fileUrl(selected.hash)} download><Download size={13} /> Original</a>
			{:else}
				{@const Icon = iconFor(selected)}
				<div class="ph">
					<Icon size={26} />
					<p>{selected.filename} · {fmtBytes(selected.size)} · {selected.mime}</p>
					{#if selected.kind === 'exe' && platform === 'amiga'}
						<p class="hint">
							No Amiga disk image yet — package an *(AGA).hdf into this folder to run it.
						</p>
					{/if}
					<a class="dl" href={fileUrl(selected.hash)} download><Download size={14} /> Download</a>
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.browser {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border);
		border-radius: 8px;
		overflow: hidden;
		/* Fill the detail pane's remaining height so the list scrolls internally
		   and the viewer (emulator/image/video/player) scales to the space. */
		flex: 1;
		min-height: 200px;
	}
	.bhead {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 8px;
		background: var(--panel);
		border-bottom: 1px solid var(--border);
	}
	.toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 4px;
		border: 1px solid var(--border);
		border-radius: 5px;
		background: var(--panel-hi);
		color: var(--text);
		cursor: pointer;
	}
	.toggle:hover {
		border-color: var(--accent);
	}
	.bname {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--muted);
		font-size: 12px;
		font-family: var(--font-mono-retro);
	}
	/* Animated drawer — mirrors the catalog nav drawer ([slug] .cols): a FIXED px
	   track interpolates to 0 (minmax() would not animate), and the list clips its
	   own overflow-x so nothing peeks through at width 0. */
	.panes {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: 240px 1fr;
		transition: grid-template-columns 0.22s ease;
	}
	.panes.list-hidden {
		grid-template-columns: 0px 1fr;
	}
	/* The grid item only clips; the fixed-width inner list keeps its layout so the
	   shrinking track slides it out cleanly (no reflow, no leftover sliver). */
	.listpane {
		overflow: hidden;
		border-right: 1px solid var(--border);
		background: var(--panel);
	}
	.panes.list-hidden .listpane {
		border-right-color: transparent;
	}
	.list {
		width: 240px;
		height: 100%;
		list-style: none;
		margin: 0;
		padding: 6px;
		overflow-x: hidden;
		overflow-y: auto;
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
	/* Emulator + music player fill the pane (their own height:100%): no scroll. */
	.view.fill {
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
		/* Stacked: list on top, content below. The drawer collapses UPWARD (rows,
		   not columns) so the content slides up to fill — the whole interaction is
		   the desktop one rotated a quarter-turn. */
		.panes {
			grid-template-columns: 1fr;
			grid-template-rows: 30vh 1fr;
			transition: grid-template-rows 0.22s ease;
		}
		.panes.list-hidden {
			grid-template-columns: 1fr;
			grid-template-rows: 0 1fr;
		}
		.listpane {
			border-right: 0;
			border-bottom: 1px solid var(--border);
		}
		.panes.list-hidden .listpane {
			border-right-color: var(--border);
			border-bottom-color: transparent;
		}
		.list {
			width: 100%;
		}
		/* Drawer is on top here — rotate the toggle icon to match (counter-clockwise). */
		.toggle :global(svg) {
			transform: rotate(-90deg);
		}
	}
</style>
