// Reactive playback store wrapping the (vendored) chiptune3 libopenmpt engine.
// One AudioContext/worklet for the whole app, created lazily on the first play
// (inside a user gesture, so the browser allows audio). When a module's
// metadata arrives we both reflect it in the now-playing track and write it
// back to the backend cache (/api/meta) — so titles/durations fill in as you
// listen, keyed by content hash.

import { createActor, fromPromise } from "xstate";

import {
  attachBackground,
  pauseMediaElement,
  resetBackgroundRoute,
  routeAudioToElement,
  setupMediaElementRoute,
  wakeAudio,
} from "./background";
import { BeatTracker } from "./beat";
import { attachEditor, clearEdits, seqStop, seqToggle } from "./editor.svelte";
import { createEngine, type Engine, type EngineKind, type TraceRowsMsg } from "./engine";
import { host, type QueueRef, type Track } from "./host";
import { attachJam, resetJam } from "./jam";
import { syncNowPlaying, syncPosition, wirePlatformIntegration } from "./platform";
import { plannedNext, plannedPrev, shuffledOrder } from "./queue";
import { sampleBands, SCOPE_SIZE, setScopeSource } from "./scope";
import { playback, TRACE_ROWS } from "./state.svelte";
import { transportMachine } from "./transport-machine";
import { buildWav } from "./wav";

export { playback } from "./state.svelte";
export { jamNote, jamStop, jamStopAll, setJamLevel } from "./jam";

// Re-exported from sibling modules so the package's public API is unchanged.
export { CELL, cellFieldText, FIELD, isRealNote, noteName, noteToJam, NUM_FIELDS } from "./notes";
export {
  readScope,
  readSpectrum,
  sampleBands,
  SCOPE_SIZE,
  SPECTRUM_SIZE,
  spectrumSampleRate,
} from "./scope";
export {
  clearCellAtCursor,
  handleEditKey,
  moveCursor,
  moveField,
  patternCells,
  readSeqScope,
  seekToCursor,
  SEQ_SCOPE_SIZE,
  seqPlay,
  seqStop,
  seqToggle,
  setCursor,
  setEditing,
  setEditInst,
  setEditOctave,
  setEditStep,
  setFollowPlay,
} from "./editor.svelte";

export type ProgressMsg = {
  pos?: number;
  order?: number;
  pattern?: number;
  row?: number;
  vu?: number[];
};

/** Per-pattern data from the (patched) worklet: each row is one formatted
 *  cell-string per channel, e.g. "C-4 01 v64 A04". */
export type Pattern = {
  name: string;
  rows: string[][];
  /** Structured per-cell fields from the custom build (parallel to `rows`):
   *  cells[row][channel] = [note, instrument, volcmd, volume, effect, param].
   *  Absent on the stock build — the editor gates on it (canReadCells). */
  cells?: number[][][];
};
export type Song = {
  channels?: string[];
  instruments?: string[];
  samples?: string[];
  patterns?: Pattern[];
  /** The order list — the sequence of patterns played, one entry per position. */
  orders?: { name: string; pat: number }[];
};
// libopenmpt metadata keys are flattened onto the object, plus `song` + totals.
export type Meta = {
  title?: string;
  type_long?: string;
  tracker?: string;
  dur?: number;
  totalOrders?: number;
  totalPatterns?: number;
  song?: Song;
};

/** One sample's shape, from the custom build's smp_info (frame counts + props). */
export type SampleInfo = {
  length: number;
  loopStart: number;
  loopEnd: number;
  sustainStart: number;
  sustainEnd: number;
  rate: number;
  channels: number;
  bits: number;
  flags: number; // bit0 loop | bit1 pingpong | bit2 sustain | bit3 sustain-pingpong
  volume: number; // 0..256
  panning: number; // 0..256, or -1 if the sample sets no default pan
  finetune: number;
  relativeNote: number;
  globalVol: number; // 0..64
};
/** A sample's metadata + its raw waveform (mono f32 [-1,1]). */
export type SampleData = { info: SampleInfo; pcm: Float32Array };
/** A sample's metadata + its raw bytes (native bit-depth, interleaved). */
export type SampleRaw = { info: SampleInfo; raw: Uint8Array };

/** Lightweight metadata from a parse-only (no-audio) load, for bulk enrichment. */
export type ParsedMeta = {
  title?: string;
  type_long?: string;
  tracker?: string;
  dur?: number;
  channels?: number;
  instruments?: number;
  samples?: number;
  orders?: number;
  patterns?: number;
};

// The live engine, typed through the `Engine` facade: every method the store
// calls is part of that contract, so a second backend cannot type-check while
// silently omitting one.
//
// Physically null before the first play — the AudioContext is created inside a
// user gesture — but declared non-null: every path that touches it runs after
// `ensurePlayer`, and threading `| null` through would put a non-null assertion
// on ~40 call sites for one genuinely-unreachable state. The cast is named so
// the compromise is visible in both places that use it.
const NO_ENGINE = null as unknown as Engine;
let player: Engine = NO_ENGINE;
let ready: Promise<void> | null = null;
let parseId = 0;

// iOS: recreate the AudioContext on a stalled-but-"running" render.
// After an iOS interruption (backgrounding, a call, AirPods handing the audio
// route to another app) the AudioContext can report state="running" while its
// audio unit is actually dead: the pattern freezes (onProgress stops arriving)
// and resume() is a no-op. The only cure is a brand-new context. We track when a
// frame last arrived; if the user taps play/pause while "playing" but no frame
// has landed for >2s, the render is stalled — so we rebuild the engine on a
// fresh AudioContext inside the tap gesture, reloading the current track at its
// position (resumeSeek). Verified on-device (iOS PWA + AirPods).
let lastProgressAt = 0;
let resumeSeek: number | null = null;
let recreating = false;
// The app was backgrounded while PAUSED. iOS suspends the AudioContext when
// hidden; while playing, tapRecreatesStalled() catches the resulting dead-but-
// "running" context on the next tap (via the frozen render), but while paused
// nothing renders so there's no stall to detect. Instead we note the hidden-
// while-paused transition and rebuild the engine on the unpause tap — a fresh
// context inside that gesture is the only reliable revival on iOS. Cleared the
// moment a frame lands again (onProgress), i.e. once the context is proven alive.
let hiddenWhilePaused = false;
// One-time global timers (must survive an engine recreate, so they're registered
// once, not per engine). Watchdog baselines are module-level so a recreate can
// reset them for the fresh context's clock.
let globalsWired = false;
let wdLastWall = 0;
let wdLastCtx = 0;
let wdLastPos = 0;
// Play-count gating: only count a tune once it's actually been listened to past
// a threshold (so fast skips don't inflate counts). Reset per track start.
let playCounted = false;
let playCountHash: string | null = null;
// Plain (non-reactive) registry of in-flight parse resolvers — not UI state.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const pendingParse = new Map<number, (m: ParsedMeta | null) => void>();

