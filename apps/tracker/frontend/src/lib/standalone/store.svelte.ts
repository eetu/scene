// The backend-less library for the GitHub Pages build. Modules come from the
// file picker / drag-drop / folder / zip; their bytes live in IndexedDB (keyed
// by content hash, so a set survives a reload) and the catalog + favourites +
// playlists persist in localStorage. This module is the single source the app's
// `api` shim and player host delegate to when STANDALONE is set — the rest of
// the app (list, grouping, player, playlists UI) is unchanged.
import { parseModule } from "@scene/player";
import { unzip } from "fflate";

import type {
  ImportDoc,
  ImportItem,
  MetaIn,
  Playlist,
  PlaylistDetail,
  PlaylistItem,
  Track,
} from "$lib/api";
import { toMeta } from "$lib/enrich";
import { extOf, isModule } from "$lib/standalone";
import * as idb from "$lib/standalone/idb";

const CATALOG_KEY = "tracker.standalone.catalog.v2";
const PLAYLISTS_KEY = "tracker.standalone.playlists.v1";

/** The library, shared with `library.tracks` (same proxy) so the list reacts. */
export const tracks = $state<Track[]>([]);

// hash → object URL for playback (host.fileUrl reads this synchronously, so every
// track's URL is created on add / rehydrate before it can be played). A plain
// Map on purpose — it's a lookup table, not reactive state (the reactive part is
// `tracks`).
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const urls = new Map<string, string>();

// ---------------------------------------------------------------- catalog ----
function persistCatalog(): void {
  try {
    localStorage.setItem(CATALOG_KEY, JSON.stringify(tracks));
  } catch {
    /* quota / private mode — the in-memory library still works this session */
  }
}

/** Object URL for a module's bytes (empty string if not resident). */
export function objectUrl(hash: string): string {
  return urls.get(hash) ?? "";
}

