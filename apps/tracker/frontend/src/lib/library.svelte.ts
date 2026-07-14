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
import { api, fileUrl, type StatusResponse, type Track } from "$lib/api";
import { enrichTracks } from "$lib/enrich";
import { enrichMachine } from "$lib/enrich-machine";
import { scanMachine } from "$lib/scan-machine";
import { STANDALONE } from "$lib/standalone";
import * as standalone from "$lib/standalone/store.svelte";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const library = $state({
  tracks: [] as Track[],
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
});

/** How many modules still lack parsed metadata (drives the "enrich N" button).
 *  A function (not exported $derived, which Svelte disallows); reads reactive
 *  state, so it stays reactive when called in a template / $derived. */
export function unEnriched(): number {
  return library.tracks.filter((t) => !t.type_long).length;
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
            library.tracks = await api.tracks();
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
          const todo = library.tracks.filter((t) => !t.type_long);
          library.enrichTotal = todo.length;
          library.enrichDone = 0;
          await enrichTracks(
            todo,
            {
              fetchBytes: (hash) => fetch(fileUrl(hash)).then((r) => r.arrayBuffer()),
              parse: parseModule,
              save: api.putMeta,
            },
            {
              shouldContinue: () => library.enriching,
              onProgress: (done) => (library.enrichDone = done),
            },
          );
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

/** Toggle a track's favourite flag — optimistic (the $state proxy re-renders the
 *  row + re-derives the facets), reverted if the write fails. */
export async function toggleFavorite(t: Track) {
  const next = !t.favorite;
  t.favorite = next;
  try {
    await api.setFavorite(t.hash, next);
  } catch {
    t.favorite = !next;
  }
}

/** Drop a track from the in-memory index after it's been deleted on disk, so the
 *  library list reflects it without a full rescan (the $state proxy re-renders +
 *  re-derives the facets). Keyed by path — the index's unique key. */
export function removeTrackLocal(path: string) {
  library.tracks = library.tracks.filter((t) => t.path !== path);
}

/** Trigger a rescan (from the Settings panel). No-op unless idle/errored — and
 *  a no-op entirely in the backend-less build (there's nothing to rescan). */
export function rescanLibrary() {
  scanActor?.send({ type: "RESCAN" });
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
