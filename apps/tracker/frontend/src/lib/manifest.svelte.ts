// Reactive holder for the library manifest (`library.json`): fetches it once at
// boot and rebuilds the inverse index (see manifest.ts) when it changes. The
// pure transforms live in manifest.ts; this is just the store + the memoised
// index getter the derivations read.
//
// Consumers read `manifestIndex()` inside a `$derived` — it tracks
// `manifestStore.data`, so a reload re-groups the list. In the backend-less
// Pages build the fetch returns an empty manifest, so facets fall back to
// path-derived group/artist.
import { browser } from "$app/environment";
import { api, type Manifest } from "$lib/api";
import { buildIndex, EMPTY_INDEX, type ManifestIndex } from "$lib/manifest";

export const manifestStore = $state({
  data: null as Manifest | null,
  loaded: false,
});

// Memoise the built index on `data` identity — buildIndex runs once per reload,
// not once per derivation read. (Svelte disallows exporting a `$derived`, hence
// a getter; the read of `manifestStore.data` inside it keeps callers reactive.)
let cachedFor: Manifest | null = null;
let cachedIndex: ManifestIndex = EMPTY_INDEX;

export function manifestIndex(): ManifestIndex {
  if (manifestStore.data !== cachedFor) {
    cachedFor = manifestStore.data;
    cachedIndex = manifestStore.data ? buildIndex(manifestStore.data) : EMPTY_INDEX;
  }
  return cachedIndex;
}

/** (Re)fetch `library.json` and swap it in. Called at boot and after a curation
 *  edit. Non-fatal on failure — the graph is enrichment, so facets degrade to
 *  path-derived group/artist. */
export async function reloadManifest(): Promise<void> {
  try {
    manifestStore.data = await api.manifest();
  } catch {
    /* non-fatal — keep the last-known (or empty) manifest */
  } finally {
    manifestStore.loaded = true;
  }
}

if (browser) void reloadManifest();
