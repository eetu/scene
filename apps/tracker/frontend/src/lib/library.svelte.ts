// Shared library data store (a rune store, like @scene/player's playback): holds
// the tracks + /status + error, and drives the scan lifecycle via scanMachine.
// The machine owns the phases (booting / scanning / loadingTracks / ready /
// rescanning / error); the injected actors here hit the api and fill this store,
// and the subscription mirrors the phase onto `loading` / `scanning` for the UI.
// Import `library` anywhere (no prop-drilling); the pure grouping/filter helpers
// live separately in $lib/library.
import { createActor, fromPromise } from "xstate";

import { api, type StatusResponse, type Track } from "$lib/api";
import { scanMachine } from "$lib/scan-machine";

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
});

const actor = createActor(
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

actor.subscribe(() => {
  const s = actor.getSnapshot();
  library.loading = s.matches("booting") || s.matches("loadingTracks");
  library.scanning = s.matches("scanning") || s.matches("rescanning");
});
actor.start();

/** Trigger a rescan (from the Settings panel). No-op unless idle/errored. */
export function rescanLibrary() {
  actor.send({ type: "RESCAN" });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => actor.stop());
}