// In tracker music the pattern rows are the beat grid; a musical beat is the
// conventional every-4th-row. We watch the row advance in onProgress (which the
// worklet fires synced to audio) and pulse on each beat boundary — so this is
// exact to the module and tracks tempo/speed changes for free (rows simply
// arrive faster or slower). Visualizers read `playback.beat` for the on-beat
// tick and `beatPhase()` for a smooth 0→1 ramp between beats.
// Beat timing lives in a pure, clock-injectable tracker (see ./beat); the store
// just feeds it rows and bumps `playback.beat` on each onset.
const beat = new BeatTracker();

function resetBeat() {
  beat.reset();
}

function noteRow(order: number, pattern: number, row: number) {
  if (beat.row(order, pattern, row, performance.now())) playback.beat++;
}

/** Beat for a format with no pattern grid (SID): onset-detect it from the bass
 *  band instead of counting rows. Called on the same audio-synced cadence as
 *  `noteRow`, so ~7 visualisers keep their pulse either way. */
function noteEnergy() {
  if (beat.energy(sampleBands().bass, performance.now())) playback.beat++;
}

/** A 0→1 ramp since the last beat (clamped at 1, and 0 until the first beat).
 *  Lets a viz pulse on-beat without re-deriving timing from the raw row. */
export function beatPhase(now = performance.now()): number {
  return beat.phase(now);
}

/** Estimated musical tempo in BPM. ~0 until the first beat; clamped so a
 *  stall/seek can't spike it. Lets visualizers scale motion to tempo. */
export function beatBpm(): number {
  return beat.bpm();
}

// The queue is an ordered list of *refs*, not tracks. A host whose library is
// entirely in memory (party) queues the tracks and they land in `queueCache`
// straight away; a host whose library lives server-side (tracker, once the index
// is too large to ship) queues ids and resolves them a window at a time.
//
// Indices into `queueRefs` are what shuffle permutes, so the seeded-permutation
// guarantees are untouched by where the track data comes from.
let queueRefs: QueueRef[] = [];
const queueCache = new Map<QueueRef, Track>();

/** Identity for queueing: `path ?? hash` — tracker has duplicate-content modules
 *  at distinct paths; party tracks are hash-only. */
function refOf(t: Track): QueueRef {
  return t.path ?? t.hash;
}

/** The track at a queue index if it's already known — cache first, then the
 *  host's own cache. Null when it still needs fetching. */
function trackAt(i: number): Track | null {
  const ref = queueRefs[i];
  if (ref === undefined) return null;
  return queueCache.get(ref) ?? host().peekTrack?.(ref) ?? null;
}

/** The track at a queue index, fetching it if needed. */
async function resolveAt(i: number): Promise<Track | null> {
  const known = trackAt(i);
  if (known) return known;
  const ref = queueRefs[i];
  if (ref === undefined) return null;
  const t = (await host().resolveTrack?.(ref)) ?? null;
  if (t) queueCache.set(ref, t);
  return t;
}

/** Replace the queue. `refs` is the play order; `known` seeds the cache for
 *  hosts that already hold the tracks. The cache is cleared so a stale entry
 *  from a previous queue can't shadow a re-fetch. */
function setQueue(refs: QueueRef[], known?: Track[]) {
  queueRefs = refs;
  queueCache.clear();
  if (known) for (const t of known) queueCache.set(refOf(t), t);
  playback.queueLength = refs.length;
  // Length changed → the permutation must be rebuilt before the next roll.
  shuffleOrder = [];
}

// Deterministic shuffle: a seeded permutation of the queue (see queue.ts). The
// seed is persisted so random mode + its exact order survive a reload; a fresh
// seed is rolled each time shuffle is switched on. Rebuilt lazily in rollNext when
// the queue length changes (or forced via shuffleOrder = []).
let shuffleSeed = loadShuffleSeed();
let shuffleOrder: number[] = [];
function newShuffleSeed(): number {
  const s = (Math.floor(Math.random() * 0xffffffff) || 1) >>> 0;
  if (typeof localStorage !== "undefined") localStorage.setItem("player:shuffleSeed", String(s));
  return s;
}
function loadShuffleSeed(): number {
  if (typeof localStorage !== "undefined") {
    const s = Number(localStorage.getItem("player:shuffleSeed"));
    if (Number.isInteger(s) && s > 0) return s >>> 0;
  }
  return newShuffleSeed();
}
function buildShuffleOrder() {
  shuffleOrder = queueRefs.length ? shuffledOrder(queueRefs.length, shuffleSeed) : [];
}
// Pre-rolled next queue index: chosen when a track *starts*, so the next song is
// deterministic (and thus prefetchable) rather than picked at the moment of
// advancing. Sequential = +1; shuffle = the next entry in the seeded order.
let plannedNextIdx: number | null = null;
// Debounced next-track byte prefetch — warms the browser HTTP cache so a switch
// skips the network. Debounced so mashing next doesn't spam fetches (and never
// prefetches the tracks skipped straight past).
let prefetchTimer: ReturnType<typeof setTimeout> | null = null;
let prefetchedUrl: string | null = null;
// Consecutive load/playback failures without a successful frame in between —
// bounds the auto-skip past broken modules so a fully-unplayable queue can't
// spin forever. Reset on the first progress tick of a track that actually plays.
let consecutiveErrors = 0;

// The transport machine (transport-machine.ts) is the single source of truth for
// play / pause / cued / decoding state; this subscription mirrors it onto
// `playback.playing`/`paused`, so the transport can never show a state it isn't in.
// The imperative engine work (load / pause / stop, background routing, iOS) stays
// in the functions below — the machine governs *state*, not the audio graph.
let pendingTrack: Track | null = null;

