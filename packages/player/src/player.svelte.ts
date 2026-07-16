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
  routeAudioToElement,
  setupMediaElementRoute,
  wakeAudio,
} from "./background";
import { BeatTracker } from "./beat";
import { attachEditor, clearEdits, seqStop, seqToggle } from "./editor.svelte";
import { createEngine } from "./engine";
import { host, type Track } from "./host";
import { attachJam, resetJam } from "./jam";
import { syncNowPlaying, syncPosition, wirePlatformIntegration } from "./platform";
import { plannedNext } from "./queue";
import { SCOPE_SIZE, setScopeSource } from "./scope";
import { playback } from "./state.svelte";
import { transportMachine } from "./transport-machine";
import { buildWav } from "./wav";

export { playback } from "./state.svelte";
export { jamNote, jamStop, jamStopAll, setJamLevel } from "./jam";

// Re-export the pure/self-contained helpers moved to sibling modules so the
// package's public API — and in-package components importing from
// "./player.svelte" — are unchanged.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let player: any = null;
let ready: Promise<void> | null = null;
let parseId = 0;
// Play-count gating: only count a tune once it's actually been listened to past
// a threshold (so fast skips don't inflate counts). Reset per track start.
let playCounted = false;
let playCountHash: string | null = null;
// Plain (non-reactive) registry of in-flight parse resolvers — not UI state.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const pendingParse = new Map<number, (m: ParsedMeta | null) => void>();

// --- Beat tracking (module row/tempo) ---------------------------------------
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

// The reactive `playback` store lives in ./state (imported above), re-exported
// below so the public API + component imports from "./player.svelte" are
// unchanged.

let queue: Track[] = [];
// Pre-rolled next queue index: chosen when a track *starts*, so the next song is
// deterministic (and thus prefetchable) rather than picked at the moment of
// advancing. Sequential = +1; shuffle = a random pick ≠ current, rolled now.
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

// --- transport state machine -------------------------------------------------
// The machine (transport-machine.ts) is the single source of truth for play /
// pause / cued / decoding state; this subscription mirrors it onto
// `playback.playing`/`paused`, so the transport can never show a state it isn't
// in (the cold-reload "pause icon over a frozen clock" bug). The imperative
// engine work (load / pause / stop, background routing, iOS) stays in the
// functions below — the machine governs *state*, not the audio graph.
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
        ensurePlayer(); // create the engine (its worker starts loading libopenmpt)
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

