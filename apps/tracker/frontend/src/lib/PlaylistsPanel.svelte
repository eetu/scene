<script lang="ts">
	import {
		ChevronDown,
		ChevronUp,
		Download,
		ListMusic,
		Play,
		Plus,
		Trash2,
		X
	} from '@lucide/svelte';

	import {
		api,
		type FetchStatus,
		itemToTrack,
		type Playlist,
		type PlaylistDetail,
		type Track
	} from '$lib/api';

	type Props = {
		open: boolean;
		playlists: Playlist[];
		onClose: () => void;
		/** Re-fetch the playlist list (after create/delete/rename/import). */
		onRefresh: () => Promise<void> | void;
		/** Play a list of present tracks in order. */
		onPlay: (tracks: Track[]) => void;
	};

	let { open, playlists, onClose, onRefresh, onPlay }: Props = $props();

	let newName = $state('');
	let detail = $state<PlaylistDetail | null>(null);
	let detailLoading = $state(false);
	let busy = $state(false);

	// Fetch-missing progress for the open playlist.
	let fetchp = $state<FetchStatus | null>(null);
	let fetching = $state(false);

	const missingCount = $derived(detail ? detail.items.filter((i) => !i.present).length : 0);

	async function create() {
		const name = newName.trim();
		if (!name) return;
		busy = true;
		try {
			const pl = await api.createPlaylist(name);
			newName = '';
			await onRefresh();
			await openDetail(pl.id);
		} finally {
			busy = false;
		}
	}

	async function openDetail(id: string) {
		detailLoading = true;
		try {
			detail = await api.getPlaylist(id);
		} finally {
			detailLoading = false;
		}
	}

	function closeDetail() {
		detail = null;
	}

	async function remove(id: string) {
		if (!confirm('Delete this playlist?')) return;
		busy = true;
		try {
			await api.deletePlaylist(id);
			if (detail?.playlist.id === id) detail = null;
			await onRefresh();
		} finally {
			busy = false;
		}
	}

	async function rename(p: Playlist) {
		const name = prompt('Rename playlist', p.name)?.trim();
		if (!name || name === p.name) return;
		await api.renamePlaylist(p.id, name);
		await onRefresh();
		if (detail?.playlist.id === p.id) await openDetail(p.id);
	}

	function playDetail() {
		if (!detail) return;
		const tracks = detail.items.filter((i) => i.present).map(itemToTrack);
		if (tracks.length) onPlay(tracks);
	}

	async function removeItem(itemId: number) {
		if (!detail) return;
		await api.removeFromPlaylist(detail.playlist.id, itemId);
		await openDetail(detail.playlist.id);
		await onRefresh();
	}

	async function move(index: number, delta: number) {
		if (!detail) return;
		const ids = detail.items.map((i) => i.id);
		const j = index + delta;
		if (j < 0 || j >= ids.length) return;
		[ids[index], ids[j]] = [ids[j], ids[index]];
		await api.reorderPlaylist(detail.playlist.id, ids);
		await openDetail(detail.playlist.id);
	}

	async function fetchMissing() {
		if (!detail) return;
		fetching = true;
		try {
			await api.fetchMissing(detail.playlist.id);
			do {
				await new Promise((r) => setTimeout(r, 1000));
				fetchp = await api.fetchStatus();
			} while (fetchp.running);
			await openDetail(detail.playlist.id);
			await onRefresh();
		} finally {
			fetching = false;
		}
	}

	function label(i: PlaylistDetail['items'][number]): string {
		return i.title || i.filename || (i.md5 ? i.md5.slice(0, 12) : 'unknown');
	}
</script>

