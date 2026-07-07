// The library data lifecycle as a state machine (XState v5). Boot fetches
// /status; if the backend is indexing (it holds the single DB connection) we
// poll /status — never /api/tracks — until it's idle, then load the library.
// A user rescan re-enters the same load path. Modelling it makes the phases
// explicit (booting / scanning / loadingTracks / ready / rescanning / error)
// instead of the old loading+scanning+rescanning boolean tangle.
//
// Pure: the four async steps are injected actors, so it unit-tests in node with
// mocks (see __tests__/scan-machine.test.ts). The library store provides the real
// actors (which hit the api + fill the reactive store) and mirrors the state.
import { fromPromise, setup } from "xstate";

export type ScanEvent = { type: "RESCAN" };

export const scanMachine = setup({
  types: {} as { events: ScanEvent },
  actors: {
    // Fetch /status once → is the backend scanning?
    checkStatus: fromPromise<boolean>(async () => false),
    // Wait a beat, re-fetch /status → still scanning?
    pollStatus: fromPromise<boolean>(async () => false),
    // Load the full library (heavy; only when the DB is idle).
    loadTracks: fromPromise<void>(async () => {}),
    // Trigger a rescan and resolve once it has finished (progress polled inside).
    rescan: fromPromise<void>(async () => {}),
  },
}).createMachine({
  id: "scan",
  initial: "booting",
  states: {
    booting: {
      invoke: {
        src: "checkStatus",
        onDone: [
          { target: "scanning", guard: ({ event }) => event.output },
          { target: "loadingTracks" },
        ],
        onError: "error",
      },
    },

    // Backend is indexing (holds the DB) — poll /status, don't touch /api/tracks.
    scanning: {
      invoke: {
        src: "pollStatus",
        onDone: [
          { target: "scanning", guard: ({ event }) => event.output, reenter: true },
          { target: "loadingTracks" },
        ],
        onError: { target: "scanning", reenter: true }, // transient — keep polling
      },
    },

    loadingTracks: {
      invoke: { src: "loadTracks", onDone: "ready", onError: "error" },
    },

    ready: {
      on: { RESCAN: "rescanning" },
    },

    rescanning: {
      invoke: { src: "rescan", onDone: "loadingTracks", onError: "error" },
    },

    error: {
      on: { RESCAN: "rescanning" },
    },
  },
});
