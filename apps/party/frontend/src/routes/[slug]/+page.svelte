<script lang="ts">
	// A party's catalog: productions grouped by competition, ranked, with a
	// detail panel that dispatches to the right viewer by medium — music → the
	// libopenmpt Player, images/video native where possible, text → NfoView,
	// demos/intros → an emulator placeholder (Phase 3). Everything downloadable.
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	import {
		ArrowLeft,
		ChevronRight,
		Film,
		Image as ImageIcon,
		Monitor,
		Music,
		PanelLeft
	} from '@lucide/svelte';

	import { playInOrder, type Track } from '@scene/player';

	import { api, type Production, type ProductionDetail } from '$lib/api';
	import FileBrowser from '$lib/FileBrowser.svelte';
	import { listKeys } from '$lib/listkeys';
	import Settings from '$lib/Settings.svelte';

	const slug = $derived(page.params.slug ?? '');
	let prods = $state<Production[]>([]);
	let kickstart = $state<string | null>(null);
	let error = $state<string | null>(null);
	let selected = $state<Production | null>(null);
	let detail = $state<ProductionDetail | null>(null);

	// The URL is the single source of truth for the selection (?p=<prodId>&f=<rel
	// _path>). Reads are reactive off page.url; writes go through goto() (a real
	// same-route navigation that updates page.url reactively — unlike shallow
	// replaceState). replaceState:true keeps it out of the history stack;
	// keepFocus/noScroll avoid disturbing the list. Reload + back/forward + share
	// all "just work" because the view derives from the URL.
	const pid = $derived(page.url.searchParams.get('p'));
	const fileParam = $derived(page.url.searchParams.get('f'));
	function nav(updates: Record<string, string | null>) {
		const u = new URL(page.url);
		for (const [k, v] of Object.entries(updates)) {
			if (v == null) u.searchParams.delete(k);
			else u.searchParams.set(k, v);
		}
		void goto(u, { replaceState: true, keepFocus: true, noScroll: true });
	}

	// Fetch the productions for the current party.
	$effect(() => {
		const s = slug;
		api
			.productions(s)
			.then((r) => {
				prods = r.productions;
				kickstart = r.kickstart_url;
			})
			.catch((e) => (error = String(e)));
	});

	// Selection is derived from the URL: this runs on click (goto changed ?p), on
	// load/reload (the param is already there), and on back/forward. Ignores a
	// stale response if ?p moved on while the fetch was in flight.
	$effect(() => {
		const id = pid;
		if (prods.length === 0) return;
		if (!id) {
			selected = null;
			detail = null;
			return;
		}
		if (selected?.id === id) return; // already loaded — don't refetch
		const prod = prods.find((x) => x.id === id);
		if (!prod) return;
		selected = prod;
		detail = null;
		// Reveal it in the catalog (cards are collapsed by default; unranked
		// entries hide behind "+N more").
		open[prod.compo] = true;
		if (prod.rank == null) showRest[prod.compo] = true;
		api
			.production(id)
			.then((d) => {
				if (selected?.id === id) detail = d;
			})
			.catch((e) => {
				if (selected?.id === id) error = String(e);
			});
	});

	// Group by compo. The party-info bits (Info, Misc) are surfaced first — handy
	// as an overview — then the competitions alphabetically.
	const FIRST = ['Info', 'Misc'];
	const groups = $derived.by(() => {
		const m = new Map<string, Production[]>();
		for (const p of prods) {
			const arr = m.get(p.compo);
			if (arr) arr.push(p);
			else m.set(p.compo, [p]);
		}
		const rank = (c: string) => (FIRST.includes(c) ? FIRST.indexOf(c) : FIRST.length);
		return [...m.entries()].sort(
			([a], [b]) => rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true })
		);
	});

	// Collapsible category cards, closed by default — the left panel is a scannable
	// overview (Info/Misc first); open a card to see its entries.
	let open = $state<Record<string, boolean>>({});
	function toggle(compo: string) {
		open[compo] = !open[compo];
	}

	// The catalog left panel is a drawer — collapsible to give the detail/emulator
	// the full width.
	let navOpen = $state(true);

	// Within a card, show only the ranked entries (the competition top results)
	// by default; the unranked `rest/` productions hide behind "show more".
	let showRest = $state<Record<string, boolean>>({});

	function toTrack(p: Production): Track {
		return {
			hash: p.primary_hash as string,
			filename: p.title ?? 'untitled',
			title: p.title,
			group: p.group
		};
	}

	const musicTracks = $derived(
		prods.filter((p) => p.primary_kind === 'music' && p.primary_hash).map(toTrack)
	);

	function select(p: Production) {
		// Write the selection to the URL; the effect above reacts and loads detail.
		nav({ p: p.id, f: null });
		// Autoplay only on an explicit click (a user gesture) — never on URL
		// restore, where the browser would block audio anyway.
		if (p.primary_kind === 'music' && p.primary_hash) {
			void playInOrder(musicTracks, toTrack(p));
		}
	}

	function mediumIcon(m: string) {
		if (m === 'music') return Music;
		if (m === 'graphics') return ImageIcon;
		if (m === 'animation') return Film;
		return Monitor;
	}