function ensurePlayer(): Promise<void> {
  if (player) return ready as Promise<void>;
  // Synchronous `new AudioContext()` keeps us inside the click gesture.
  player = createEngine({ repeatCount: 0 });
  attachBackground(player); // wire background routing + wakeAudio to this engine
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
      playback.canMuteChannels = player.capabilities?.canMuteChannels ?? false;
      playback.canReadCells = player.capabilities?.canReadCells ?? false;
      if (playback.mono) player.setMono(true); // restore persisted mono downmix
      setupMediaElementRoute();
    })
    .catch(() => {
      /* engine init failed; surfaced by awaiters */
    });
  player.onProgress((d: ProgressMsg) => {
    consecutiveErrors = 0; // a frame arrived → this track plays; clear the skip guard
    // First frame confirms audio is actually running (loading → playing).
    if (transport.getSnapshot().matches("loading")) transport.send({ type: "PROGRESS" });
    playback.position = d.pos ?? 0;
    playback.order = d.order ?? 0;
    playback.pattern = d.pattern ?? 0;
    playback.row = d.row ?? 0;
    playback.vu = d.vu ?? [];
    noteRow(playback.order, playback.pattern, playback.row);
    maybeCountPlay(d.pos ?? 0);
    // Keep the OS scrubber roughly in step (throttled to ~1s of playback).
    syncPosition();
  });
  player.onMetadata((meta: Meta) => {
    player.setRepeatCount(playback.repeat ? -1 : 0);
    applyMeta(meta); // song/duration/mutes + save + OS Now Playing
  });
  player.onEnded(() => {
    // (With repeat on, the module loops and onEnded never fires.) Auto-advance
    // to the next queue entry — random when shuffling — else fall to stopped.
    const canNext =
      playback.queueIndex >= 0 &&
      (playback.shuffle ? queue.length > 1 : playback.queueIndex + 1 < queue.length);
    if (canNext) playNext();
    else {
      transport.send({ type: "ENDED" });
      syncNowPlaying();
    }
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
      (playback.shuffle ? queue.length > 1 : playback.queueIndex + 1 < queue.length);
    if (canAdvance && consecutiveErrors <= queue.length) {
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
  // --- Wake-from-freeze resync -------------------------------------------
  // Song timing is purely output-paced (the worklet drains PCM, the worker
  // refills on ack) — nothing tracks wall time. After the OS sleeps (or a very
  // long suspend) the audio hardware freezes; on wake the pipeline can race to
  // catch up, so patterns fly by with only squeaks and only a reload recovers.
  // Detect the freeze by the audio clock (context.currentTime) falling far
  // behind wall-clock, then flush + reseek to the pre-freeze position (setPos
  // bumps the generation → the worklet drops its stale queue, the worker
  // reseeks) so playback restarts clean. A normal second-to-second tick never
  // trips it (the two clocks stay in step, including while merely paused or
  // backgrounded-but-playing); only a real freeze makes the audio clock stall.
  let lastWall = performance.now();
  let lastCtx = player.context.currentTime;
  let lastPos = 0;
  setInterval(() => {
    const wall = performance.now();
    const ctx = player.context.currentTime;
    const stalled = wall - lastWall - (ctx - lastCtx) * 1000; // ms the audio clock fell behind
    lastWall = wall;
    lastCtx = ctx;
    if (stalled > 3000 && playback.current && (playback.playing || playback.paused)) {
      try {
        player.setPos(lastPos); // discard the racing/stale pipeline; restart clean
      } catch {
        /* engine gone */
      }
    }
    lastPos = playback.position;
  }, 1000);

  wirePlatformIntegration({
    toggle: transportToggle,
    togglePause,
    next: playNext,
    prev: playPrev,
  });
  return ready as Promise<void>;
}

// OS / platform integration (Media Session, wake lock, foreground resume) lives
// in ./platform; the media-session buttons drive the transport controls passed
// into wirePlatformIntegration from ensurePlayer. Background playback (media-
// element route) + wakeAudio live in ./background. Both imported above.

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

/** Load a track and play it from the start (audible unless muted). */
export async function playTrack(track: Track) {
  // Stop the current module so the worklet drops it before we load the next.
  if (player) player.stop();
  resetJam(); // drop cached sample buffers + any live jam voices from the old module
  playback.error = null;
  playback.current = track;
  pendingTrack = track;
  transport.send({ type: "LOAD" }); // → loading; the subscription flips the transport to ⏸
  playback.position = 0;
  playback.duration = track.duration ?? 0;
  playback.song = null;
  playback.row = 0;
  playback.order = 0;
  playback.pattern = 0;
  playback.channelMutes = []; // repopulated when this module's metadata arrives
  clearEdits(); // drop editor buffer + stop the editor sequencer
  resetBeat();
  const p = ensurePlayer();
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
  player.load(host().fileUrl(track.hash));
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

/** Play `track` as part of an ordered `list` (enables next/prev + auto-advance). */
export async function playInOrder(list: Track[], track: Track) {
  queue = list;
  playback.queueLength = list.length;
  // Identity = path ?? hash: tracker has duplicate-content modules at distinct
  // paths; party tracks are hash-only (path undefined).
  const key = (t: Track) => t.path ?? t.hash;
  playback.queueIndex = list.findIndex((t) => key(t) === key(track));
  await playTrack(track);
}

/** Restore a selection (e.g. from `?t=` on a cold reload) WITHOUT starting audio:
 *  cue the track, decode its pattern in the worker (no gesture needed, so the
 *  grid fills in), and leave the transport in a ready (▶) state. Audio starts on
 *  the first user gesture (the play button), which the browser requires anyway. */
export function cueInOrder(list: Track[], track: Track) {
  queue = list;
  playback.queueLength = list.length;
  const key = (t: Track) => t.path ?? t.hash;
  playback.queueIndex = list.findIndex((t) => key(t) === key(track));
  playback.error = null;
  playback.current = track;
  playback.position = 0;
  playback.duration = track.duration ?? 0;
  playback.song = null;
  playback.row = 0;
  playback.order = 0;
  playback.pattern = 0;
  playback.channelMutes = [];
  clearEdits();
  resetBeat();
  pendingTrack = track;
  rollNext(); // so next/prev + a later prefetch have a target
  transport.send({ type: "CUE" }); // → cued.decoding; the decode actor fills in the song
}

/** Pre-roll the next queue index. Sequential → +1 (null at the end). Shuffle →
 *  a random pick ≠ current, chosen NOW so the next song is fixed ahead of the
 *  transition (deterministic, prefetchable) instead of at the moment we advance. */
function rollNext() {
  plannedNextIdx = plannedNext(queue.length, playback.queueIndex, playback.shuffle);
}

/** Warm the browser HTTP cache with the pre-rolled next track's bytes, so the
 *  next switch skips the network (/api/file is cacheable + content-hash stable).
 *  Debounced: mashing next keeps rescheduling, so we only fetch once the user
 *  settles — never the tracks they skip straight past. */
function schedulePrefetch() {
  if (prefetchTimer) clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    prefetchTimer = null;
    if (plannedNextIdx == null) return;
    const t = queue[plannedNextIdx];
    if (!t) return;
    const url = host().fileUrl(t.hash);
    if (url === prefetchedUrl) return; // already warmed
    prefetchedUrl = url;
    void fetch(url).catch(() => {
      prefetchedUrl = null; // let a later attempt retry
    });
  }, 1200);
}

export function playNext() {
  if (plannedNextIdx == null) return;
  const idx = plannedNextIdx;
  playback.queueIndex = idx;
  void playTrack(queue[idx]);
}

// Seconds into a track past which "previous" restarts it instead of stepping
// back — the familiar music-player behaviour (first tap → back to the start,
// second → the previous track).
const PREV_RESTART_SEC = 10;

export function playPrev() {
  // Past the threshold (or already on the first track): restart from the top.
  if (playback.position > PREV_RESTART_SEC || playback.queueIndex <= 0) {
    seekSeconds(0);
    return;
  }
  void playInOrder(queue, queue[playback.queueIndex - 1]);
}

export function toggleShuffle() {
  playback.shuffle = !playback.shuffle;
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
  queue = [];
  plannedNextIdx = null;
  playback.current = null;
  playback.song = null;
  playback.samples = [];
  playback.instruments = [];
  playback.duration = 0;
  playback.position = 0;
  playback.queueIndex = -1;
  playback.queueLength = 0;
}

export function setMuted(m: boolean) {
  if (!player) return;
  player.setVol(m ? 0 : 1);
  playback.muted = m;
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

// --- channel mute / solo (custom build) -------------------------------------
// Mutes are applied to the LIVE module (chan_mute → CHN_MUTE), so the song's own
// render drops the channel. State is per-session per-module (reset on load).

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

/** Unmute every channel. */
export function clearChannelMutes() {
  const n = playback.song?.channels?.length ?? 0;
  if (!player || !playback.canMuteChannels) return;
  for (let i = 0; i < n; i++) player.muteChannel(i, false);
  playback.channelMutes = new Array(n).fill(false);
}

// --- Jamming (Web Audio sampler) + sample extraction ------------------------
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

// The Web Audio sampler (jam voices) lives in ./jam and the pattern editor +
// sequencer in ./editor — both attached to the engine in ensurePlayer and
// re-exported above. resetJam runs on track change; clearEdits/seqStop are the
// editor hooks the transport calls.

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