async function sha256(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function makeTrack(relPath: string, hash: string, size: number): Track {
  const parts = relPath.split("/").filter(Boolean);
  const filename = parts.pop() ?? relPath;
  return {
    hash,
    md5: hash, // stable key; playlists are md5-keyed and this ties them to bytes
    path: relPath,
    group: parts[0] ?? "",
    artist: parts.length > 1 ? parts[1] : null,
    filename,
    ext: extOf(filename),
    size,
    title: null,
    type_long: null,
    tracker: null,
    duration: null,
    channels: null,
    instruments: null,
    samples: null,
    favorite: false,
    play_count: 0,
  };
}

// -------------------------------------------------------------- intake ----
type Entry = { path: string; bytes: ArrayBuffer };

/** Unzip an archive into its module entries (flat, keeping inner paths). */
function unzipEntries(buf: ArrayBuffer): Promise<Entry[]> {
  return new Promise((resolve) => {
    unzip(new Uint8Array(buf), (err, files) => {
      if (err) return resolve([]);
      const out: Entry[] = [];
      for (const [name, data] of Object.entries(files)) {
        if (data.length && isModule(name)) {
          // Copy out of fflate's shared buffer view into a standalone ArrayBuffer.
          out.push({ path: name, bytes: data.slice().buffer });
        }
      }
      resolve(out);
    });
  });
}

async function fileEntries(file: File): Promise<Entry[]> {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
  if (extOf(file.name) === "zip") return unzipEntries(await file.arrayBuffer());
  if (isModule(file.name)) return [{ path: rel, bytes: await file.arrayBuffer() }];
  return [];
}

/** Add already-resolved entries (path + bytes) — the group/artist come from the
 *  path. Dedupes by content hash. Returns how many new modules landed. */
async function addEntries(entries: Entry[]): Promise<number> {
  let added = 0;
  for (const e of entries) {
    const hash = await sha256(e.bytes);
    if (urls.has(hash)) continue; // dedupe by content
    await idb.put(hash, e.bytes).catch(() => {});
    urls.set(hash, URL.createObjectURL(new Blob([e.bytes])));
    tracks.push(makeTrack(e.path, hash, e.bytes.byteLength));
    added++;
  }
  if (added) {
    persistCatalog();
    void parsePending();
  }
  return added;
}

/** Add dropped / picked files (and any zips). Returns how many new modules landed. */
export async function addFiles(files: File[] | FileList): Promise<number> {
  const list = Array.from(files);
  const entries: Entry[] = [];
  for (const f of list) entries.push(...(await fileEntries(f)));
  return addEntries(entries);
}

// ---------------------------------------------------- metadata (parse) ----
let parsing = false;
/** Parse metadata for any tracks still lacking it (title/duration/etc.), so the
 *  list fills in without playing each one. Sequential + best-effort. */
async function parsePending(): Promise<void> {
  if (parsing) return;
  parsing = true;
  try {
    for (const t of tracks) {
      if (t.type_long) continue;
      try {
        const buf = await idb.get(t.hash);
        if (!buf) continue;
        const m = await parseModule(buf);
        if (m) applyMeta(t, toMeta(m));
      } catch {
        /* skip unparsable module */
      }
    }
    persistCatalog();
  } finally {
    parsing = false;
  }
}

function applyMeta(t: Track, meta: MetaIn): void {
  t.title = meta.title ?? t.title;
  t.type_long = meta.type_long ?? null;
  t.tracker = meta.tracker ?? null;
  t.duration = meta.duration ?? null;
  t.channels = meta.channels ?? null;
  t.instruments = meta.instruments ?? null;
  t.samples = meta.samples ?? null;
}

// ------------------------------------------------- host-side callbacks ----
/** Player host `putMeta`: reflect a parse onto the track + persist. */
export async function putMeta(hash: string, meta: MetaIn): Promise<void> {
  const t = tracks.find((x) => x.hash === hash);
  if (t) {
    applyMeta(t, meta);
    persistCatalog();
  }
}

/** Player host `play`: bump the local play count. */
export async function recordPlay(hash: string): Promise<{ play_count: number }> {
  const t = tracks.find((x) => x.hash === hash);
  if (!t) return { play_count: 0 };
  t.play_count += 1;
  persistCatalog();
  return { play_count: t.play_count };
}

export async function setFavorite(hash: string, favorite: boolean): Promise<void> {
  const t = tracks.find((x) => x.hash === hash);
  if (t) {
    t.favorite = favorite;
    persistCatalog();
  }
}

/** Forget everything (catalog + bytes + playlists). */
export async function clearAll(): Promise<void> {
  for (const u of urls.values()) URL.revokeObjectURL(u);
  urls.clear();
  await Promise.all(tracks.map((t) => idb.del(t.hash).catch(() => {})));
  tracks.splice(0, tracks.length);
  localStorage.removeItem(CATALOG_KEY);
  localStorage.removeItem(PLAYLISTS_KEY);
}

// --------------------------------------------------------- demo seed ----
const SEEDED_KEY = "tracker.standalone.seeded.v1";
// Bundled at deploy time by the pages workflow (not committed) → served
// same-origin. import.meta.env.BASE_URL is '/' in dev, '/scene/' on Pages.
const DEMO_URL = (import.meta.env.BASE_URL || "/") + "demo/2nd_pm.s3m";

/** First-run convenience: with an empty library and no prior seed, pull the
 *  bundled demo module (Purple Motion — the "Second Reality" theme) so there's
 *  something to play immediately. Best-effort; silently skips when it isn't
 *  bundled (e.g. local dev) or the user has already loaded / cleared a set. */
export async function seedDemoIfEmpty(): Promise<void> {
  try {
    if (tracks.length > 0 || localStorage.getItem(SEEDED_KEY)) return;
    const res = await fetch(DEMO_URL);
    if (!res.ok) return;
    // Path → group / artist: this is Purple Motion's Second Reality tune.
    await addEntries([
      { path: "Future Crew/Purple Motion/2nd_pm.s3m", bytes: await res.arrayBuffer() },
    ]);
    localStorage.setItem(SEEDED_KEY, "1");
  } catch {
    /* offline or not bundled — no seed, just the empty drop zone */
  }
}

// ----------------------------------------------------------- rehydrate ----
let rehydrated = false;
/** Restore the catalog + recreate object URLs from IndexedDB on boot. Idempotent. */
export async function rehydrate(): Promise<void> {
  if (rehydrated) return;
  rehydrated = true;
  let saved: Track[];
  try {
    saved = JSON.parse(localStorage.getItem(CATALOG_KEY) ?? "[]");
  } catch {
    saved = [];
  }
  for (const t of saved) {
    const buf = await idb.get(t.hash).catch(() => undefined);
    if (!buf) continue; // bytes evicted — drop the stale catalog row
    urls.set(t.hash, URL.createObjectURL(new Blob([buf])));
    tracks.push(t);
  }
  void parsePending();
}

// ----------------------------------------------------- local playlists ----
// Backs the api playlist methods so the existing PlaylistsTab / AddToPlaylist UI
// works unchanged. Items are md5-keyed (md5 === content hash here).
type LItem = Pick<ImportItem, "md5" | "title" | "artist" | "format" | "filename"> & { id: number };
type LPlaylist = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  items: LItem[];
};

