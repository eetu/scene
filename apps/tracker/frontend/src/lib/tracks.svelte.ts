// A sparse, reactive cache of hydrated library rows, keyed by `files.id`.
//
// The library list is now driven by an *ordered id stream* from
// `/api/library/ids` — the whole index no longer fits in the browser once HVSC
// is in the collection. Rows arrive here a window at a time as the virtualizer
// scrolls, and the same cache backs the player's queue resolver, so a track the
// list has already shown never costs a second request.
//
// `SvelteMap` (not a plain Map in `$state`) so a write notifies exactly the
// readers of that key — a plain `$state` Map would re-run every consumer of the
// whole map on each window that lands.
import { SvelteMap } from "svelte/reactivity";

import { api, type Track } from "$lib/api";
import { STANDALONE } from "$lib/standalone";
import * as standalone from "$lib/standalone/store.svelte";

const cache = new SvelteMap<number, Track>();

/** In-flight hydrations, so overlapping scroll windows don't re-request the same
 *  ids. Keyed by id; resolves once that id's batch lands.
 *
 *  Deliberately a plain Map, not a SvelteMap: nothing renders from it, and
 *  making request bookkeeping reactive would invalidate readers on every fetch
 *  start and finish for no visible effect. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const inFlight = new Map<number, Promise<void>>();

/** Rows fetched per request. A viewport is tens of rows; asking for a bigger
 *  slab than that mostly buys prefetch for a fast scroll. The backend caps at
 *  1000, so this stays well under it. */
const BATCH = 200;

/** A hydrated row, or null when it hasn't arrived yet. Reactive: a component
 *  reading this re-renders when the row lands. */
export function peek(id: number): Track | null {
  return cache.get(id) ?? null;
}

/** Fetch any of `ids` that aren't cached or already in flight. Safe to call on
 *  every scroll tick — it de-duplicates against both. */
export async function hydrate(ids: number[]): Promise<void> {
  const missing = ids.filter((id) => id > 0 && !cache.has(id) && !inFlight.has(id));
  if (!missing.length) return;

  // The backend-less build has no `/api/tracks/batch` to ask: the rows are
  // already in the browser-local store, and the id stream was shaped from them.
  // Without this the list renders nothing — the ids arrive, every `peek` misses,
  // and each row falls back to its placeholder — while the counts, which read the
  // store directly, look perfectly correct.
  if (STANDALONE) {
    // A throwaway index for this call, not state: nothing renders from it.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const byId = new Map(standalone.tracks.map((t) => [t.id, t]));
    for (const id of missing) {
      const t = byId.get(id);
      if (t) cache.set(id, t);
    }
    return;
  }

  const batches: Promise<void>[] = [];
  for (let i = 0; i < missing.length; i += BATCH) {
    const slice = missing.slice(i, i + BATCH);
    const p = api
      .tracksBatch(slice)
      .then((rows) => {
        for (const t of rows) cache.set(t.id, t);
      })
      .catch(() => {
        // Leave the ids uncached: the next scroll over them retries. A failed
        // window shows placeholders rather than breaking the list.
      })
      .finally(() => {
        for (const id of slice) inFlight.delete(id);
      });
    for (const id of slice) inFlight.set(id, p);
    batches.push(p);
  }
  await Promise.all(batches);
}

/** A row, fetching it if needed. This is what the player's queue resolver uses. */
export async function resolve(id: number): Promise<Track | null> {
  const known = cache.get(id);
  if (known) return known;
  const pending = inFlight.get(id);
  if (pending) {
    await pending;
    return cache.get(id) ?? null;
  }
  await hydrate([id]);
  return cache.get(id) ?? null;
}

/** Seed the cache directly — for rows we already hold (a deep-link restore, or
 *  the standalone build, which has no backend to batch against). */
export function put(t: Track): void {
  if (t.id > 0) cache.set(t.id, t);
}

/** Apply a local mutation to a cached row so the list reflects it without a
 *  refetch (favourite toggles, play counts, an in-place rename). */
export function patch(id: number, fields: Partial<Track>): void {
  const t = cache.get(id);
  if (t) cache.set(id, { ...t, ...fields });
}

/** Drop everything — after a rescan, when ids may have been reassigned. */
export function clear(): void {
  cache.clear();
  inFlight.clear();
}
