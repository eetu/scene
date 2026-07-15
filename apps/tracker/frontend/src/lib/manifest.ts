// Pure manifest → inverse-index logic, extracted so it's node-unit-testable (see
// __tests__/library.test.ts) and mirrors the backend `Resolved` (manifest.rs).
// The reactive store that fetches + holds it lives in manifest.svelte.ts; the
// transforms live here.
import type { Manifest, ManifestSong } from "$lib/api";

/** An album as a facet option / bucket: its id plus a display label. */
export type AlbumRef = { id: string; label: string };

/** Cheap lookups over a manifest: alias→canonical, artist→groups, md5→albums,
 *  md5→credit, plus the group/album option lists for the facet controls. */
export type ManifestIndex = {
  /** Resolve any handle (folder name or aka) to its canonical artist. Unknown
   *  handles map to themselves, so an undeclared artist still browses. */
  canonical(handle: string): string;
  /** Groups a canonical artist belongs to (manifest membership). */
  groupsOf(canonicalArtist: string): string[];
  /** Albums a song (by md5) belongs to. */
  albumsOf(md5: string | null): AlbumRef[];
  /** A song's credit (by md5), if annotated. */
  credit(md5: string | null): ManifestSong | null;
  /** All group names (sorted) — facet options. */
  groups(): string[];
  /** All albums — facet options. */
  albums(): AlbumRef[];
  /** True when the manifest carries no graph (fresh / Pages build) — callers
   *  fall back to path-derived group/artist. */
  isEmpty: boolean;
};

const norm = (s: string) => s.trim().toLowerCase();

export function buildIndex(m: Manifest | null): ManifestIndex {
  const artists = m?.artists ?? {};
  const albums = m?.albums ?? {};
  const songs = m?.songs ?? {};

  const aliasToCanonical = new Map<string, string>();
  const groupSet = new Set<string>();
  for (const [name, a] of Object.entries(artists)) {
    if (!aliasToCanonical.has(norm(name))) aliasToCanonical.set(norm(name), name);
    for (const ak of a.aka ?? []) {
      const k = norm(ak);
      if (k && !aliasToCanonical.has(k)) aliasToCanonical.set(k, name);
    }
    for (const g of a.groups ?? []) groupSet.add(g);
  }

  const songAlbums = new Map<string, AlbumRef[]>();
  const albumRefs: AlbumRef[] = [];
  for (const [id, al] of Object.entries(albums)) {
    const ref: AlbumRef = { id, label: (al.title && al.title.trim()) || id };
    albumRefs.push(ref);
    for (const md5 of al.songs ?? []) {
      const k = norm(md5);
      let arr = songAlbums.get(k);
      if (!arr) {
        arr = [];
        songAlbums.set(k, arr);
      }
      arr.push(ref);
    }
  }

  const songCredits = new Map<string, ManifestSong>();
  for (const [md5, c] of Object.entries(songs)) songCredits.set(norm(md5), c);

  return {
    canonical: (h) => aliasToCanonical.get(norm(h)) ?? h,
    groupsOf: (c) => artists[c]?.groups ?? [],
    albumsOf: (md5) => (md5 ? (songAlbums.get(norm(md5)) ?? []) : []),
    credit: (md5) => (md5 ? (songCredits.get(norm(md5)) ?? null) : null),
    groups: () =>
      [...groupSet].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })),
    albums: () => albumRefs,
    isEmpty: albumRefs.length === 0 && groupSet.size === 0 && aliasToCanonical.size === 0,
  };
}

/** An empty index — the default before the manifest loads (facets fall back to
 *  path-derived group/artist). */
export const EMPTY_INDEX: ManifestIndex = buildIndex(null);
