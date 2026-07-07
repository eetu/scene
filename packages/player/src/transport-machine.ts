// Transport lifecycle as an explicit state machine (XState v5).
//
// Why a machine: the play state used to be a handful of booleans
// (playing/paused/song) set imperatively down several paths. On the cold-restore
// path (a ?t= reload, no user gesture) they drifted into an *impossible*
// combination — "playing" (pause icon) while the module never decoded and the
// clock sat frozen at 0:00. Modelling load→decode→transport as states makes that
// combination unrepresentable: you reach `playing` only through `loading`
// (a gesture), and `decoding` can't hang forever (it has a timeout → `error`).
//
// The machine is PURE: its only side effects are two injected actors, so it unit-
// tests in node with mocks. The store provides the real actors (which talk to the
// chiptune3 engine) and mirrors the machine's state onto the reactive `playback`
// store that components read — so the transport can no longer lie about itself.
//
//   empty ──CUE──▶ cued(decoding→ready)      restore: decode the pattern, PLAY icon
//         ──LOAD─▶ loading ──▶ playing        click: gesture → decode + audio
//   cued  ──PLAY─▶ loading                    first gesture starts audio
//   playing ⇄ paused ; playing──ENDED──▶ ended ; *──STOP──▶ stopped ; *──ERROR──▶ error
import { fromPromise, setup } from "xstate";

/** A decode that never delivers metadata drops to `error` instead of hanging on
 *  "decoding pattern…" forever. */
export const DECODE_TIMEOUT_MS = 15_000;

export type TransportEvent =
  | { type: "CUE" } // restore a selection: decode the pattern, do NOT autoplay
  | { type: "LOAD" } // click a track: gesture present → decode + play
  | { type: "PLAY" } // gesture: start / resume audio
  | { type: "PAUSE" }
  | { type: "TOGGLE" }
  | { type: "PROGRESS" } // a rendered frame arrived → audio is genuinely running
  | { type: "ENDED" }
  | { type: "STOP" }
  | { type: "ERROR" };

export const transportMachine = setup({
  types: {} as { events: TransportEvent },
  actors: {
    // Resolves when the worker delivers the song (pattern data); rejects on a
    // decode/load failure. Injectable so tests run without the engine.
    decode: fromPromise<void>(async () => {}),
    // Resumes the audio context + starts playback; resolves once audio runs.
    startPlayback: fromPromise<void>(async () => {}),
  },
}).createMachine({
  id: "transport",
  initial: "empty",
  states: {
    empty: {
      on: { CUE: "cued", LOAD: "loading" },
    },

    // A track is selected and its pattern is decoding, but audio has NOT started
    // (restored from the URL with no gesture — the browser blocks autoplay). The
    // transport shows PLAY here, never a pause icon.
    cued: {
      initial: "decoding",
      on: { PLAY: "loading", LOAD: "loading", CUE: ".decoding", STOP: "stopped", ERROR: "error" },
      states: {
        decoding: {
          invoke: { src: "decode", onDone: "ready", onError: "#transport.error" },
          // Can't hang on "decoding pattern…": time out into an honest error.
          after: { [DECODE_TIMEOUT_MS]: "#transport.error" },
        },
        ready: {}, // pattern decoded; awaiting a gesture to start audio
      },
    },

    // A gesture started playback: resume the context + start audio.
    loading: {
      invoke: { src: "startPlayback", onDone: "playing", onError: "error" },
      on: {
        PROGRESS: "playing",
        CUE: "cued",
        LOAD: "loading",
        STOP: "stopped",
        ERROR: "error",
      },
    },

    playing: {
      on: {
        PAUSE: "paused",
        TOGGLE: "paused",
        ENDED: "ended",
        STOP: "stopped",
        CUE: "cued",
        LOAD: "loading",
        ERROR: "error",
      },
    },

    paused: {
      on: { PLAY: "playing", TOGGLE: "playing", STOP: "stopped", CUE: "cued", LOAD: "loading" },
    },

    // Halted at 0 with the module still loaded (transport shows ▶ = restart).
    stopped: {
      on: { PLAY: "loading", TOGGLE: "loading", LOAD: "loading", CUE: "cued" },
    },

    // Reached the natural end; like stopped, but distinct so auto-advance logic
    // and the UI can tell "finished" from "user stopped".
    ended: {
      on: { PLAY: "loading", TOGGLE: "loading", LOAD: "loading", CUE: "cued" },
    },

    error: {
      on: { LOAD: "loading", CUE: "cued", PLAY: "loading" },
    },
  },
});
