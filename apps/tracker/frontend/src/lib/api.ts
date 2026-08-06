// Thin fetch layer over the backend's JSON API. Types are hand-written to match
// the Rust structs (no codegen — see sibling-app). Keep in sync with
// backend/src/routes.rs.
//
// In the backend-less GitHub Pages build (STANDALONE) the playable half of `api`
// is swapped for a browser-local implementation — see the branch at the bottom.
import type { TrackNote } from "@scene/player";

import { STANDALONE } from "$lib/standalone";
import * as local from "$lib/standalone/store.svelte";

/** One library entry. Path-derived fields are always present; the rest come
 *  from the metadata cache and are null until enrichment fills them. `md5` is
 *  the portable id shared with playlists / external services. */
export type Track = {
  /** The playable track's id: the file's surrogate id with its subtune folded
   *  in. The key the shaped library streams and the client hydrates, queues and
   *  plays by — a SID file holding twelve tunes is twelve entries. */
  id: number;
  /** Which subtune of the file this is (0 for a module, and for a single-tune
   *  file). The engine selects it after loading the bytes. */
  subsong: number;
  /** How many subtunes the file holds; 0 when it isn't multi-tune. */
  subsongs: number;
  hash: string;
  md5: string | null;
  path: string;
  /** The configured root this file lives in (`mods`, `hvsc`, …) — the axis the
   *  library's source selector filters on. */
  collection: string;
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

/** The library query the backend shapes on — mirrors `library::Query` (Rust).
 *  Every field is optional here; the backend defaults each one. */
export type LibraryQuery = {
  collection?: string;
  fav?: boolean;
  fmt?: string;
  tracker?: string;
  q?: string;
  group_by?: "group" | "artist" | "ext" | "album";
  track_sort?: "name" | "duration" | "channels" | "plays";
  group_sort?: "name" | "plays" | "size";
};

/** One bucket of the shaped library: a header name plus its track ids in order. */
export type LibraryBucket = { name: string; ids: number[] };

/** The shaped library. The ids across all buckets, in order, are the play queue
 *  — the client permutes *indices* into this for shuffle, which is what keeps
 *  `prev` retracing the same history and the order surviving a reload. */
export type ShapedLibrary = {
  groups: LibraryBucket[];
  total: number;
  formats: string[];
  trackers: string[];
};

/** One configured collection root, as reported by `/status`. */
export type Root = {
  id: string;
  label: string;
  kind: "scan" | "hvsc";
  path: string;
  /** Indexed tracks in this root; null while a scan holds the DB. */
  count: number | null;
};

/** What an HVSC root knows about itself, from its own DOCUMENTS/. `null` for a
 *  root that is configured but not yet indexed — which is a real state (the
 *  collection may still be copying), and reads differently from "not HVSC". */
export type HvscState = {
  /** Release number off the HVSC.txt banner; null when it couldn't be read. */
  version: number | null;
  tunes: number;
  subtunes: number;
  indexed_at: string;
} | null;

export type StatusResponse = {
  service: string;
  version: string;
  db_healthy: boolean;
  track_count: number | null;
  /** The primary root's path. Kept for display; `roots` is the real list. */
  root: string;
  roots: Root[];
  /** Per-root HVSC facts, keyed by root id. Empty when no HVSC root is
   *  configured — that absence is the feature flag the UI keys off, so nothing
   *  HVSC-specific renders on an install without a collection. */
  hvsc: Record<string, HvscState>;
  /** Seconds to play a SID with no known length. A fallback for playback only —
   *  never displayed as if it were the tune's real duration. */
  sid_default_length: number;
  // Live scan progress (lock-free counters; safe to poll during a scan).
  scanning: boolean;
  scan_total: number;
  scan_processed: number;
  scan_hashed: number;
  /** Outcome of the last finished scan; null until one has run. */
  last_scan: ScanOutcome | null;
};

/** What the last finished scan did, from `/status`.
 *
 *  A walked root's rescan answers 202 and reports nothing, so this is the only
 *  place its counts — or its failure — appear. */
export type ScanOutcome = {
  root: string;
  indexed: number;
  hashed: number;
  removed: number;
  finished_at: string;
  /** Set when the scan failed; the counts are 0 then, so a failure can't be
   *  mistaken for "scanned, found nothing". */
  error: string | null;
};

export type RescanResult = {
  /** Walked roots: the scan was accepted (202) and runs in the background.
   *  Follow it via `/status.scanning`, then read `/status.last_scan`. */
  started?: boolean;
  root?: string;
  /** HVSC reindex only — it finishes in seconds, so it answers 200 with counts. */
  indexed?: number;
  hashed?: number;
  removed?: number;
  /** HVSC reindex only — one row per subtune, so it exceeds `indexed`. */
  subtunes?: number;
};

/** Rename / move a module: edit its group / artist / filename segments. */
export type RenameRequest = {
  from: string;
  /** The track's collection; omitted → the backend's primary root. */
  root?: string;
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
  /** Root of the local file this resolved to; null when not present locally. */
  collection: string | null;
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
  /** Identical bytes at several paths — one content hash for the whole set. */
  exact: { md5: string; hash: string; paths: string[] }[];
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
    // A playlist item carries no `files.id`; 0 marks "not an index row", which
    // is honest — an absent item has no library row to hydrate or resolve.
    id: 0,
    subsong: 0,
    subsongs: 0,
    hash: i.hash ?? "",
    md5: i.md5,
    path: i.path ?? "",
    // Null for an item with no local file — it belongs to no collection yet.
    collection: i.collection ?? "",
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
    // Prefer the backend's own words. Its 4xx bodies are written to be read
    // ("root \"hvsc\" has no DOCUMENTS/Songlengths.md5"), and the standalone
    // store already throws ApiError with human-facing messages — so a toast
    // showing `POST /api/… → 400` was throwing away the useful half. Falls back
    // to the method/status form for an empty body or an HTML error page from a
    // proxy, neither of which says anything a user can act on.
    let detail = "";
    try {
      const body = (await res.text()).trim();
      if (body && !body.startsWith("<") && body.length <= 300) detail = body;
    } catch {
      /* body already consumed or unreadable — the fallback still holds */
    }
    throw new ApiError(res.status, detail || `${init?.method ?? "GET"} ${path} → ${res.status}`);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

const httpApi = {
  status: () => request<StatusResponse>("/status"),
  tracks: () => request<{ tracks: Track[] }>("/api/tracks").then((r) => r.tracks),
  /** The shaped library: an ordered id stream grouped into buckets. Replaces
   *  pulling the whole index client-side, which stops scaling once HVSC is in. */
  libraryIds: (q: LibraryQuery = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (v !== undefined && v !== "" && v !== false) p.set(k, String(v));
    }
    const qs = p.toString();
    return request<ShapedLibrary>(`/api/library/ids${qs ? `?${qs}` : ""}`);
  },
  /** A page of tracks still lacking parsed metadata, plus the total outstanding.
   *  SIDs are excluded server-side (their header is parsed in Rust). */
  unenriched: () => request<{ count: number; tracks: Track[] }>("/api/library/unenriched"),
  /** One track by content hash — the `?t=` deep-link restore, which can't search
   *  a list the browser no longer holds. Null when it isn't indexed. */
  trackByHash: (hash: string) =>
    request<{ track: Track }>(`/api/track/${hash}`)
      .then((r) => r.track)
      .catch(() => null),
  /** Hydrate a window of the id stream. Rows come back in the requested order. */
  tracksBatch: (ids: number[]) =>
    ids.length
      ? request<{ tracks: Track[] }>(`/api/tracks/batch?ids=${ids.join(",")}`).then((r) => r.tracks)
      : Promise.resolve([]),
  /** Curator notes for a track (STIL). Its own call rather than a track column:
   *  the notes run to paragraphs and only the player pane wants them, once per
   *  tune played. Failures resolve to none — it's decoration. */
  stil: (id: number) =>
    request<{ notes: TrackNote[] }>(`/api/stil/${id}`)
      .then((r) => r.notes)
      .catch(() => []),
  rescan: () => request<RescanResult>("/api/rescan", { method: "POST" }),
  /** Reindex one root. For an HVSC root this rebuilds from its own catalogue —
   *  a single 5MB read, not a walk — which is why it's safe as a UI button at a
   *  scale where a filesystem rescan wouldn't be. */
  rescanRoot: (root: string) =>
    request<RescanResult>(`/api/rescan/${encodeURIComponent(root)}`, { method: "POST" }),
  putMeta: (hash: string, meta: MetaIn) =>
    request<void>(`/api/meta/${hash}`, { method: "POST", body: JSON.stringify(meta) }),
  rename: (req: RenameRequest) =>
    request<RenameResult>("/api/rename", { method: "POST", body: JSON.stringify(req) }),
  deleteTrack: (path: string) =>
    request<{ path: string; removed: number }>("/api/delete", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  // Both are per-subtune: a SID's tunes are favourited and counted separately,
  // so the hash alone no longer identifies the thing being written.
  setFavorite: (hash: string, favorite: boolean, subsong = 0) =>
    request<void>(`/api/favorite/${hash}`, {
      method: "POST",
      body: JSON.stringify({ favorite, subsong }),
    }),
  play: (hash: string, subsong = 0) =>
    request<{ play_count: number }>(`/api/play/${hash}?subsong=${subsong}`, { method: "POST" }),
  /** Record a subtune's real length, or clear it (null) to fall back again. */
  setSongLength: (hash: string, subsong: number, duration: number | null) =>
    request<void>(`/api/song-length/${hash}`, {
      method: "POST",
      body: JSON.stringify({ subsong, duration }),
    }),

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
        // No HVSC in the browser-local build: it's a mounted collection, and
        // there's nothing to mount. Empty keeps the feature flag off.
        hvsc: {},
        // Nothing scans here either — the library is whatever was dropped in.
        last_scan: null,
        roots: [
          {
            id: "mods",
            label: "Mods",
            kind: "scan",
            path: "(browser)",
            count: local.tracks.length,
          },
        ],
        sid_default_length: 180,
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