</script>

<header>
	<a class="back" href="/" aria-label="Back"><ArrowLeft size={18} /></a>
	<button class="navtoggle" onclick={() => (navOpen = !navOpen)} title="Toggle list" aria-label="Toggle list">
		<PanelLeft size={18} />
	</button>
	<h1>{slug}</h1>
	<span class="sub">{prods.length} productions</span>
	<Settings />
</header>

<main>
	{#if error}
		<p class="error">{error}</p>
	{/if}

	<div class="cols" class:nav-hidden={!navOpen}>
		<section class="catalog">
			<div class="catalog-inner">
			{#each groups as [compo, entries] (compo)}
				<div class="cat" class:open={open[compo]}>
					<button class="cathead" onclick={() => toggle(compo)} aria-expanded={!!open[compo]}>
						<ChevronRight class="chev" size={14} />
						<span class="catname">{compo}</span>
						<span class="catcount">{entries.length}</span>
					</button>
					{#if open[compo]}
						{@const ranked = entries.filter((e) => e.rank != null)}
						{@const rest = entries.filter((e) => e.rank == null)}
						{@const list = showRest[compo] || ranked.length === 0 ? entries : ranked}
						<ul use:listKeys>
							{#each list as p (p.id)}
								<li>
									<button class:sel={selected?.id === p.id} onclick={() => select(p)}>
										<span class="rank">{p.rank ?? '—'}</span>
										{#key p.medium}
											{@const Icon = mediumIcon(p.medium)}
											<Icon size={14} />
										{/key}
										<span class="name">
											{#if p.group}<b>{p.group}</b> — {/if}{p.title ?? '(untitled)'}
										</span>
										{#if p.points != null}
											<span class="pts">{p.points}p</span>
										{/if}
									</button>
								</li>
							{/each}
						</ul>
						{#if ranked.length > 0 && rest.length > 0}
							<button class="more" onclick={() => (showRest[compo] = !showRest[compo])}>
								{showRest[compo] ? 'Show less' : `+${rest.length} more`}
							</button>
						{/if}
					{/if}
				</div>
			{/each}
			</div>
		</section>

		<section class="detail">
			{#if !selected}
				<p class="muted">Select a production.</p>
			{:else}
				{@const prod = selected}
				<div class="dhead">
					<h2>{prod.title ?? '(untitled)'}</h2>
					<p class="credit">
						{#if prod.group}{prod.group} · {/if}{prod.compo}
						{#if prod.rank}· #{prod.rank}{/if}
						{#if prod.points != null}· {prod.points} pts{/if}
					</p>
					{#if detail?.meta}
						<p class="meta">
							{detail.meta.type_long ?? ''}
							{#if detail.meta.channels}· {detail.meta.channels} ch{/if}
							{#if detail.meta.instruments}· {detail.meta.instruments} ins{/if}
							{#if detail.meta.tracker}· {detail.meta.tracker}{/if}
						</p>
					{/if}
				</div>

				<!-- One unified two-pane browser handles every production type: the
				     primary file (auto-selected) opens its "star" viewer — emulator
				     (DOS/C64/Amiga), music player, image or video — and the other
				     files (NFO, screenshots) open in the same pane. -->
				{#if detail}
					<FileBrowser
						files={detail.files}
						primary={prod.primary_hash}
						platform={prod.platform}
						prodId={prod.id}
						{kickstart}
						initialFile={fileParam}
						onfile={(relPath) => nav({ f: relPath })}
					/>
				{/if}
			{/if}
		</section>
	</div>
</main>

<style>
	header {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 14px 20px;
		border-bottom: 1px solid var(--border);
	}
	.back,
	.navtoggle {
		color: var(--text);
		display: grid;
		place-items: center;
		background: none;
		border: 0;
		cursor: pointer;
		padding: 0;
	}
	.navtoggle:hover {
		color: var(--accent);
	}
	h1 {
		margin: 0;
		font-family: var(--font-retro);
		font-size: 18px;
		color: var(--accent);
	}
	.sub {
		color: var(--muted);
		font-size: 13px;
		margin-right: auto;
	}
	main {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		padding: 0;
	}
	.cols {
		display: grid;
		grid-template-columns: 340px 1fr;
		height: 100%;
		min-height: 0;
		transition: grid-template-columns 0.22s ease;
	}
	.cols.nav-hidden {
		grid-template-columns: 0px 1fr;
	}
	.cols.nav-hidden .catalog {
		border-right-color: transparent;
	}
	/* The grid item only clips; the fixed-width inner keeps its layout so the
	   shrinking track slides it out cleanly instead of reflowing/wrapping its
	   text. (Same trick the FileBrowser list drawer uses.) */
	.catalog {
		overflow: hidden;
		border-right: 1px solid var(--border);
	}
	.catalog-inner {
		width: 340px;
		height: 100%;
		overflow-x: hidden;
		overflow-y: auto;
		padding: 12px 14px;
	}
	.cat {
		border: 1px solid var(--border);
		border-radius: 6px;
		margin-bottom: 6px;
		overflow: hidden;
	}
	.cathead {
		display: flex;
		align-items: center;
		gap: 7px;
		width: 100%;
		padding: 7px 9px;
		border: 0;
		background: var(--panel);
		color: var(--text);
		cursor: pointer;
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.cathead:hover {
		background: var(--panel-hi);
	}
	.cathead :global(.chev) {
		transition: transform 0.12s ease;
		color: var(--muted);
	}
	.cat.open .cathead :global(.chev) {
		transform: rotate(90deg);
	}
	.catname {
		flex: 1;
		text-align: left;
		font-weight: 600;
	}
	.catcount {
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
	.catalog ul {
		list-style: none;
		margin: 0;
		padding: 4px;
		border-top: 1px solid var(--border);
	}
	.catalog ul button {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		text-align: left;
		padding: 5px 8px;
		border: 0;
		border-radius: 5px;
		background: transparent;
		color: var(--text);
		cursor: pointer;
		font-size: 13px;
	}
	.catalog ul button:hover {
		background: var(--panel-hi);
	}
	.catalog ul button.sel {
		background: var(--accent-dim);
	}
	.more {
		width: 100%;
		padding: 5px;
		border: 0;
		border-top: 1px solid var(--border);
		background: transparent;
		color: var(--muted);
		font-size: 12px;
		cursor: pointer;
	}
	.more:hover {
		background: var(--panel-hi);
		color: var(--accent);
	}
	.rank {
		flex: 0 0 22px;
		text-align: right;
		color: var(--muted);
		font-family: var(--font-mono-retro);
	}
	.name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.pts {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		color: var(--muted);
		font-size: 11px;
	}
	.detail {
		overflow: hidden;
		min-height: 0;
		padding: 18px 20px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.dhead h2 {
		margin: 0;
		font-size: 20px;
	}
	.credit {
		margin: 2px 0 0;
		color: var(--muted);
		font-size: 13px;
	}
	.meta {
		color: var(--muted);
		font-size: 13px;
		margin: 0;
	}
	.error {
		color: #ff4136;
		padding: 0 20px;
	}
	.muted {
		color: var(--muted);
	}
	@media (max-width: 720px) {
		.cols {
			grid-template-columns: 1fr;
			grid-template-rows: auto 1fr;
		}
		.catalog {
			border-right: 0;
			border-bottom: 1px solid var(--border);
			max-height: 40vh;
		}
		/* Stacked single-column layout — the inner goes fluid (no fixed 340px). */
		.catalog-inner {
			width: 100%;
		}
	}
</style>