const transport = createActor(
  transportMachine.provide({
    actors: {
      // Cold-restore decode: fetch the module + decode its song (pattern) on a
      // throwaway module in the worker — no audio graph, so it works before a
      // user gesture (when the browser keeps the audio worklet suspended).
      decode: fromPromise(async () => {
        const t = pendingTrack;
        if (!t) return;
        const kind = kindFor(t);
        ensurePlayer(kind); // create the engine (its worker starts loading its WASM)
        // Nothing to pre-decode for a SID: its music is 6502 code driving chip
        // registers, so there is no pattern grid to have ready before the play
        // gesture. Settle straight away.
        if (kind === "sid") return;
        await player.whenWorkerReady(); // WASM ready — independent of the audio worklet
        const buf = await fetch(host().fileUrl(t.hash)).then((r) => r.arrayBuffer());
        if (pendingTrack !== t) return; // superseded by a newer cue/load
        const meta = await player.decodeSong(buf);
        if (!meta) throw new Error("decode failed");
        if (playback.current?.hash === t.hash) applyMeta(meta);
      }),
      // Audio start is driven imperatively by playTrack (inside the gesture);
      // this actor just lets `loading` settle into `playing`.
      startPlayback: fromPromise(async () => {}),
    },
  }),
);

transport.subscribe(() => {
  const s = transport.getSnapshot();
  const paused = s.matches("paused");
  // loading / playing / paused = an active session (the pause glyph shows only
  // when playing && !paused); cued / stopped / ended / error / empty = ▶.
  playback.playing = paused || s.matches("playing") || s.matches("loading");
  playback.paused = paused;
  playback.ended = s.matches("ended");
});
transport.start();

// One-time global timer — registered once and left alone across an engine
// recreate (recreateEngine nulls `player` and re-runs ensurePlayer, which
// re-binds the per-engine handlers but must NOT re-add this).
function wireGlobalsOnce(): void {
  if (globalsWired) return;
  globalsWired = true;
  // iOS suspends the AudioContext when the app is backgrounded. If that happens
  // while PAUSED, the context is left dead behind a state="running" lie that
  // resume() can't fix and no stall detector can see (paused → no frames) — so
  // flag it here; the unpause tap rebuilds the engine (see togglePause).
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible" && playback.paused) hiddenWhilePaused = true;
    });
  }
  // Wake-from-freeze resync (laptop sleep / long suspend).
  // Song timing is purely output-paced; nothing tracks wall time. If the audio
  // clock (currentTime) falls far behind wall-clock while playing, the pipeline
  // froze — reseek so it restarts clean instead of racing. (Distinct from the
  // iOS stalled-unit case, which needs a full recreate — see recreateEngine.)
  // Baselines are module-level so recreateEngine can reset them to the fresh
  // context's clock.
  wdLastWall = performance.now();
  wdLastCtx = player.context.currentTime;
  setInterval(() => {
    if (recreating || !player) return;
    const wall = performance.now();
    const ctx = player.context.currentTime;
    const stalled = wall - wdLastWall - (ctx - wdLastCtx) * 1000;
    wdLastWall = wall;
    wdLastCtx = ctx;
    if (stalled > 3000 && playback.current && (playback.playing || playback.paused)) {
      try {
        player.setPos(wdLastPos);
      } catch {
        /* engine gone */
      }
    }
    // Audio running SLOW rather than cutting out. The watchdog above only acts on a
    // hard stall, but the same arithmetic measures small drift, and that is the one
    // symptom the dropout counter cannot see: the pitch and tempo sag together while
    // PCM keeps flowing, so nothing underruns and nothing is logged. This says whether
    // the audio clock genuinely fell behind the wall clock, and by how much.
    //
    // The threshold is well above ordinary jitter (the interval itself is only
    // approximately 1s) and well below the 3s stall case.
    if (stalled > 150 && stalled <= 3000 && playback.playing && !playback.paused) {
      // Hidden tabs are included — backgrounded is where the fault occurs, and timer
      // throttling can't false-fire: a late interval inflates the wall and context deltas
      // together, so the difference stays near zero.
      console.warn(
        `[audio] clock fell ${Math.round(stalled)}ms behind in the last second ` +
          `(context ${player.context.sampleRate}Hz, state ${player.context.state}` +
          `${document.hidden ? ", hidden" : ""})`,
      );
    }
    wdLastPos = playback.position;
  }, 1000);
}

// Recreate the whole engine on a fresh AudioContext (the only cure for iOS
// leaving a context state="running" but its audio unit dead — resume()/setPos
// are no-ops on it). Runs inside a play gesture so iOS allows the new context;
// reloads the current track at its position. See lastProgressAt / the tap hooks.
/** Drop the current engine and its audio graph. Shared by the iOS
 *  stalled-context recovery and by switching decoders mid-queue. */
function teardownEngine(): void {
  const old = player;
  player = NO_ENGINE;
  ready = null;
  engineKind = null;
  resetBackgroundRoute(); // drop the stale <audio>/stream so the new graph rebuilds it
  try {
    old?.stop?.();
    void old?.context?.close?.(); // fire-and-forget: awaiting would leave the gesture
  } catch {
    /* already gone */
  }
}

async function recreateEngine(): Promise<void> {
  const cur = playback.current;
  const pos = playback.position;
  recreating = true;
  teardownEngine();
  resumeSeek = pos > 1 ? Math.floor(pos) : null;
  lastProgressAt = performance.now();
  try {
    if (cur) await playTrack(cur); // ensurePlayer → new AudioContext (synchronously, in-gesture)
  } finally {
    // Re-baseline the wake-from-freeze watchdog for the new context's clock.
    if (player) {
      wdLastWall = performance.now();
      wdLastCtx = player.context.currentTime;
      wdLastPos = 0;
    }
    recreating = false;
  }
}

// Would tapping play/pause hit a stalled-but-"running" context? (Shows playing,
// pattern frozen, no frames for >2s.) If so, recreate instead of the normal
// toggle — the tap is the gesture the new context needs.
function tapRecreatesStalled(): boolean {
  if (
    player &&
    playback.playing &&
    !playback.paused &&
    lastProgressAt > 0 &&
    performance.now() - lastProgressAt > 2000
  ) {
    void recreateEngine();
    return true;
  }
  return false;
}

/** The decoder a track needs. SID is a different engine entirely — libsidplayfp
 *  emulating a 6502 plus the chip, where libopenmpt renders a pattern grid. */
function kindFor(track: Track): EngineKind {
  const ext = (track.ext ?? "").toLowerCase();
  return ext === "sid" || ext === "psid" || ext === "rsid" ? "sid" : "module";
}

/** Which engine is currently built. Null until the first play. */
let engineKind: EngineKind | null = null;

