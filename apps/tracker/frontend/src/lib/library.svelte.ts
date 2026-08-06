// Shared library data store (a rune store, like @scene/player's playback): holds
// the tracks + /status + error, and drives the scan lifecycle via scanMachine.
// The machine owns the phases (booting / scanning / loadingTracks / ready /
// rescanning / error); the injected actors here hit the api and fill this store,
// and the subscription mirrors the phase onto `loading` / `scanning` for the UI.
// Import `library` anywhere (no prop-drilling); the pure grouping/filter helpers
// live separately in $lib/library.
//
// The backend-less GitHub Pages build (STANDALONE) has no scan/enrich machines:
// the library is the browser-local store (bytes in IndexedDB, catalog in
// localStorage), mirrored onto `library.tracks` — everything below is gated off.
import { parseModule } from "@scene/player";
import { type Actor, createActor, fromPromise } from "xstate";

import { browser } from "$app/environment";
import {
  api,
  fileUrl,
  type LibraryQuery,
  type RescanResult,
  type ShapedLibrary,
  type StatusResponse,
  type Track,
} from "$lib/api";
import { enrichTracks } from "$lib/enrich";
import { enrichMachine } from "$lib/enrich-machine";
import { scanMachine } from "$lib/scan-machine";
import { STANDALONE } from "$lib/standalone";
import * as standalone from "$lib/standalone/store.svelte";
import * as tracks from "$lib/tracks.svelte";
import { queryFromView } from "$lib/view.svelte";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The query the last reshape ran with, so a repeated view change is a no-op. */
let lastQueryKey = "";
/** Generation counter: a slower in-flight reshape must not overwrite a newer
 *  one's result (typing in the search box fires several in quick succession). */
let reshapeGen = 0;

/** Re-fetch the shaped library for `q` (defaults to the current view). */
export async function reshape(q: LibraryQuery = queryFromView()): Promise<void> {
  lastQueryKey = JSON.stringify(q);
  const gen = ++reshapeGen;
  const shaped = await api.libraryIds(q);
  if (gen !== reshapeGen) return; // superseded by a newer query
  library.shaped = shaped;
}

/** Reshape unless the query is unchanged — the view store fires on any edit,
 *  including ones that don't affect the shaping. */
export function reshapeIfChanged(q: LibraryQuery): void {
  if (JSON.stringify(q) === lastQueryKey) return;
  void reshape(q).catch((e) => (library.error = msg(e)));
}

export const library = $state({
  /** The whole index, in memory. Only the STANDALONE build fills this — with a
   *  backend the index is shaped server-side and streamed as ids (see `shaped`),
   *  because it no longer fits in the browser. */
  tracks: [] as Track[],
  /** The shaped library for the current view: ordered id buckets + facet options.
   *  Null until the first fetch lands. */
  shaped: null as ShapedLibrary | null,
  status: null as StatusResponse | null,
  error: null as string | null,
  /** Initial boot / track (re)load in flight — show the first-run loader. */
  loading: true,
  /** Backend indexing or a user rescan running — show scan progress. */
  scanning: false,
  /** Bulk metadata enrichment running (driven by enrichMachine). */
  enriching: false,
  enrichDone: 0,
  enrichTotal: 0,
  /** Modules still lacking parsed metadata, as reported by the backend. */
  unenriched: 0,
});

/** How many modules still lack parsed metadata (drives the "enrich N" button).
 *  A function (not exported $derived, which Svelte disallows); reads reactive
 *  state, so it stays reactive when called in a template / $derived.
 *
 *  With a backend this is a server-reported count refreshed by
 *  {@link refreshUnenriched} — the browser no longer holds the index to count. */
export function unEnriched(): number {
  return STANDALONE ? library.tracks.filter((t) => !t.type_long).length : library.unenriched;
}

/** Re-read the outstanding-enrichment count. */
export async function refreshUnenriched(): Promise<void> {
  if (STANDALONE) return;
  try {
    library.unenriched = (await api.unenriched()).count;
  } catch {
    /* non-fatal — the button just doesn't offer itself */
  }
}

let scanActor: Actor<typeof scanMachine> | null = null;
let enrichActor: Actor<typeof enrichMachine> | null = null;

if (STANDALONE) {
  // Point the library at the browser-local store's array (same proxy → reactive)
  // and restore the saved set from IndexedDB. Skip during prerender (no browser).
  library.tracks = standalone.tracks;
  if (browser)
    standalone
      .rehydrate()
      .then(() => standalone.seedDemoIfEmpty())
      .finally(() => (library.loading = false));
  else library.loading = false;
} else {
  bootBackend();
}

