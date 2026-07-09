// Thin fetch layer over the backend's JSON API. Types are hand-written to match
// the Rust structs (no codegen — see sibling-app). Keep in sync with
// backend/src/routes.rs.

/** One library entry. Path-derived fields are always present; the rest come
 *  from the metadata cache and are null until enrichment fills them. `md5` is
 *  the portable id shared with playlists / external services. */
export type Track = {
  hash: string;
  md5: string | null;
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

/** A playlist header (no items). `kind` is 'user' or 'imported'. */
export type Playlist = {
  id: string;
  name: string;
  kind: string;
  source_ref: string | null;
  item_count: number;
  created_at: string;
  updated_at: string;
};

/** A playlist entry. `id` is the stable surrogate (reorder/remove). When present
 *  locally, fields come from the library (and `hash` is the content_hash for
 *  playback); when missing they fall back to the cached metadata. */
export type PlaylistItem = {
  id: number;
  position: number;
  md5: string | null;
  present: boolean;
  hash: string | null;
  path: string | null;
  group: string | null;
  artist: string | null;
  filename: string | null;
  ext: string | null;
  size: number | null;
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

export type PlaylistDetail = {
  playlist: Playlist;
  items: PlaylistItem[];
};

/** One item in an import/export document. Needs an md5 (local match) and/or a
 *  fetch reference — a Modland `path` and/or a direct-download `url` (for sources
 *  Modland doesn't carry); the rest is cached metadata. */
export type ImportItem = {
  md5?: string | null;
  path?: string | null;
  url?: string | null;
  title?: string | null;
  artist?: string | null;
  format?: string | null;
  filename?: string | null;
};

export type ImportDoc = {
  name: string;
  source?: string | null;
  items: ImportItem[];
};

/** Live progress of a "fetch missing" run (poll while `running`). */
export type FetchStatus = {
  running: boolean;
  total: number;
  fetched: number;
  failed: number;
};

export type DupesReport = {
  exact: { md5: string; paths: string[] }[];
  likely: { filename: string; files: { path: string; md5: string }[] }[];
};

/** A present playlist item carries every field a Track needs for playback. */
export function itemToTrack(i: PlaylistItem): Track {
  return {
    hash: i.hash ?? "",
    md5: i.md5,
    path: i.path ?? "",
    group: i.group ?? "",
    artist: i.artist,
    filename: i.filename ?? "",
    ext: i.ext ?? "",
    size: i.size ?? 0,
    title: i.title,
    type_long: i.type_long,
    tracker: i.tracker,
    duration: i.duration,
    channels: i.channels,
    instruments: i.instruments,
    samples: i.samples,
    favorite: i.favorite,
    play_count: i.play_count,
  };
}

/** Thrown for any non-2xx response; carries the HTTP status. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
    ...init,
  });
  if (!res.ok) {
    throw new ApiError(res.status, `${init?.method ?? "GET"} ${path} → ${res.status}`);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

export const api = {
  status: () => request<StatusResponse>("/status"),
  tracks: () => request<{ tracks: Track[] }>("/api/tracks").then((r) => r.tracks),
  rescan: () => request<RescanResult>("/api/rescan", { method: "POST" }),
  putMeta: (hash: string, meta: MetaIn) =>
    request<void>(`/api/meta/${hash}`, { method: "POST", body: JSON.stringify(meta) }),
  rename: (req: RenameRequest) =>
    request<RenameResult>("/api/rename", { method: "POST", body: JSON.stringify(req) }),
  deleteTrack: (path: string) =>
    request<{ path: string; removed: number }>("/api/delete", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  setFavorite: (hash: string, favorite: boolean) =>
    request<void>(`/api/favorite/${hash}`, {
      method: "POST",
      body: JSON.stringify({ favorite }),
    }),
  play: (hash: string) => request<{ play_count: number }>(`/api/play/${hash}`, { method: "POST" }),

  // Playlists (md5-keyed)
  playlists: () => request<{ playlists: Playlist[] }>("/api/playlists").then((r) => r.playlists),
  createPlaylist: (name: string) =>
    request<Playlist>("/api/playlists", { method: "POST", body: JSON.stringify({ name }) }),
  getPlaylist: (id: string) => request<PlaylistDetail>(`/api/playlists/${id}`),
  renamePlaylist: (id: string, name: string) =>
    request<void>(`/api/playlists/${id}`, { method: "POST", body: JSON.stringify({ name }) }),
  deletePlaylist: (id: string) => request<void>(`/api/playlists/${id}`, { method: "DELETE" }),
  addToPlaylist: (id: string, item: ImportItem) =>
    request<void>(`/api/playlists/${id}/items`, { method: "POST", body: JSON.stringify(item) }),
  reorderPlaylist: (id: string, ids: number[]) =>
    request<void>(`/api/playlists/${id}/items`, { method: "PUT", body: JSON.stringify({ ids }) }),
  removeFromPlaylist: (id: string, itemId: number) =>
    request<void>(`/api/playlists/${id}/items/${itemId}`, { method: "DELETE" }),

  // Import / export
  importPlaylist: (doc: ImportDoc) =>
    request<Playlist>("/api/playlists/import", { method: "POST", body: JSON.stringify(doc) }),
  exportPlaylist: (id: string) => request<ImportDoc>(`/api/playlists/${id}/export`),
  libraryMd5: () => request<{ md5: string[] }>("/api/library/md5").then((r) => r.md5),

  // Fetch missing songs (by Modland path)
  fetchMissing: (id: string) =>
    request<{ started: boolean }>(`/api/playlists/${id}/fetch-missing`, { method: "POST" }),
  fetchStatus: () => request<FetchStatus>("/api/fetch/status"),

  // Duplicate report
  dupes: () => request<DupesReport>("/api/dupes"),
};

/** URL for the raw module bytes (player + WASM metadata extraction). */
export function fileUrl(hash: string): string {
  return `/api/file/${hash}`;
}