function ensurePlayer(kind: EngineKind = "module"): Promise<void> {
  if (player && engineKind === kind) return ready as Promise<void>;
  // Switching formats means a different decoder behind the same graph, so tear
  // the old one down first. Cheap and rare: it happens when you cross from
  // modules to SIDs in the queue, not on every track.
  if (player) teardownEngine();
  engineKind = kind;
  // Synchronous `new AudioContext()` keeps us inside the click gesture.
  player = createEngine({ repeatCount: 0, romBase: host().romBase?.() }, kind);
  attachBackground(player); // wire background routing + wakeAudio to this engine
  wireGlobalsOnce(); // one-time timers (survive an engine recreate)
  attachJam(player, wakeAudio); // wire the Web Audio sampler to this engine
  attachEditor(player); // wire the pattern editor + sequencer to this engine
  // Tap the output for the scope. The gain node exists immediately (the
  // worklet connects to it once it's ready); the analyser just observes.
  const a: AnalyserNode = player.context.createAnalyser();
  a.fftSize = SCOPE_SIZE;
  // Widen the dB window so loud module output doesn't saturate every frequency
  // bin to 255 (which makes the equalizer top-heavy); leave headroom up top.
  a.minDecibels = -90;
  a.maxDecibels = -10;
  a.smoothingTimeConstant = 0.82;
  player.gain.connect(a);
  setScopeSource(a);
  let initSettled = false;
  ready = new Promise<void>((resolve, reject) => {
    player.onInitialized(() => {
      initSettled = true;
      resolve();
    });
    // A fatal bring-up failure (worklet/worker module 404, CSP block, unsupported
    // browser) must REJECT rather than leave the graph half-built — otherwise
    // `onInitialized` never fires and every awaiter (playTrack's `await p`,
    // parseModule) hangs forever behind a frozen transport. A merely-suspended
    // worklet (no user gesture yet) does not error, so this can't false-fire; the
    // per-track playback errors (Load/decode) are handled by the main onError
    // handler below and must not reject init.
    player.onError((e: { type?: string }) => {
      if (!initSettled && (e?.type === "Worklet" || e?.type === "Worker")) {
        initSettled = true;
        reject(new Error(e?.type ?? "engine init failed"));
      }
    });
  });
  // Once the graph exists: reflect the engine's capabilities (jam/samples), then
  // tap it for the background-capable media-element route. Swallow a rejected init
  // here — playTrack/parseModule surface it; this chain just shouldn't go unhandled.
  void ready
    .then(() => {
      playback.canReadSamples = player.capabilities?.canReadSamples ?? false;
      // What the browser actually gave us for the 'playback' latency hint (see
      // chiptune3.js). baseLatency is the graph's own buffering; outputLatency includes
      // the OS and the device, so on Bluetooth it can be far larger. Both are the cost
      // paid for jitter tolerance, and the jam keyboard pays it too.
      console.info(
        `[audio] output latency ${Math.round((player.context.baseLatency ?? 0) * 1000)}ms base, ` +
          `${Math.round(((player.context as AudioContext).outputLatency ?? 0) * 1000)}ms total ` +
          `@ ${player.context.sampleRate}Hz`,
      );
      playback.canMuteChannels = player.capabilities?.canMuteChannels ?? false;
      playback.canReadCells = player.capabilities?.canReadCells ?? false;
      // Modules default true; the SID engine reports false and the player swaps
      // its pattern/samples panes for the voice monitor.
      playback.hasPatterns = player.capabilities?.hasPatterns ?? true;
      if (playback.mono) player.setMono(true); // restore persisted mono downmix
      // …and the persisted level. The gain node defaults to 1, so without this a saved
      // volume is silently ignored until something touches the control.
      if (playback.volume !== 1 || playback.muted) {
        player.setVol(playback.muted ? 0 : playback.volume);
      }
      setupMediaElementRoute();
    })
    .catch(() => {
      /* engine init failed; surfaced by awaiters */
    });
  player.onProgress((d: ProgressMsg) => {
    consecutiveErrors = 0; // a frame arrived → this track plays; clear the skip guard
    lastProgressAt = performance.now(); // a frame landed → the render is alive (stall detector)
    hiddenWhilePaused = false; // …so the context is proven alive — clear the suspect flag
    // First frame confirms audio is actually running (loading → playing).
    if (transport.getSnapshot().matches("loading")) transport.send({ type: "PROGRESS" });
    playback.position = d.pos ?? 0;
    playback.order = d.order ?? 0;
    playback.pattern = d.pattern ?? 0;
    playback.row = d.row ?? 0;
    playback.vu = d.vu ?? [];
    if (playback.hasPatterns) noteRow(playback.order, playback.pattern, playback.row);
    else noteEnergy();
    maybeCountPlay(d.pos ?? 0);
    // Keep the OS scrubber roughly in step (throttled to ~1s of playback).
    syncPosition();
  });
  player.onMetadata((meta: Meta) => {
    player.setRepeatCount(playback.repeat ? -1 : 0);
    applyMeta(meta); // song/duration/mutes + save + OS Now Playing
    // After a recreate-on-stall reload, seek back to where playback stalled.
    if (resumeSeek != null) {
      const s = resumeSeek;
      resumeSeek = null;
      try {
        player.setPos(s);
      } catch {
        /* seek failed — start from the top */
      }
    }
  });
  player.onEnded(() => {
    // (With repeat on, the module loops and onEnded never fires.) Auto-advance
    // to the next queue entry — random when shuffling — else fall to stopped.
    const canNext =
      playback.queueIndex >= 0 &&
      (playback.shuffle ? queueRefs.length > 1 : playback.queueIndex + 1 < queueRefs.length);
    if (canNext) playNext();
    else {
      transport.send({ type: "ENDED" });
      syncNowPlaying();
    }
  });
  // Dropped audio. libopenmpt renders in a Worker and feeds the audio worklet over a
  // port, so a stalled worker starves the audio thread and it emits silence — the tune
  // stumbles with nothing logged anywhere. Safari throttles background workers hard
  // enough to do this across an app switch. Surfaced rather than fixed: the numbers say
  // how long the stall actually lasts, which is what the jitter buffer has to be sized
  // to outlast (decoder.worker.js TARGET). The worklet reports at most once a second and
  // only when frames were lost, so a healthy stream is silent.
  player.onUnderrun((d) => {
    playback.underruns = d.events;
    playback.underrunMs = d.lostMs;
    console.warn(
      `[audio] dropped ${d.sinceMs}ms just now — ${d.events} dropouts, ${d.lostMs}ms total this session`,
    );
  });
  // The silence between starting a track and its first audio (fetch, parse, first render).
  // Reported apart from dropouts: a deeper jitter buffer cannot help, since the buffer is
  // deliberately emptied on a song change.
  // How much real time the decoder burns rendering. Under 5% it has ample headroom and
  // any dropout is the worker not being scheduled — cheaper rendering (a lower output
  // rate, a shorter interpolation filter) would buy nothing. Above ~25% it is genuinely
  // close to the edge and those knobs matter. Logged once, not continuously: it is a
  // property of the module and the settings, not something that drifts.
  let renderLoadLogged = false;
  // SID trace frames, straight from the decoder and therefore ahead of the
  // audio. Stale batches (from before a seek) are dropped by the wrapper.
  player.onTraceRows((d) => {
    pushTrace(d);
    if (d.dense) playback.sidTraceDense = true;
  });
  player.onRenderLoad((d) => {
    if (renderLoadLogged) return;
    renderLoadLogged = true;
    console.info(
      `[audio] decoder using ${d.percent}% of real time (${d.perChunkMs}ms per 21ms chunk)`,
    );
  });
  // Pitch/tempo wobble. Reported from the audio thread because the main thread cannot
  // see it: its timers are throttled to roughly once a minute while the page is hidden —
  // which is when this happens — and a one-second average flattens a wobble to nothing.
  // A positive figure means the device consumed audio slower than nominal, i.e. pitch
  // fell; that is the OS or the audio device, not the decoder, which has been measured
  // with ~28x headroom.
  player.onRateDrift((d) => {
    console.warn(
      `[audio] playback rate off by ${d.percent}% over ${d.windowMs}ms ` +
        `(${document.hidden ? "hidden" : "visible"}) — pitch/tempo wobble`,
    );
  });
  player.onLoadGap((d) => {
    playback.loadGapMs = d.ms;
    // Normal gaps run 100-400ms (fetch + parse + first render), so only log the outliers;
    // the value stays on the store either way.
    if (d.ms >= 600) console.info(`[audio] ${d.ms}ms of silence loading this track`);
  });
  player.onError((e: { type?: string }) => {
    playback.error = e?.type ?? "playback error";
    consecutiveErrors++;
    // Engine bring-up failures (worklet/worker module load) are fatal: the audio
    // graph never comes up, so skipping to the next track can't help — every track
    // hits the same dead engine. Surface the error immediately instead of cycling
    // the whole queue. Per-track errors (corrupt/unsupported module) still auto-skip.
    const fatal = e?.type === "Worklet" || e?.type === "Worker";
    // Auto-skip past an unplayable module (corrupt / unsupported) to the next
    // queued track — but stop once we've cycled ~the whole queue, so a fully
    // broken playlist surfaces the error instead of spinning. A short delay lets
    // the error register before the next track clears it.
    const canAdvance =
      !fatal &&
      playback.queueIndex >= 0 &&
      (playback.shuffle ? queueRefs.length > 1 : playback.queueIndex + 1 < queueRefs.length);
    if (canAdvance && consecutiveErrors <= queueRefs.length) {
      setTimeout(() => {
        if (playback.error) playNext();
      }, 900);
    } else {
      transport.send({ type: "ERROR" });
      syncNowPlaying();
    }
  });
  player.onParsed((d: { id: number; meta: ParsedMeta | null }) => {
    const resolve = pendingParse.get(d.id);
    if (resolve) {
      pendingParse.delete(d.id);
      resolve(d.meta ?? null);
    }
  });
  wirePlatformIntegration({
    toggle: transportToggle,
    togglePause,
    next: playNext,
    prev: playPrev,
  });
  return ready as Promise<void>;
}

