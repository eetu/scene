// Thin fetch layer over the backend's JSON API. Types are hand-written to match
// the Rust structs (no codegen — see sibling-app). Keep in sync with
// backend/src/routes.rs.
//
// In the backend-less GitHub Pages build (STANDALONE) the playable half of `api`
// is swapped for a browser-local implementation — see the branch at the bottom.
import { STANDALONE } from "$lib/standalone";
import * as local from "$lib/standalone/store.svelte";

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
  /** On-disk layout: "artist" (artist/song) or "group-artist" (legacy). */
  layout: string;
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

/** A file in a "likely" (same-name, different-bytes) dupe set, with its own
 *  listener state so the UI shows which copy is referenced — delete the orphan. */
export type DupeFile = {
  path: string;
  md5: string;
  hash: string;
  favorite: boolean;
  play_count: number;
  playlists: string[];
};

export type DupesReport = {
  exact: { md5: string; paths: string[] }[];
  likely: { filename: string; files: DupeFile[] }[];
};

/** The library manifest (`library.json`) — the relational graph the filesystem
 *  tree can't hold. Mirrors the backend `Manifest` (see manifest.rs). The
 *  frontend joins it against the track index to build the group / artist /
 *  album facets. */
export type ManifestArtist = { aka?: string[]; groups?: string[] };
export type ManifestAlbum = { title?: string | null; kind?: string | null; songs?: string[] };
export type ManifestSong = { forGroup?: string | null; with?: string[]; year?: number | null };
export type Manifest = {
  artists: Record<string, ManifestArtist>;
  albums: Record<string, ManifestAlbum>;
  songs: Record<string, ManifestSong>;
};

/** Curation write payloads (mirror the backend curation API). */
export type ArtistIn = { aka: string[]; groups: string[] };
export type AlbumIn = { id?: string; title?: string; kind?: string; songs?: string[] };
export type AlbumPatch = { title?: string; kind?: string; songs?: string[] };
export type SongIn = { forGroup?: string | null; with?: string[]; year?: number | null };

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

const httpApi = {
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

  // Library manifest (aliases / group memberships / albums / credits)
  manifest: () => request<Manifest>("/api/manifest"),

  // Manifest curation (edit library.json; each write hot-swaps server-side, so
  // callers re-fetch the manifest after).
  setArtist: (name: string, body: ArtistIn) =>
    request<void>(`/api/artist/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  setSong: (md5: string, body: SongIn) =>
    request<void>(`/api/song/${md5}`, { method: "PUT", body: JSON.stringify(body) }),
  createAlbum: (body: AlbumIn) =>
    request<{ id: string }>("/api/albums", { method: "POST", body: JSON.stringify(body) }),
  updateAlbum: (id: string, body: AlbumPatch) =>
    request<void>(`/api/albums/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteAlbum: (id: string) =>
    request<void>(`/api/albums/${encodeURIComponent(id)}`, { method: "DELETE" }),
  addAlbumSong: (id: string, md5: string) =>
    request<void>(`/api/albums/${encodeURIComponent(id)}/songs`, {
      method: "POST",
      body: JSON.stringify({ md5 }),
    }),
  removeAlbumSong: (id: string, md5: string) =>
    request<void>(`/api/albums/${encodeURIComponent(id)}/songs/${md5}`, { method: "DELETE" }),
};

// The GitHub Pages build has no backend: the playable endpoints delegate to the
// browser-local store (IndexedDB bytes + localStorage catalog/playlists), plus
// `rename` (edit group/artist/filename is a pure catalog edit here — no fs). The
// remaining backend-only ones (delete/rescan/fetch-missing/dupes) keep their HTTP
// form but are never reached — their UI is hidden when STANDALONE. Written as a
// static branch on a build constant so the unused half + its imports are
// tree-shaken out of the backend build.
export const api = STANDALONE
  ? {
      ...httpApi,
      status: async (): Promise<StatusResponse> => ({
        service: "tracker",
        version: "web",
        db_healthy: true,
        track_count: local.tracks.length,
        root: "(browser)",
        layout: "group-artist",
        scanning: false,
        scan_total: 0,
        scan_processed: 0,
        scan_hashed: 0,
      }),
      tracks: async () => local.tracks,
      putMeta: local.putMeta,
      setFavorite: local.setFavorite,
      play: local.recordPlay,
      rename: async (req: RenameRequest) => local.rename(req),
      playlists: async () => local.playlists.list(),
      createPlaylist: async (name: string) => local.playlists.create(name),
      getPlaylist: async (id: string) => local.playlists.get(id),
      renamePlaylist: async (id: string, name: string) => local.playlists.rename(id, name),
      deletePlaylist: async (id: string) => local.playlists.remove(id),
      addToPlaylist: async (id: string, item: ImportItem) => local.playlists.add(id, item),
      reorderPlaylist: async (id: string, ids: number[]) => local.playlists.reorder(id, ids),
      removeFromPlaylist: async (id: string, itemId: number) =>
        local.playlists.removeItem(id, itemId),
      importPlaylist: async (doc: ImportDoc) => local.playlists.import(doc),
      exportPlaylist: async (id: string) => local.playlists.export(id),
      libraryMd5: async () => local.tracks.map((t) => t.md5).filter((m): m is string => !!m),
      fetchStatus: async (): Promise<FetchStatus> => ({
        running: false,
        total: 0,
        fetched: 0,
        failed: 0,
      }),
      dupes: async (): Promise<DupesReport> => ({ exact: [], likely: [] }),
      // The Pages build ships no manifest (no curation graph) — empty is fine;
      // facets fall back to path-derived group/artist. Curation is a no-op there.
      manifest: async (): Promise<Manifest> => ({ artists: {}, albums: {}, songs: {} }),
      setArtist: async () => {},
      setSong: async () => {},
      createAlbum: async () => ({ id: "" }),
      updateAlbum: async () => {},
      deleteAlbum: async () => {},
      addAlbumSong: async () => {},
      removeAlbumSong: async () => {},
    }
  : httpApi;

/** URL for the raw module bytes (player + WASM metadata extraction). Backend
 *  build → `/api/file/{hash}`; Pages build → an in-memory object URL. */
export function fileUrl(hash: string): string {
  return STANDALONE ? local.objectUrl(hash) : `/api/file/${hash}`;
}