function bootBackend() {
  const scan = createActor(
    scanMachine.provide({
      actors: {
        checkStatus: fromPromise(async () => {
          library.error = null;
          try {
            library.status = await api.status();
          } catch (e) {
            library.error = msg(e);
            throw e;
          }
          return library.status.scanning;
        }),
        // Poll /status only (cheap, lock-free) — never /api/tracks while the scan
        // holds the DB. Transient errors are swallowed so polling continues.
        pollStatus: fromPromise(async () => {
          await sleep(800);
          try {
            library.status = await api.status();
          } catch {
            /* transient — keep polling */
          }
          return library.status?.scanning ?? false;
        }),
        loadTracks: fromPromise(async () => {
          try {
            // Ids may have been reassigned by the scan that just ran, so the
            // hydration cache can't be trusted across one.
            tracks.clear();
            await reshape();
            await refreshUnenriched();
          } catch (e) {
            library.error = msg(e);
            throw e;
          }
        }),
        // Kick a (synchronous) rescan; poll /status in parallel for the progress
        // bar; resolve once it's done. loadingTracks reloads the fresh index after.
        rescan: fromPromise(async () => {
          library.error = null;
          let done = false;
          const poller = (async () => {
            while (!done) {
              try {
                library.status = await api.status();
              } catch {
                /* transient */
              }
              await sleep(700);
            }
          })();
          try {
            await api.rescan();
          } catch (e) {
            library.error = msg(e);
            done = true;
            await poller;
            throw e;
          }
          done = true;
          await poller;
        }),
      },
    }),
  );
  scan.subscribe(() => {
    const s = scan.getSnapshot();
    library.loading = s.matches("booting") || s.matches("loadingTracks");
    library.scanning = s.matches("scanning") || s.matches("rescanning");
  });
  scan.start();
  scanActor = scan;

  // Bulk enrichment: its own small machine. The run loops over the un-enriched
  // library (parse each via the WASM decoder, write /api/meta back), reporting
  // progress + honouring cancel via `library.enriching` (flipped by the machine
  // state below, read by shouldContinue).
  const enrich = createActor(
    enrichMachine.provide({
      actors: {
        run: fromPromise(async () => {
          // The machine is already in `enriching` when this invoked run starts,
          // but the subscribe below only mirrors that into `library.enriching` a
          // microtask later — after enrichTracks' first `shouldContinue()` check,
          // which would then read `false` and cancel the loop on iteration one
          // (the button looked dead). Set it synchronously so the run survives.
          library.enriching = true;
          const deps = {
            fetchBytes: (hash: string) => fetch(fileUrl(hash)).then((r) => r.arrayBuffer()),
            parse: parseModule,
            save: api.putMeta,
          };
          if (STANDALONE) {
            const todo = library.tracks.filter((t) => !t.type_long);
            library.enrichTotal = todo.length;
            library.enrichDone = 0;
            await enrichTracks(todo, deps, {
              shouldContinue: () => library.enriching,
              onProgress: (done) => (library.enrichDone = done),
            });
            return;
          }
          // Server-side index: pull the outstanding work a page at a time rather
          // than filtering a list the browser doesn't hold. Each page is
          // re-queried, so tracks enriched by this run drop out of the next one.
          const first = await api.unenriched();
          library.enrichTotal = first.count;
          library.enrichDone = 0;
          let page = first.tracks;
          let done = 0;
          while (page.length && library.enriching) {
            await enrichTracks(page, deps, {
              shouldContinue: () => library.enriching,
              onProgress: (n) => (library.enrichDone = done + n),
            });
            done += page.length;
            page = library.enriching ? (await api.unenriched()).tracks : [];
          }
          await refreshUnenriched();
          await reshape();
        }),
      },
    }),
  );
  enrich.subscribe(() => {
    library.enriching = enrich.getSnapshot().matches("enriching");
  });
  enrich.start();
  enrichActor = enrich;
}

/** Toggle a track's favourite flag — optimistic, reverted if the write fails.
 *
 *  Goes through the hydration cache rather than mutating the Track in place: the
 *  cache hands out the same object to every reader, and replacing the entry is
 *  what notifies the rows displaying it. (In STANDALONE the object *is* the
 *  `$state` row, so it's mutated too and both paths stay in step.) */
export async function toggleFavorite(t: Track) {
  const next = !t.favorite;
  if (STANDALONE) t.favorite = next;
  tracks.patch(t.id, { favorite: next });
  try {
    await api.setFavorite(t.hash, next, t.subsong);
  } catch {
    if (STANDALONE) t.favorite = !next;
    tracks.patch(t.id, { favorite: !next });
  }
  // On the favourites tab, un-favouriting must drop the row from the list — the
  // shaping that decides membership runs server-side.
  if (!STANDALONE && queryFromView().fav) void reshape();
}

/** Drop a track from the index after it's been deleted on disk, so the library
 *  list reflects it without a full rescan. */
export function removeTrackLocal(path: string) {
  library.tracks = library.tracks.filter((t) => t.path !== path);
  // With a backend the row stream is server-shaped, so re-fetch it rather than
  // filtering a list the browser doesn't hold.
  if (!STANDALONE) void reshape();
}

/** Trigger a rescan (from the Settings panel). No-op unless idle/errored — and
 *  a no-op entirely in the backend-less build (there's nothing to rescan). */
export function rescanLibrary() {
  scanActor?.send({ type: "RESCAN" });
}

/** Reindex a single root, and reload the library from the result.
 *
 *  Deliberately not routed through the scan machine: that machine models a
 *  filesystem walk (progress counters, "don't touch /api/tracks while it holds
 *  the DB"), whereas an HVSC reindex is one catalogue read that returns in
 *  seconds. Running it inline keeps the library visible throughout instead of
 *  blanking the list behind a progress bar for something that doesn't need one.
 *
 *  Rethrows so the caller can report the failure — a misconfigured root answers
 *  400, and silently doing nothing would look like a dead button. */
export async function reindexRoot(id: string): Promise<RescanResult> {
  const result = await api.rescanRoot(id);
  // The reindex reassigns file ids, so cached rows are stale by id, not just by
  // content — drop the cache before reshaping rather than patching it.
  tracks.clear();
  library.status = await api.status();
  await reshape();
  return result;
}

/** Start bulk metadata enrichment (no-op if nothing needs it). */
export function enrichLibrary() {
  if (unEnriched() > 0) enrichActor?.send({ type: "START" });
}

/** Cancel an in-flight enrichment. */
export function cancelEnrich() {
  enrichActor?.send({ type: "CANCEL" });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    scanActor?.stop();
    enrichActor?.stop();
  });
}