// OS integration (Media Session, wake lock) lives in ./platform; the media-session
// buttons drive the transport controls wirePlatformIntegration receives in ensurePlayer.

/** Drop the recorded frames. The trace is a recording of one tune's playback,
 *  so it must not survive into the next — a grid still showing the last tune's
 *  notes while a new one plays is worse than an empty one. */
function resetTrace() {
  playback.sidTrace = [];
  playback.sidTraceAt = [];
  playback.sidTraceDense = false;
}

/** Append a batch of decoded raster frames.
 *
 *  Rows arrive flattened; they're split into zero-copy views over the same
 *  buffer rather than copied out, so the whole per-batch cost is a few
 *  `subarray` calls. Trimmed from the front once past [`TRACE_ROWS`] — the grid
 *  shows the recent past and the near future, not the whole tune. */
function pushTrace(d: TraceRowsMsg) {
  const n = Math.floor(d.rows.length / d.stride);
  for (let i = 0; i < n; i++) {
    playback.sidTrace.push(d.rows.subarray(i * d.stride, (i + 1) * d.stride));
    playback.sidTraceAt.push(d.times[i]);
  }
  const over = playback.sidTrace.length - TRACE_ROWS;
  if (over > 0) {
    playback.sidTrace.splice(0, over);
    playback.sidTraceAt.splice(0, over);
  }
}

/** Generation counter for the notes fetch: skipping through tracks fires
 *  several, and a slow one landing after a later track was selected would
 *  caption the wrong tune. */
let notesGen = 0;

/** Fetch the current track's curator notes (STIL) for the text visualisers.
 *
 *  Best-effort and deliberately off the critical path: playback never waits on
 *  it, and a failure just means no notes — the display already handles a track
 *  that has none, which is most of them. */
function loadNotes(track: Track) {
  const gen = ++notesGen;
  playback.notes = [];
  const fetchNotes = host().trackNotes;
  if (!fetchNotes) return;
  void fetchNotes(track)
    .then((n) => {
      if (gen === notesGen) playback.notes = n;
    })
    .catch(() => {
      /* decoration — a failed fetch shows no notes, not an error */
    });
}

/** Reflect a module's decoded metadata + song onto the store — used by both the
 *  play path (onMetadata) and the cold-restore decode (cueInOrder). */
function applyMeta(meta: Meta) {
  playback.duration = meta?.dur ?? 0;
  playback.song = meta?.song ?? null;
  playback.samples = meta?.song?.samples ?? [];
  playback.instruments = meta?.song?.instruments ?? [];
  // Fresh mute state sized to this module's channels (a load resets any
  // libopenmpt-side mutes).
  playback.channelMutes = new Array(meta?.song?.channels?.length ?? 0).fill(false);
  if (playback.current) void saveMeta(playback.current, meta);
  syncNowPlaying(); // title/duration known now → refresh OS Now Playing
}