{#if open}
	<div class="panel-bg">
		<button class="scrim" aria-label="close" onclick={onClose}></button>
		<div class="panel" role="dialog" aria-modal="true" aria-label="playlists">
			<header class="ph">
				<ListMusic size={16} />
				<h3>{detail ? detail.playlist.name : 'playlists'}</h3>
				<button class="x" aria-label="close" onclick={onClose}><X size={16} /></button>
			</header>

			{#if !detail}
				<!-- list of playlists -->
				<div class="newrow">
					<input
						placeholder="new playlist…"
						bind:value={newName}
						onkeydown={(e) => e.key === 'Enter' && create()}
					/>
					<button class="ok" onclick={create} disabled={busy || !newName.trim()}>
						<Plus size={14} /> add
					</button>
				</div>

				<ul class="plist">
					{#each playlists as p (p.id)}
						<li>
							<button class="open" onclick={() => openDetail(p.id)}>
								<span class="pn">{p.name}</span>
								<span class="pc">{p.item_count}</span>
							</button>
							<button class="mini" title="rename" onclick={() => rename(p)}>✎</button>
							<button class="mini" title="delete" onclick={() => remove(p.id)}>
								<Trash2 size={13} />
							</button>
						</li>
					{:else}
						<li class="empty">no playlists yet</li>
					{/each}
				</ul>
			{:else}
				<!-- single playlist detail -->
				<div class="dactions">
					<button class="back" onclick={closeDetail}>‹ all</button>
					{#if missingCount > 0}
						<button
							class="ok"
							onclick={fetchMissing}
							disabled={fetching}
							title="download missing via Modland"
						>
							<Download size={14} />
							{fetching
								? `fetching ${fetchp?.fetched ?? 0}/${fetchp?.total ?? missingCount}`
								: `fetch ${missingCount} missing`}
						</button>
					{/if}
					<button
						class="ok play"
						onclick={playDetail}
						disabled={!detail.items.some((i) => i.present)}
					>
						<Play size={14} /> play
					</button>
				</div>
				{#if detailLoading}
					<p class="msg">loading…</p>
				{:else}
					<ol class="items">
						{#each detail.items as it, i (it.id)}
							<li class:missing={!it.present}>
								<span class="ix">{i + 1}</span>
								<span class="it-name" title={it.path ?? it.md5 ?? ''}>
									{label(it)}{#if !it.present}<span class="pending"> (missing)</span>{/if}
								</span>
								<button class="mini" title="up" disabled={i === 0} onclick={() => move(i, -1)}>
									<ChevronUp size={13} />
								</button>
								<button
									class="mini"
									title="down"
									disabled={i === detail.items.length - 1}
									onclick={() => move(i, 1)}
								>
									<ChevronDown size={13} />
								</button>
								<button class="mini" title="remove" onclick={() => removeItem(it.id)}>
									<X size={13} />
								</button>
							</li>
						{:else}
							<li class="empty">empty — add tracks from the library or import a list</li>
						{/each}
					</ol>
				{/if}
			{/if}
		</div>
	</div>
{/if}

<style>
	.panel-bg {
		position: fixed;
		inset: 0;
		z-index: 6;
		display: flex;
		justify-content: flex-end;
	}
	.scrim {
		position: absolute;
		inset: 0;
		border: none;
		background: rgba(0, 0, 0, 0.5);
		cursor: pointer;
	}
	.panel {
		position: relative;
		z-index: 1;
		width: min(420px, 100%);
		height: 100%;
		background: var(--panel);
		border-left: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.ph {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 14px;
		border-bottom: 1px solid var(--border);
		color: var(--accent);
	}
	.ph h3 {
		margin: 0;
		font-size: 14px;
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.x,
	.mini,
	.back {
		background: none;
		border: none;
		color: var(--muted);
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		padding: 4px 6px;
	}
	.newrow {
		display: flex;
		gap: 8px;
		padding: 12px 14px;
	}
	.newrow input {
		flex: 1;
		min-width: 0;
		padding: 7px 10px;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 4px;
		color: var(--text);
	}
	.ok {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		border: 1px solid var(--accent);
		color: var(--accent);
		background: var(--panel-hi);
		border-radius: 4px;
		padding: 6px 10px;
		cursor: pointer;
	}
	.ok:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.plist,
	.items {
		list-style: none;
		margin: 0;
		padding: 0 8px 24px;
		overflow-y: auto;
		flex: 1;
	}
	.plist li {
		display: flex;
		align-items: center;
		gap: 2px;
		border-radius: 4px;
	}
	.plist li:hover {
		background: var(--panel-hi);
	}
	.open {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		background: none;
		border: none;
		color: var(--text);
		text-align: left;
		padding: 9px 8px;
		cursor: pointer;
	}
	.pn {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.pc {
		color: var(--muted);
		font-size: 12px;
		font-variant-numeric: tabular-nums;
	}
	.dactions {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 14px;
		border-bottom: 1px solid var(--border);
	}
	.back {
		color: var(--text);
	}
	.play {
		margin-left: auto;
	}
	.items li {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 6px;
		border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
	}
	.items li.missing {
		opacity: 0.5;
	}
	.ix {
		flex: 0 0 auto;
		width: 22px;
		color: var(--muted);
		font-size: 12px;
		font-variant-numeric: tabular-nums;
		text-align: right;
	}
	.it-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.pending {
		color: var(--muted);
		font-size: 12px;
	}
	.empty,
	.msg {
		color: var(--muted);
		padding: 16px 8px;
		list-style: none;
	}
	.mini:disabled {
		opacity: 0.3;
		cursor: default;
	}
</style>