function loadLists(): LPlaylist[] {
  try {
    return JSON.parse(localStorage.getItem(PLAYLISTS_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function saveLists(ls: LPlaylist[]): void {
  localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(ls));
}
function header(l: LPlaylist): Playlist {
  return {
    id: l.id,
    name: l.name,
    kind: "user",
    source_ref: null,
    item_count: l.items.length,
    created_at: l.created_at,
    updated_at: l.updated_at,
  };
}
function resolveItem(it: LItem, pos: number): PlaylistItem {
  const t = tracks.find((x) => x.md5 === it.md5);
  return {
    id: it.id,
    position: pos,
    md5: it.md5 ?? null,
    present: !!t,
    hash: t?.hash ?? null,
    path: t?.path ?? null,
    group: t?.group ?? null,
    artist: t?.artist ?? it.artist ?? null,
    filename: t?.filename ?? it.filename ?? null,
    ext: t?.ext ?? it.format ?? null,
    size: t?.size ?? null,
    title: t?.title ?? it.title ?? null,
    type_long: t?.type_long ?? null,
    tracker: t?.tracker ?? null,
    duration: t?.duration ?? null,
    channels: t?.channels ?? null,
    instruments: t?.instruments ?? null,
    samples: t?.samples ?? null,
    favorite: t?.favorite ?? false,
    play_count: t?.play_count ?? 0,
  };
}
const now = () => new Date().toISOString();
const nextItemId = (l: LPlaylist) => l.items.reduce((n, i) => Math.max(n, i.id), 0) + 1;

export const playlists = {
  list(): Playlist[] {
    return loadLists().map(header);
  },
  create(name: string): Playlist {
    const ls = loadLists();
    const l: LPlaylist = {
      id: crypto.randomUUID(),
      name,
      created_at: now(),
      updated_at: now(),
      items: [],
    };
    ls.push(l);
    saveLists(ls);
    return header(l);
  },
  get(id: string): PlaylistDetail {
    const l = loadLists().find((x) => x.id === id);
    if (!l) throw new Error("no such playlist");
    return { playlist: header(l), items: l.items.map(resolveItem) };
  },
  rename(id: string, name: string): void {
    const ls = loadLists();
    const l = ls.find((x) => x.id === id);
    if (l) {
      l.name = name;
      l.updated_at = now();
      saveLists(ls);
    }
  },
  remove(id: string): void {
    saveLists(loadLists().filter((x) => x.id !== id));
  },
  add(id: string, item: ImportItem): void {
    const ls = loadLists();
    const l = ls.find((x) => x.id === id);
    if (!l) return;
    l.items.push({
      id: nextItemId(l),
      md5: item.md5 ?? null,
      title: item.title ?? null,
      artist: item.artist ?? null,
      format: item.format ?? null,
      filename: item.filename ?? null,
    });
    l.updated_at = now();
    saveLists(ls);
  },
  reorder(id: string, ids: number[]): void {
    const ls = loadLists();
    const l = ls.find((x) => x.id === id);
    if (!l) return;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const byId = new Map(l.items.map((i) => [i.id, i]));
    l.items = ids.map((i) => byId.get(i)).filter((i): i is LItem => !!i);
    l.updated_at = now();
    saveLists(ls);
  },
  removeItem(id: string, itemId: number): void {
    const ls = loadLists();
    const l = ls.find((x) => x.id === id);
    if (!l) return;
    l.items = l.items.filter((i) => i.id !== itemId);
    l.updated_at = now();
    saveLists(ls);
  },
  import(doc: ImportDoc): Playlist {
    const pl = this.create(doc.name || "imported");
    for (const it of doc.items) this.add(pl.id, it);
    return this.get(pl.id).playlist;
  },
  export(id: string): ImportDoc {
    const l = loadLists().find((x) => x.id === id);
    if (!l) throw new Error("no such playlist");
    return {
      name: l.name,
      items: l.items.map((i) => ({
        md5: i.md5,
        title: i.title,
        artist: i.artist,
        format: i.format,
        filename: i.filename,
      })),
    };
  },
};