/** Reset every per-track playback field for `track` (shared by play and cue). */
function resetForTrack(track: Track) {
  playback.error = null;
  playback.current = track;
  resetTrace(); // the previous tune's frames are not this one's
  loadNotes(track); // in parallel with engine init — nothing waits on it
  playback.position = 0;
  playback.duration = host().playLength?.(track) ?? track.duration ?? 0;
  playback.song = null;
  playback.row = 0;
  playback.order = 0;
  playback.pattern = 0;
  playback.channelMutes = []; // repopulated when this module's metadata arrives
  clearEdits(); // drop editor buffer + stop the editor sequencer
  resetBeat();
  pendingTrack = track;
}

export async function playTrack(track: Track) {
  // Stop the current module so the worklet drops it before we load the next.
  if (player) player.stop();
  resetJam(); // drop cached sample buffers + any live jam voices from the old module
  resetForTrack(track);
  transport.send({ type: "LOAD" }); // → loading; the subscription flips the transport to ⏸
  const p = ensurePlayer(kindFor(track));
  // Resume the context BEFORE awaiting init. A track cued on a cold reload created
  // the AudioContext suspended (no gesture), and the worklet won't finish
  // initialising — so `await p` would hang — until the context runs. We're inside
  // the play gesture here, so the resume is allowed. (Also revives an
  // iOS-suspended context / stalled background element on a track switch.)
  await wakeAudio();
  try {
    await p;
  } catch {
    // Engine failed to initialise (worklet/worker load failure). The onError
    // handler already moved the transport into its error state; there's nothing
    // to load, so bail instead of throwing an unhandled rejection out of playTrack.
    return;
  }
  // Move output onto the media element (best-effort) so it survives the page
  // being backgrounded / the screen locking. Triggered from the play gesture.
  void routeAudioToElement();
  player.load(host().fileUrl(track.hash), track.subsong ?? 0);
  syncNowPlaying();
  // Arm play-count gating for this track; the count fires from onProgress once
  // it's been listened to past the threshold (not on a fast skip).
  playCounted = false;
  playCountHash = track.hash;
  // Fix the next song now (deterministic) and warm its bytes (debounced).
  rollNext();
  schedulePrefetch();
}

/** Count a play once the current track has progressed past a listen threshold
 *  (~10s, or half its length for short tunes) — so skipping through doesn't
 *  inflate counts. Position only advances while actually playing, so pausing
 *  can't trip it either. */
function maybeCountPlay(pos: number) {
  if (playCounted || !playCountHash) return;
  const t = playback.current;
  if (!t || t.hash !== playCountHash) return;
  const dur = playback.duration || 0;
  const threshold = dur > 0 ? Math.min(10, dur * 0.5) : 10;
  if (pos < threshold) return;
  playCounted = true;
  void host()
    .play(t.hash)
    .then((r) => {
      t.play_count = r.play_count; // reflect new total on the (proxied) track
    })
    .catch(() => {
      /* best effort */
    });
}

/** The next `n` entries the queue will play, the current one first.
 *
 *  A window rather than the whole queue on purpose: a cue can hand over the entire
 *  visible library (thousands of tracks), and putting that array into `$state` would
 *  deep-proxy every Track on every cue for the sake of a visualiser showing eight rows.
 *  Callers re-read this when `playback.queueIndex` / `playback.current` change, which
 *  are reactive.
 *
 *  Walks the same planner the transport uses, so a shuffled queue reads in the order it
 *  will actually be heard rather than in list order. */
export function upcoming(n: number): Track[] {
  const out: Track[] = [];
  const len = queueRefs.length;
  if (!len || playback.queueIndex < 0) return out;
  if (playback.shuffle && shuffleOrder.length !== len) buildShuffleOrder();
  let idx: number | null = playback.queueIndex;
  // Shuffle wraps endlessly, so stop on a repeat rather than circling forever.
  const seen = new Set<number>();
  while (idx !== null && out.length < n && !seen.has(idx)) {
    seen.add(idx);
    // Sync-only: an un-hydrated entry is skipped rather than awaited, so this
    // stays usable from a `$derived`. The window just reads shorter until the
    // host has that page cached.
    const t = trackAt(idx);
    if (t) out.push(t);
    idx = plannedNext(len, idx, playback.shuffle, shuffleOrder);
  }
  return out;
}

/** Play `track` as part of an ordered `list` (enables next/prev + auto-advance).
 *  For hosts that hold their whole library in memory. */
export async function playInOrder(list: Track[], track: Track) {
  setQueue(list.map(refOf), list);
  playback.queueIndex = list.findIndex((t) => refOf(t) === refOf(track));
  await playTrack(track);
}

/** Play the entry at `index` of an ordered ref list — the server-side-library
 *  form of {@link playInOrder}. The host resolves refs to tracks on demand. */
export async function playRefs(refs: QueueRef[], index: number) {
  setQueue(refs);
  playback.queueIndex = index;
  const t = await resolveAt(index);
  if (!t) {
    playback.error = "track unavailable";
    return;
  }
  await playTrack(t);
}

/** Restore a selection (e.g. from `?t=` on a cold reload) WITHOUT starting audio:
 *  cue the track, decode its pattern in the worker (no gesture needed, so the
 *  grid fills in), and leave the transport in a ready (▶) state. Audio starts on
 *  the first user gesture (the play button), which the browser requires anyway. */
export function cueInOrder(list: Track[], track: Track) {
  setQueue(list.map(refOf), list);
  playback.queueIndex = list.findIndex((t) => refOf(t) === refOf(track));
  cueTrack(track);
}

/** {@link cueInOrder} for a ref queue: cue `track` (already in hand, from the
 *  deep link) at `index` of `refs`, without resolving the rest. */
export function cueRefs(refs: QueueRef[], index: number, track: Track) {
  setQueue(refs);
  queueCache.set(refs[index] ?? refOf(track), track);
  playback.queueIndex = index;
  cueTrack(track);
}

function cueTrack(track: Track) {
  resetForTrack(track);
  rollNext(); // so next/prev + a later prefetch have a target
  transport.send({ type: "CUE" }); // → cued.decoding; the decode actor fills in the song
}

/** Pre-roll the next queue index. Sequential → +1 (null at the end). Shuffle →
 *  a random pick ≠ current, chosen NOW so the next song is fixed ahead of the
 *  transition (deterministic, prefetchable) instead of at the moment we advance. */
