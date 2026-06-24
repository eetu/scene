// The seam between the app-agnostic player engine (player.svelte.ts) and the
// host app. The engine only needs a Track-shaped object plus a few hooks; each
// app injects its own implementation once at startup via `setPlayerHost`.

/** The minimal track shape the player reads/mutates. Each app's richer track
 *  type (tracker's library entry, party's production primary) is structurally
 *  assignable to this. Identity for queueing is `path ?? hash` (tracker has
 *  duplicate-content modules at different paths; party is hash-only). */
export type Track = {
	hash: string;
	filename: string;
	path?: string;
	title?: string | null;
	group?: string | null;
	artist?: string | null;
	duration?: number | null;
	type_long?: string | null;
	tracker?: string | null;
	channels?: number | null;
	instruments?: number | null;
	samples?: number | null;
	play_count?: number;
};

/** Metadata written back to the backend cache after a parse (per app's /api/meta). */
export type MetaIn = {
	title?: string | null;
	type_long?: string | null;
	tracker?: string | null;
	duration?: number | null;
	channels?: number | null;
	instruments?: number | null;
	samples?: number | null;
	n_orders?: number | null;
	n_patterns?: number | null;
};

export type PlayerHost = {
	/** Used as the Now-Playing artist fallback. */
	appName: string;
	/** URL for a module's raw bytes by content hash. */
	fileUrl: (hash: string) => string;
	/** Record a play once listened past the threshold; returns the new total. */
	play: (hash: string) => Promise<{ play_count: number }>;
	/** Persist parsed metadata (best-effort cache write). */
	putMeta: (hash: string, meta: MetaIn) => Promise<void>;
};

let current: PlayerHost | null = null;

/** Register the host. Call once at app init (e.g. a side-effect import in the
 *  root layout) before any playback. */
export function setPlayerHost(h: PlayerHost): void {
	current = h;
}

export function host(): PlayerHost {
	if (!current) {
		throw new Error('@scene/player: host not set — call setPlayerHost() at app init');
	}
	return current;
}
