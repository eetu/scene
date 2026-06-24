// Thin fetch layer over the backend's JSON API. Types are hand-written to match
// the Rust structs (no codegen — see sibling-app). Keep in sync with
// backend/src/routes.rs.

/** One library entry. Path-derived fields are always present; the rest come
 *  from the metadata cache and are null until enrichment fills them. */
export type Track = {
	hash: string;
	path: string;
	group: string;
	artist: string | null;
	filename: string;
	ext: string;
	size: number;
	title: string | null;
	type_long: string | null;
	tracker: string | null;
	duration: number | null;
	channels: number | null;
	instruments: number | null;
	samples: number | null;
	favorite: boolean;
	play_count: number;
};

export type StatusResponse = {
	service: string;
	version: string;
	db_healthy: boolean;
	track_count: number | null;
	root: string;
	// Live scan progress (lock-free counters; safe to poll during a scan).
	scanning: boolean;
	scan_total: number;
	scan_processed: number;
	scan_hashed: number;
};

export type RescanResult = {
	indexed: number;
	hashed: number;
	removed: number;
};

/** Rename / move a module: edit its group / artist / filename segments. */
export type RenameRequest = {
	from: string;
	group: string;
	artist: string | null;
	filename: string;
};

export type RenameResult = {
	path: string;
	group: string;
	artist: string | null;
	filename: string;
	ext: string;
};

/** Metadata the frontend parses via libopenmpt WASM and writes back. */
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

/** Thrown for any non-2xx response; carries the HTTP status. */
export class ApiError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
		this.name = 'ApiError';
	}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, {
		headers: {
			accept: 'application/json',
			...(init?.body ? { 'content-type': 'application/json' } : {})
		},
		...init
	});
	if (!res.ok) {
		throw new ApiError(res.status, `${init?.method ?? 'GET'} ${path} → ${res.status}`);
	}
	if (res.status === 204) {
		return undefined as T;
	}
	return res.json() as Promise<T>;
}

export const api = {
	status: () => request<StatusResponse>('/status'),
	tracks: () => request<{ tracks: Track[] }>('/api/tracks').then((r) => r.tracks),
	rescan: () => request<RescanResult>('/api/rescan', { method: 'POST' }),
	putMeta: (hash: string, meta: MetaIn) =>
		request<void>(`/api/meta/${hash}`, { method: 'POST', body: JSON.stringify(meta) }),
	rename: (req: RenameRequest) =>
		request<RenameResult>('/api/rename', { method: 'POST', body: JSON.stringify(req) }),
	setFavorite: (hash: string, favorite: boolean) =>
		request<void>(`/api/favorite/${hash}`, {
			method: 'POST',
			body: JSON.stringify({ favorite })
		}),
	play: (hash: string) => request<{ play_count: number }>(`/api/play/${hash}`, { method: 'POST' })
};

/** URL for the raw module bytes (player + WASM metadata extraction). */
export function fileUrl(hash: string): string {
	return `/api/file/${hash}`;
}