function rollNext() {
  const len = queueRefs.length;
  if (playback.shuffle && shuffleOrder.length !== len) buildShuffleOrder();
  plannedNextIdx = plannedNext(len, playback.queueIndex, playback.shuffle, shuffleOrder);
}

/** Warm the browser HTTP cache with the pre-rolled next track's bytes, so the
 *  next switch skips the network (/api/file is cacheable + content-hash stable).
 *  Debounced: mashing next keeps rescheduling, so we only fetch once the user
 *  settles — never the tracks they skip straight past. */
function schedulePrefetch() {
  if (prefetchTimer) clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    prefetchTimer = null;
    const idx = plannedNextIdx;
    if (idx == null) return;
    // Resolving here doubles as a hydration warm-up: by the time the track is
    // needed, both its row data and its bytes are in hand.
    void resolveAt(idx).then((t) => {
      if (!t || plannedNextIdx !== idx) return;
      const url = host().fileUrl(t.hash);
      if (url === prefetchedUrl) return; // already warmed
      prefetchedUrl = url;
      void fetch(url).catch(() => {
        prefetchedUrl = null; // let a later attempt retry
      });
    });
  }, 1200);
}

export function playNext() {
  if (plannedNextIdx == null) return;
  const idx = plannedNextIdx;
  playback.queueIndex = idx;
  void resolveAt(idx).then((t) => {
    if (t) void playTrack(t);
  });
}

// Seconds into a track past which "previous" restarts it instead of stepping
// back — the familiar music-player behaviour (first tap → back to the start,
// second → the previous track).
const PREV_RESTART_SEC = 10;

export function playPrev() {
  const prev = plannedPrev(queueRefs.length, playback.queueIndex, playback.shuffle, shuffleOrder);
  // Past the threshold, or nowhere to step back to → restart the current track.
  // (Shuffle wraps, so prev is null only at the start of a sequential queue.)
  if (playback.position > PREV_RESTART_SEC || prev == null) {
    seekSeconds(0);
    return;
  }
  // Step within the existing queue — don't rebuild it, or the seeded order (and
  // therefore the history `prev` is retracing) would be thrown away.
  playback.queueIndex = prev;
  void resolveAt(prev).then((t) => {
    if (t) void playTrack(t);
  });
}

export function toggleShuffle() {
  playback.shuffle = !playback.shuffle;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem("player:shuffle", playback.shuffle ? "1" : "0");
  }
  // Fresh seeded order each time shuffle is switched on (persisted, so a reload
  // resumes the same order).
  if (playback.shuffle) {
    shuffleSeed = newShuffleSeed();
    buildShuffleOrder();
  }
  // Re-roll the (now differently-chosen) next track + re-warm the cache.
  rollNext();
  schedulePrefetch();
}

export function toggleRepeat() {
  playback.repeat = !playback.repeat;
  if (player) player.setRepeatCount(playback.repeat ? -1 : 0);
}

/** The transport play/pause/restart button: from stopped → restart the current
 *  track from the top; otherwise toggle play ↔ pause in place. */
export function transportToggle() {
  if (!playback.current) return;
  // In edit mode the transport drives the pattern loop, not the (suppressed) song.
  if (playback.editing) {
    seqToggle();
    return;
  }
  if (!playback.playing) void playTrack(playback.current);
  else togglePause();
}

export function togglePause() {
  if (playback.editing) {
    seqStop(); // edit mode: pause = stop the pattern loop (song stays suppressed)
    return;
  }
  if (!player || !playback.current || !playback.playing) return;
  // If it "shows playing" but the render has been frozen >2s, the iOS audio unit
  // is dead behind a state="running" context — a toggle here does nothing, so
  // rebuild the engine on this gesture instead.
  if (tapRecreatesStalled()) return;
  // Resuming from pause after the app was backgrounded: iOS suspended the idle
  // context (dead behind a state="running" lie that resume() can't revive), and
  // there was no render to stall-detect. Rebuild on a fresh context inside this
  // tap — same cure as the stalled-playing case — rather than a no-op worklet
  // unpause. recreateEngine reloads the current track at its position and plays.
  if (playback.paused && hiddenWhilePaused) {
    hiddenWhilePaused = false;
    void recreateEngine();
    return;
  }
  player.togglePause();
  transport.send({ type: "TOGGLE" }); // playing ⇄ paused; the subscription flips playback.paused
  if (playback.paused) {
    // Pause the routed <audio> too. Once output is moved to it, that element is
    // the only sink — the worklet going silent doesn't pause the element, so it
    // keeps streaming silence and its own `paused` state stays false. The OS /
    // hardware transport then reads it as still playing and keeps sending "pause"
    // (never "play"), so playback pauses but can't be resumed. Pausing it keeps
    // the element's state coherent with ours.
    pauseMediaElement();
  } else {
    // Unpausing: iOS may have suspended the context and stalled the background
    // <audio> element during the pause; nudge both back to life inside this tap.
    void wakeAudio();
  }
  syncNowPlaying();
}

/** Halt playback and reset to the start, but keep the module loaded and the
 *  player view open — the transport flips to ▶ (restart). */
export function stop() {
  if (!player) return;
  if (playback.seqPlaying) seqStop();
  player.stop();
  playback.position = 0;
  playback.row = 0;
  playback.order = 0;
  resetBeat();
  transport.send({ type: "STOP" }); // → stopped; the subscription clears playing/paused
  syncNowPlaying();
}

/** Fully unload the current track: stop audio and clear the loaded module +
 *  queue, so nothing is shown or replayable. Used when the app removes the
 *  current track from its library (the bytes are about to vanish) — a plain
 *  stop() keeps `current` for replay, which would leave a ghost mini-player over
 *  a track that no longer exists. */
export function eject() {
  stop();
  setQueue([]);
  plannedNextIdx = null;
  playback.current = null;
  playback.song = null;
  playback.samples = [];
  playback.instruments = [];
  playback.notes = [];
  notesGen++; // an in-flight fetch must not repopulate after an eject
  resetTrace();
  playback.duration = 0;
  playback.position = 0;
  playback.queueIndex = -1;
  playback.queueLength = 0;
}

export function setMuted(m: boolean) {
  if (!player) return;
  // Unmuting restores the LEVEL, not full scale — otherwise a saved volume is thrown away
  // on every mute/unmute cycle.
  player.setVol(m ? 0 : playback.volume);
  playback.muted = m;
}

/** Master output level, 0..1. Persisted; takes effect immediately unless muted. */
export function setVolume(v: number) {
  const level = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1));
  playback.volume = level;
  if (player && !playback.muted) player.setVol(level);
  try {
    localStorage.setItem("player:volume", String(level));
  } catch {
    /* no storage — the level just won't outlive the session */
  }
}

/** Toggle mono downmix of the output (accessibility); persisted. */
export function setMono(on: boolean) {
  playback.mono = on;
  player?.setMono(on);
  try {
    localStorage.setItem("player:mono", on ? "1" : "0");
  } catch {
    /* storage unavailable — non-fatal */
  }
}

/** Parse a module's metadata without playing it (bulk library enrichment). */
export async function parseModule(buffer: ArrayBuffer): Promise<ParsedMeta | null> {
  try {
    await ensurePlayer();
  } catch {
    return null; // engine unavailable (init failed) — nothing to parse against
  }
  const id = ++parseId;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingParse.delete(id);
      resolve(null);
    }, 15000);
    pendingParse.set(id, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    player.parse(id, buffer);
  });
}

export function seekSeconds(sec: number) {
  if (!player || !playback.current) return;
  player.setPos(sec);
  playback.position = sec;
}

/** Jump playback to the start of order-list position `o` (for the order strip). */
export function seekToOrder(o: number) {
  if (!player || !playback.current) return;
  player.setOrderRow(o, 0);
  playback.order = o;
  playback.row = 0;
  // Set the pattern directly too — in edit mode libopenmpt is paused, so it won't
  // arrive via onProgress, and the grid/sequencer key off playback.pattern.
  playback.pattern = playback.song?.orders?.[o]?.pat ?? playback.pattern;
}

// Mutes are applied to the LIVE module (chan_mute → CHN_MUTE), so the song's own
// render drops the channel. State is per-session per-module (reset on load).
//
// They take effect at the DECODER, which renders about a second and a half ahead of what
// you are hearing (decoder.worker.js TARGET) — so a toggle is silent for that long before
// it lands. That buffer depth is deliberate and measured; see the note there.

/** Mute/unmute channel `ch`. */
export function setChannelMute(ch: number, on: boolean) {
  if (!player || !playback.canMuteChannels) return;
  const next = playback.channelMutes.slice();
  next[ch] = on;
  playback.channelMutes = next;
  player.muteChannel(ch, on);
}

/** Toggle one channel's mute. */
export function toggleChannelMute(ch: number) {
  setChannelMute(ch, !playback.channelMutes[ch]);
}

/** Solo channel `ch` (mute every other channel). Toggles back off if `ch` is
 *  already the sole audible channel. */
export function soloChannel(ch: number) {
  const n = playback.song?.channels?.length ?? 0;
  if (!player || !playback.canMuteChannels || !n) return;
  const alreadySolo =
    playback.channelMutes.length === n &&
    playback.channelMutes.every((m, i) => (i === ch ? !m : m));
  const next = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    const on = alreadySolo ? false : i !== ch;
    next[i] = on;
    player.muteChannel(i, on);
  }
  playback.channelMutes = next;
}

/** True if channel `ch` is the only audible one (every other channel muted). */
export function isChannelSolo(ch: number): boolean {
  const m = playback.channelMutes;
  const n = playback.song?.channels?.length ?? 0;
  if (!n || m.length !== n) return false;
  return !m[ch] && m.some(Boolean) && m.every((v, i) => (i === ch ? !v : v));
}

// Jamming plays a sample's raw PCM directly through Web Audio — a plain
// AudioBufferSource pitched to the key and looped at the sample's loop points.
// We already have the data via readSample(), so a note needs no libopenmpt
// playback engine at all: it's independent of the song (never touches the
// transport; works stopped/paused/playing) and dead simple. Requires the custom
// build (canReadSamples); no-ops otherwise.

/** Read one sample's PCM + metadata (1-based index) — for the waveform pane and
 *  the sampler. Goes through the worker's smp_read. */
export async function readSample(idx: number): Promise<SampleData | null> {
  if (!player || !playback.canReadSamples) return null;
  return player.readSample(idx) as Promise<SampleData | null>;
}

/** Export sample `idx` (1-based) as a WAV, in its ORIGINAL specs — native
 *  bit-depth, sample rate, and channel count, no resampling/requantization. */
export async function exportSampleWav(idx: number, name?: string) {
  if (!player || !playback.canReadSamples) return;
  const data = (await player.readSampleRaw(idx)) as SampleRaw | null;
  if (!data || data.raw.length === 0) return;
  const blob = buildWav(data.raw, data.info);
  const base = (name || `sample-${idx}`).replace(/[^\w.-]+/g, "_").slice(0, 64) || `sample-${idx}`;
  triggerDownload(blob, `${base}.wav`);
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// resetJam runs on track change; clearEdits/seqStop are the editor hooks the
// transport calls. Both modules attach to the engine in ensurePlayer.

/** Reflect parsed metadata in the playing track and persist it (best effort). */
async function saveMeta(track: Track, meta: Meta) {
  const payload = {
    title: meta?.title || null,
    type_long: meta?.type_long || null,
    tracker: meta?.tracker || null,
    duration: meta?.dur ?? null,
    channels: meta?.song?.channels?.length ?? null,
    instruments: meta?.song?.instruments?.length ?? null,
    samples: meta?.song?.samples?.length ?? null,
    n_orders: meta?.totalOrders ?? null,
    n_patterns: meta?.totalPatterns ?? null,
  };
  // Mutate the (proxied) track so the library list updates immediately.
  track.title = payload.title;
  track.type_long = payload.type_long;
  track.tracker = payload.tracker;
  track.duration = payload.duration;
  track.channels = payload.channels;
  track.instruments = payload.instruments;
  track.samples = payload.samples;
  try {
    await host().putMeta(track.hash, payload);
  } catch {
    /* best effort — enrichment is a cache, not critical */
  }
}

// Dev-only: on HMR this module re-evaluates and `playback`/`player` reset, but
// the old AudioContext graph keeps playing (orphaned, with no controls). Tear it
// down on dispose so a hot reload lands in a clean stopped state.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    try {
      transport.stop();
      seqStop(); // editor's own dispose tears the sequencer graph down too
      player?.stop();
      player?.context?.close?.();
    } catch {
      /* nothing to tear down */
    }
  });
}
