// Reactive playback store wrapping the (vendored) chiptune3 libopenmpt engine.
// One AudioContext/worklet for the whole app, created lazily on the first play
// (inside a user gesture, so the browser allows audio). When a module's
// metadata arrives we both reflect it in the now-playing track and write it
// back to the backend cache (/api/meta) — so titles/durations fill in as you
// listen, keyed by content hash.

import { host, type Track } from "./host";
import { ChiptuneJsPlayer } from "./vendor/chiptune3.js";

type ProgressMsg = {
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
/** Field order within a structured cell (indices into Pattern.cells[r][c]). */
export const CELL = { note: 0, inst: 1, volcmd: 2, vol: 3, fx: 4, param: 5 } as const;

// libopenmpt note values (soundlib/modcommand.h): 0 empty, 1..120 real notes
// (NOTE_MIDDLEC = 61 = C-5), 253 fade, 254 cut, 255 key-off.
const NOTE_MIN = 1;
const NOTE_MAX = 120;
const NOTE_MIDDLEC = 61;
const NOTE_FADE = 253;
const NOTE_CUT = 254;
const NOTE_OFF = 255;
const SEMI = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"];

/** True for a playable pitch (not empty/off/cut/fade). */
export function isRealNote(n: number): boolean {
  return n >= NOTE_MIN && n <= NOTE_MAX;
}
/** libopenmpt note value → display name ("C-5", "===", "^^^", "~~~", "..."). */
export function noteName(n: number): string {
  if (isRealNote(n)) return SEMI[(n - 1) % 12] + Math.floor((n - 1) / 12);
  if (n === NOTE_OFF) return "===";
  if (n === NOTE_CUT) return "^^^";
  if (n === NOTE_FADE) return "~~~";
  return "...";
}
/** libopenmpt note value → jam/playbackRate note (jamNote's 60 = sample middle-C,
 *  libopenmpt's 61 = NOTE_MIDDLEC), so pattern note N plays at the right pitch. */
export function noteToJam(n: number): number {
  return n - (NOTE_MIDDLEC - 60);
}
export type Song = {
  channels?: string[];
  instruments?: string[];
  samples?: string[];
  patterns?: Pattern[];
  /** The order list — the sequence of patterns played, one entry per position. */
  orders?: { name: string; pat: number }[];
};
// libopenmpt metadata keys are flattened onto the object, plus `song` + totals.
type Meta = {
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
let analyser: AnalyserNode | null = null;
let parseId = 0;
let wakeLock: WakeLockSentinel | null = null;
let platformWired = false;
// Play-count gating: only count a tune once it's actually been listened to past
// a threshold (so fast skips don't inflate counts). Reset per track start.
let playCounted = false;
let playCountHash: string | null = null;
// Plain (non-reactive) registry of in-flight parse resolvers — not UI state.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const pendingParse = new Map<number, (m: ParsedMeta | null) => void>();

/** Output-waveform sample count for the scope (power of two). */
export const SCOPE_SIZE = 2048;

/** Fill `buf` (length SCOPE_SIZE) with the current output waveform (0–255,
 *  128 = silence). Returns false until the audio graph exists. */
export function readScope(buf: Uint8Array<ArrayBuffer>): boolean {
  if (!analyser) return false;
  analyser.getByteTimeDomainData(buf);
  return true;
}

/** Number of frequency bins the analyser exposes (fftSize / 2). */
export const SPECTRUM_SIZE = SCOPE_SIZE / 2;

/** Fill `buf` (length SPECTRUM_SIZE) with the current output frequency
 *  magnitudes (0–255). Returns false until the audio graph exists. Powers the
 *  equalizer/spectrum visualizer. */
export function readSpectrum(buf: Uint8Array<ArrayBuffer>): boolean {
  if (!analyser) return false;
  analyser.getByteFrequencyData(buf);
  return true;
}

// Reused across sampleBands() calls so a per-frame viz doesn't allocate.
const bandBuf = new Uint8Array(SPECTRUM_SIZE);

/** Current output energy split into three bands (bass / mid / treble), each
 *  roughly 0–1, from the analyser's frequency magnitudes averaged over fixed Hz
 *  ranges. Zeros until the audio graph exists. Lets visualizers react per-band
 *  (e.g. bass → pulse, treble → sparkle) instead of to one overall level. */
export function sampleBands(): { bass: number; mid: number; treble: number } {
  if (!analyser) return { bass: 0, mid: 0, treble: 0 };
  analyser.getByteFrequencyData(bandBuf);
  const hzPerBin = analyser.context.sampleRate / 2 / bandBuf.length;
  const avg = (loHz: number, hiHz: number) => {
    const lo = Math.max(0, Math.floor(loHz / hzPerBin));
    const hi = Math.min(bandBuf.length, Math.ceil(hiHz / hzPerBin));
    let sum = 0;
    for (let i = lo; i < hi; i++) sum += bandBuf[i];
    return hi > lo ? sum / (hi - lo) / 255 : 0;
  };
  return { bass: avg(20, 200), mid: avg(200, 2000), treble: avg(2000, 8000) };
}

// --- Beat tracking (module row/tempo) ---------------------------------------
// In tracker music the pattern rows are the beat grid; a musical beat is the
// conventional every-4th-row. We watch the row advance in onProgress (which the
// worklet fires synced to audio) and pulse on each beat boundary — so this is
// exact to the module and tracks tempo/speed changes for free (rows simply
// arrive faster or slower). Visualizers read `playback.beat` for the on-beat
// tick and `beatPhase()` for a smooth 0→1 ramp between beats.
const ROWS_PER_BEAT = 4;
let lastRow = -1;
let lastOrder = -1;
let lastPattern = -1;
let lastBeatAt = 0; // performance.now() of the last beat onset (0 = none yet)
let beatInterval = 500; // eased ms between beats, for the phase ramp

function resetBeat() {
  lastRow = -1;
  lastOrder = -1;
  lastPattern = -1;
  lastBeatAt = 0;
  beatInterval = 500;
}

function noteRow(order: number, pattern: number, row: number) {
  const advanced = row !== lastRow || order !== lastOrder || pattern !== lastPattern;
  if (!advanced) return;
  lastRow = row;
  lastOrder = order;
  lastPattern = pattern;
  if (row % ROWS_PER_BEAT !== 0) return;
  const now = performance.now();
  if (lastBeatAt > 0) {
    const dt = now - lastBeatAt;
    // Ease the interval toward the latest gap, ignoring seeks/stalls (out of a
    // plausible 30ms–2s beat range) so the phase ramp stays smooth.
    if (dt > 30 && dt < 2000) beatInterval += (dt - beatInterval) * 0.25;
  }
  lastBeatAt = now;
  playback.beat++;
}

/** A 0→1 ramp since the last beat, from the eased inter-beat interval (clamped at
 *  1, and 0 until the first beat). Lets a viz pulse on-beat without each one
 *  re-deriving timing from the raw row. */
export function beatPhase(now = performance.now()): number {
  if (!lastBeatAt) return 0;
  return Math.min(1, (now - lastBeatAt) / beatInterval);
}

/** Estimated musical tempo in BPM, from the eased inter-beat interval (a beat =
 *  ROWS_PER_BEAT rows). ~0 until the first beat. Clamped to a sane range so a
 *  stall/seek can't spike it. Lets visualizers scale motion to tempo, not just
 *  loudness — works in both apps (no libopenmpt tempo read needed). */
export function beatBpm(): number {
  if (!lastBeatAt) return 0;
  return Math.max(40, Math.min(300, 60000 / beatInterval));
}

// Playback is a small state machine over one loaded module:
//   stopped: playing=false            (transport shows ▶; play restarts from top)
//   playing: playing=true, paused=false
//   paused:  playing=true, paused=true
// `current`/`song` persist through stop so the player view stays put; only
// opening another track replaces them.
export const playback = $state({
  current: null as Track | null,
  playing: false,
  paused: false,
  position: 0,
  duration: 0,
  order: 0,
  pattern: 0,
  row: 0,
  // Edit/inspect cursor in the pattern grid (row + channel) — groundwork for the
  // editor; today it highlights a cell, navigates by arrows, and can seek to its
  // row. Independent of the playing row.
  cursorRow: 0,
  cursorCh: 0,
  // Editor: which sub-column of the cursor cell is active (0 note, 1 inst, 2 vol,
  // 3 fx, 4 param), and whether edit mode is on. Edit mode swaps the pattern grid
  // to a structured, per-field-editable render and enables note/hex entry.
  cursorField: 0,
  editing: false,
  editOctave: 5, // base octave for QWERTY note entry (C-5 = middle C)
  editStep: 1, // rows the cursor advances after entering a note
  editInst: 1, // instrument written with a newly entered note
  // Editor sequencer (our own Web Audio playback of the edited pattern, so edits
  // are audible independently of libopenmpt). Loops the current pattern.
  seqPlaying: false,
  seqRow: 0, // row the sequencer is currently sounding
  seqBpm: 125, // classic default (row secs = 2.5 * speed / bpm)
  seqSpeed: 6,
  beat: 0, // bumps once per musical beat (see noteRow) — a reactive on-beat tick
  vu: [] as number[],
  song: null as Song | null,
  samples: [] as string[],
  instruments: [] as string[],
  muted: false,
  // Downmix output to mono (accessibility). Persisted; applied once the engine
  // is ready. Read at startup so the choice survives reloads.
  mono: typeof localStorage !== "undefined" && localStorage.getItem("player:mono") === "1",
  shuffle: false,
  repeat: false, // loop the current module forever (libopenmpt repeat_count = -1)
  // Position in the play queue (the ordered list the current track was opened
  // from), so next/prev and auto-advance work. -1 = no queue.
  queueIndex: -1,
  queueLength: 0,
  error: null as string | null,
  // Custom-build capability (this app's vendored WASM carries the sample-read
  // shim; party's stock build doesn't). Set once the engine reports ready. UI
  // (keyboard, waveform pane) gates on it so the shared package degrades.
  canReadSamples: false,
  // Custom-build capabilities for the editor: per-channel mute/solo and structured
  // pattern cells. Both false on party's stock build (UI hides accordingly).
  canMuteChannels: false,
  canReadCells: false,
  // Per-channel mute state (index = channel), length = the loaded module's channel
  // count; reset on load. Solo mutes every other channel. Applied to the live
  // module via chan_mute so the song's own render drops the channel.
  channelMutes: [] as boolean[],
  // Live sample-frame position of the current jammed note (-1 = none), for the
  // waveform play cursor. Reported by the worker synced to audio.
  jamPos: -1,
  // How many jam keys are currently held — lets the UI suppress track-switch
  // arrows while jamming so you can navigate samples without changing tracks.
  jamHeld: 0,
  // Jam level (0..2): a trim on the song-matched level in auto mode, else a
  // plain fader. And whether to auto-balance to the song (default on).
  jamLevel: 1,
  jamAutoLevel: true,
  // Force one-shot playback (ignore the sample's loop) when auditioning/jamming.
  jamOneShot: false,
});

let queue: Track[] = [];
// Consecutive load/playback failures without a successful frame in between —
// bounds the auto-skip past broken modules so a fully-unplayable queue can't
// spin forever. Reset on the first progress tick of a track that actually plays.
let consecutiveErrors = 0;

function ensurePlayer(): Promise<void> {
  if (player) return ready as Promise<void>;
  // Synchronous `new AudioContext()` keeps us inside the click gesture.
  player = new ChiptuneJsPlayer({ repeatCount: 0 });
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
  analyser = a;
  ready = new Promise<void>((resolve) => player.onInitialized(() => resolve()));
  // Once the graph exists: reflect the engine's capabilities (jam/samples), then
  // tap it for the background-capable media-element route.
  void ready.then(() => {
    playback.canReadSamples = player.capabilities?.canReadSamples ?? false;
    playback.canMuteChannels = player.capabilities?.canMuteChannels ?? false;
    playback.canReadCells = player.capabilities?.canReadCells ?? false;
    if (playback.mono) player.setMono(true); // restore persisted mono downmix
    // Tap the song's output PRE-jam (on the worklet node, before jamGain joins
    // player.gain) so measuring it to auto-balance the jam can't feed back.
    if (player.processNode) {
      const an: AnalyserNode = player.context.createAnalyser();
      an.fftSize = 1024;
      songBuf = new Uint8Array(an.fftSize);
      player.processNode.connect(an);
      songAnalyser = an;
    }
    setupMediaElementRoute();
  });
  player.onProgress((d: ProgressMsg) => {
    consecutiveErrors = 0; // a frame arrived → this track plays; clear the skip guard
    playback.position = d.pos ?? 0;
    playback.order = d.order ?? 0;
    playback.pattern = d.pattern ?? 0;
    playback.row = d.row ?? 0;
    playback.vu = d.vu ?? [];
    sampleSongLevel(); // keep the jam auto-balance tracking the song's loudness
    noteRow(playback.order, playback.pattern, playback.row);
    maybeCountPlay(d.pos ?? 0);
    // Keep the OS scrubber roughly in step (throttled to ~1s of playback).
    if (Math.abs(playback.position - lastPosSync) >= 1) updatePositionState();
  });
  player.onMetadata((meta: Meta) => {
    player.setRepeatCount(playback.repeat ? -1 : 0);
    playback.duration = meta?.dur ?? 0;
    playback.song = meta?.song ?? null;
    playback.samples = meta?.song?.samples ?? [];
    playback.instruments = meta?.song?.instruments ?? [];
    // Fresh mute state sized to this module's channels (createModule reset any
    // libopenmpt-side mutes on load).
    playback.channelMutes = new Array(meta?.song?.channels?.length ?? 0).fill(false);
    if (playback.current) void saveMeta(playback.current, meta);
    syncNowPlaying(); // title is known now → refresh OS Now Playing
  });
  player.onEnded(() => {
    // (With repeat on, the module loops and onEnded never fires.) Auto-advance
    // to the next queue entry — random when shuffling — else fall to stopped.
    const canNext =
      playback.queueIndex >= 0 &&
      (playback.shuffle ? queue.length > 1 : playback.queueIndex + 1 < queue.length);
    if (canNext) playNext();
    else {
      playback.playing = false;
      syncNowPlaying();
    }
  });
  player.onError((e: { type?: string }) => {
    playback.error = e?.type ?? "playback error";
    consecutiveErrors++;
    // Auto-skip past an unplayable module (corrupt / unsupported) to the next
    // queued track — but stop once we've cycled ~the whole queue, so a fully
    // broken playlist surfaces the error instead of spinning. A short delay lets
    // the error register before the next track clears it.
    const canAdvance =
      playback.queueIndex >= 0 &&
      (playback.shuffle ? queue.length > 1 : playback.queueIndex + 1 < queue.length);
    if (canAdvance && consecutiveErrors <= queue.length) {
      setTimeout(() => {
        if (playback.error) playNext();
      }, 900);
    } else {
      playback.playing = false;
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
  wirePlatformIntegration();
  return ready as Promise<void>;
}

// --- OS / platform integration (Media Session, wake lock, foreground resume) ---
//
// iOS keeps Web Audio alive only while in the foreground (a long-standing
// WebKit limitation — pure AudioContext output is suspended when backgrounded
// or the screen locks; only HTMLMediaElement audio survives). So this is a
// *foreground* convenience: OS transport buttons + Now Playing metadata
// (lock-screen controls on Android/desktop), a screen wake lock so auto-lock
// doesn't cut a listen short, and a resume when we return to the foreground.

/** Reflect current track + transport state to the OS, and hold a wake lock
 *  while actually playing. */
function syncNowPlaying() {
  const playing = playback.playing && !playback.paused;
  if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
    const t = playback.current;
    navigator.mediaSession.metadata = t
      ? new MediaMetadata({
          title: t.title || t.filename,
          artist: t.artist || t.group || host().appName,
          album: t.group || "",
          artwork: [{ src: "/icon-512.png", sizes: "512x512", type: "image/png" }],
        })
      : null;
    navigator.mediaSession.playbackState = t ? (playing ? "playing" : "paused") : "none";
    updatePositionState();
  }
  if (playing) void acquireWakeLock();
  else void releaseWakeLock();
}

// Tell the OS the track's real length + position. Output is routed through a
// MediaStream-backed <audio> element (no intrinsic duration), which the media
// transport otherwise treats as a live stream — muddying play/pause and hiding
// prev/next. A finite position state presents it as a normal track (scrubber +
// working transport keys).
let lastPosSync = -1;
function updatePositionState() {
  if (
    typeof navigator === "undefined" ||
    !("mediaSession" in navigator) ||
    typeof navigator.mediaSession.setPositionState !== "function"
  )
    return;
  lastPosSync = playback.position;
  const d = playback.duration;
  try {
    if (d > 0 && isFinite(d)) {
      navigator.mediaSession.setPositionState({
        duration: d,
        position: Math.min(Math.max(0, playback.position), d),
        playbackRate: 1,
      });
    }
  } catch {
    /* some engines throw on out-of-range values */
  }
}

async function acquireWakeLock() {
  try {
    if (
      typeof navigator !== "undefined" &&
      "wakeLock" in navigator &&
      document.visibilityState === "visible" &&
      !wakeLock
    ) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => (wakeLock = null));
    }
  } catch {
    /* denied / unsupported — non-fatal */
  }
}

async function releaseWakeLock() {
  try {
    await wakeLock?.release();
  } catch {
    /* already gone */
  }
  wakeLock = null;
}

/** One-time wiring: resume the suspended/interrupted context on return to the
 *  foreground, re-arm the wake lock, and route OS transport buttons. */
function wirePlatformIntegration() {
  if (platformWired || typeof document === "undefined") return;
  platformWired = true;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (playback.playing && !playback.paused) {
      // iOS suspends Web Audio + stalls the routed element when hidden — revive
      // both on return to the foreground.
      void wakeAudio();
      void acquireWakeLock(); // the OS drops the lock when hidden
    }
  });

  if ("mediaSession" in navigator) {
    const ms = navigator.mediaSession;
    ms.setActionHandler("play", () => transportToggle());
    ms.setActionHandler("pause", () => {
      if (playback.playing && !playback.paused) togglePause();
    });
    ms.setActionHandler("previoustrack", () => playPrev());
    ms.setActionHandler("nexttrack", () => playNext());
  }
}

// --- Background playback ----------------------------------------------------
// iOS Safari (and backgrounded desktop Safari) suspend a bare AudioContext when
// the tab is hidden or the screen locks, which freezes the worklet → silence.
// Audio routed through an <audio> *media element*, however, is allowed to keep
// playing in the background. So we tap the graph with a MediaStreamDestination
// and play its stream through a hidden <audio> element; once that element is
// actually playing we move output entirely onto it (disconnecting
// context.destination so it isn't heard twice). Best-effort: if the element
// won't play we keep the normal destination, so audio still works everywhere.
let mediaEl: HTMLAudioElement | null = null;
let streamDest: MediaStreamAudioDestinationNode | null = null;
let routedToElement = false;

function setupMediaElementRoute() {
  if (!player || streamDest || typeof Audio === "undefined") return;
  try {
    const dest: MediaStreamAudioDestinationNode = player.context.createMediaStreamDestination();
    player.monoNode.connect(dest); // after the mono downmix, like the speaker path
    const el = new Audio();
    el.srcObject = dest.stream;
    el.setAttribute("playsinline", "");
    el.preload = "auto";
    el.style.display = "none";
    document.body.appendChild(el);
    streamDest = dest;
    mediaEl = el;
  } catch {
    streamDest = null;
    mediaEl = null;
  }
}

/** Move audible output onto the media element so playback survives the page
 *  being backgrounded. Call inside the play gesture; no-op once routed or if
 *  the element can't play (we then stay on context.destination). */
async function routeAudioToElement() {
  if (!mediaEl || routedToElement || !player) return;
  try {
    await mediaEl.play();
    try {
      player.monoNode.disconnect(player.context.destination);
    } catch {
      /* wasn't connected to the speakers */
    }
    routedToElement = true;
  } catch {
    /* element playback blocked — keep the normal destination path */
  }
}

/** Revive the audio path on a user gesture (play / unpause / return-to-foreground).
 *  iOS suspends an idle or interrupted AudioContext AND pauses an idle media
 *  element after a while — and once output has been routed to the element, that
 *  element is the worklet's ONLY sink (we disconnected context.destination). So a
 *  long pause left playback dead: unpausing didn't resume the context, and even
 *  switching tracks didn't help because routeAudioToElement() no-ops once routed,
 *  so the stalled element was never replayed — only a page reload recovered. This
 *  resumes the context and re-plays the element; play() on an already-playing
 *  element resolves immediately, so it's safe to call on every gesture. */
async function wakeAudio() {
  if (!player) return;
  try {
    if (player.context.state !== "running") await player.context.resume();
  } catch {
    /* resume blocked/unsupported — recovers on the next gesture */
  }
  if (routedToElement && mediaEl) {
    try {
      await mediaEl.play();
    } catch {
      /* element won't replay — audible again after another gesture */
    }
  }
}

/** Load a track and play it from the start (audible unless muted). */
export async function playTrack(track: Track) {
  // Stop the current module so the worklet drops it before we load the next.
  if (player) player.stop();
  resetJam(); // drop cached sample buffers + any live jam voices from the old module
  playback.error = null;
  playback.current = track;
  playback.playing = true;
  playback.paused = false;
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
  await p;
  // Resume a possibly iOS-suspended context and re-play a stalled background
  // element (best-effort, inside the play gesture) — recovers a track-switch made
  // after a long pause without a reload.
  await wakeAudio();
  // Move output onto the media element (best-effort) so it survives the page
  // being backgrounded / the screen locking. Triggered from the play gesture.
  void routeAudioToElement();
  player.load(host().fileUrl(track.hash));
  syncNowPlaying();
  // Arm play-count gating for this track; the count fires from onProgress once
  // it's been listened to past the threshold (not on a fast skip).
  playCounted = false;
  playCountHash = track.hash;
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

/** Set `track` as the current/queued track WITHOUT playing it (a "cued",
 *  stopped state) — so the transport renders and next/prev work, but audio
 *  doesn't start until a user gesture (the play button). Used to restore a
 *  selection on reload, where the browser blocks autoplay anyway. */
export function cueInOrder(list: Track[], track: Track) {
  queue = list;
  playback.queueLength = list.length;
  const key = (t: Track) => t.path ?? t.hash;
  playback.queueIndex = list.findIndex((t) => key(t) === key(track));
  playback.current = track;
  playback.playing = false;
  playback.paused = false;
  playback.position = 0;
  playback.duration = track.duration ?? 0;
  playback.song = null;
}

export function playNext() {
  if (playback.queueIndex < 0 || queue.length === 0) return;
  let next: number;
  if (playback.shuffle && queue.length > 1) {
    do {
      next = Math.floor(Math.random() * queue.length);
    } while (next === playback.queueIndex);
  } else {
    next = playback.queueIndex + 1;
    if (next >= queue.length) return;
  }
  void playInOrder(queue, queue[next]);
}

export function playPrev() {
  if (playback.queueIndex > 0) void playInOrder(queue, queue[playback.queueIndex - 1]);
}

export function toggleShuffle() {
  playback.shuffle = !playback.shuffle;
}

export function toggleRepeat() {
  playback.repeat = !playback.repeat;
  if (player) player.setRepeatCount(playback.repeat ? -1 : 0);
}

/** The transport play/pause/restart button: from stopped → restart the current
 *  track from the top; otherwise toggle play ↔ pause in place. */
export function transportToggle() {
  if (!playback.current) return;
  if (playback.seqPlaying) seqStop(); // the pattern loop and the song don't fight
  if (!playback.playing) void playTrack(playback.current);
  else togglePause();
}

export function togglePause() {
  if (playback.seqPlaying) seqStop(); // stop the editor pattern loop first
  if (!player || !playback.current || !playback.playing) return;
  player.togglePause();
  playback.paused = !playback.paused;
  if (playback.paused) {
    // Pause the routed <audio> too. Once output is moved to it, that element is
    // the only sink — the worklet going silent doesn't pause the element, so it
    // keeps streaming silence and its own `paused` state stays false. The OS /
    // hardware transport then reads it as still playing and keeps sending "pause"
    // (never "play"), so playback pauses but can't be resumed. Pausing it keeps
    // the element's state coherent with ours.
    mediaEl?.pause();
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
  playback.playing = false;
  playback.paused = false;
  playback.position = 0;
  playback.row = 0;
  playback.order = 0;
  resetBeat();
  syncNowPlaying();
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
  await ensurePlayer();
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

// --- pattern cursor (editor groundwork; read-only today) --------------------
function patternDims() {
  const rows = playback.song?.patterns?.[playback.pattern]?.rows.length ?? 0;
  const chans = playback.song?.channels?.length ?? 0;
  return { rows, chans };
}

/** Place the cursor at (row, channel), clamped. Optionally seek playback there. */
export function setCursor(row: number, ch: number, seek = false) {
  const { rows, chans } = patternDims();
  if (!rows || !chans) return;
  playback.cursorRow = Math.max(0, Math.min(rows - 1, row));
  playback.cursorCh = Math.max(0, Math.min(chans - 1, ch));
  if (seek) seekToCursor();
}

/** Move the cursor by (drow, dchannel), clamped. */
export function moveCursor(dr: number, dc: number) {
  setCursor(playback.cursorRow + dr, playback.cursorCh + dc);
}

/** Jump playback to the cursor's row (Enter in the pattern grid). */
export function seekToCursor() {
  if (!player || !playback.current) return;
  player.setOrderRow(playback.order, playback.cursorRow);
  playback.row = playback.cursorRow;
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

// Build a PCM WAV from the sample's raw bytes at its native format. 16-bit data
// is already little-endian signed (matches WAV); 8-bit is signed in the module
// but WAV 8-bit is unsigned, so shift by 128 (bit-exact, just the format's
// convention). Stereo bytes are already interleaved as WAV wants.
function buildWav(raw: Uint8Array, info: SampleInfo): Blob {
  const { bits, channels: ch, rate } = info;
  let data = raw;
  if (bits === 8) {
    data = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) data[i] = (raw[i] + 128) & 0xff;
  }
  const blockAlign = ch * (bits >> 3);
  const buf = new ArrayBuffer(44 + data.length);
  const dv = new DataView(buf);
  let o = 0;
  const str = (s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o++, s.charCodeAt(i));
  };
  str("RIFF");
  dv.setUint32(o, 36 + data.length, true);
  o += 4;
  str("WAVE");
  str("fmt ");
  dv.setUint32(o, 16, true);
  o += 4;
  dv.setUint16(o, 1, true); // PCM
  o += 2;
  dv.setUint16(o, ch, true);
  o += 2;
  dv.setUint32(o, rate, true);
  o += 4;
  dv.setUint32(o, rate * blockAlign, true); // byte rate
  o += 4;
  dv.setUint16(o, blockAlign, true);
  o += 2;
  dv.setUint16(o, bits, true);
  o += 2;
  str("data");
  dv.setUint32(o, data.length, true);
  o += 4;
  new Uint8Array(buf, 44).set(data);
  return new Blob([buf], { type: "audio/wav" });
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

// AudioBuffers built from sample PCM, cached per index; invalidated on track load
// (indices are reused for different samples across modules).
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const bufCache = new Map<number, { buffer: AudioBuffer; info: SampleInfo } | null>();
let bufGen = 0;

type JamVoice = {
  src: AudioBufferSourceNode;
  start: number; // ctx time at start
  startFrame: number; // sample-frame the playback started from (click-to-audition)
  rate: number; // buffer sample rate (sample's middle-C freq)
  speed: number; // playbackRate for the pressed note
  length: number;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
};
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const voices = new Map<number, JamVoice>();
let voiceId = 0;
let lastVoice: JamVoice | null = null;
let cursorRaf = 0;

// Jammed samples play at full-scale PCM, but libopenmpt's song mix sits well
// below full-scale (mixing headroom), so a raw note would drown the song. Route
// all jam voices through one gain node (playback.jamLevel, user-tunable) so they
// sit ON TOP of the song. Connected to player.gain, so it respects volume/mute.
let jamGain: GainNode | null = null;
// Song-only output tap (connected pre-jam, so measuring it can't feed back into
// the jam gain) + a slow-smoothed RMS of it. The jam level auto-matches this so
// a note sits consistently over ANY module, however hot or quiet its master is.
let songAnalyser: AnalyserNode | null = null;
let songLevel = 0; // smoothed RMS of the song output, 0..1
let songBuf: Uint8Array<ArrayBuffer> | null = null;

function jamOutput(): AudioNode {
  if (!jamGain) {
    jamGain = (player.context as AudioContext).createGain();
    jamGain.connect(player.gain);
    applyJamGain();
  }
  return jamGain;
}

// Auto (default): jamGain = song's running level × 2 × the user's trim
// (playback.jamLevel, 1 = matched), so a note sits over any module. Manual:
// jamGain = jamLevel/2 (a plain 0..1 fader). Clamped + ramped so it never clicks.
function applyJamGain() {
  if (!jamGain || !player) return;
  const target = playback.jamAutoLevel
    ? Math.min(1, Math.max(0.04, songLevel * 2 * playback.jamLevel))
    : Math.min(1, Math.max(0, playback.jamLevel / 2));
  jamGain.gain.setTargetAtTime(target, player.context.currentTime, 0.12);
}

function sampleSongLevel() {
  if (!songAnalyser || !songBuf) return;
  songAnalyser.getByteTimeDomainData(songBuf);
  let sum = 0;
  for (let i = 0; i < songBuf.length; i++) {
    const v = (songBuf[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / songBuf.length);
  songLevel += (rms - songLevel) * 0.06; // slow: tracks sections, not per-beat
  applyJamGain();
}

/** Set the jam level (0..2). In auto mode it's a trim on the song-matched level
 *  (1 = matched); in manual mode a plain fader. */
export function setJamLevel(v: number) {
  playback.jamLevel = Math.max(0, Math.min(2, v));
  applyJamGain();
}

/** Toggle auto-balancing the jam level to the song (vs a manual fader). */
export function setJamAuto(on: boolean) {
  playback.jamAutoLevel = on;
  applyJamGain();
}

/** Stop every sounding jam voice (e.g. when the selected sample changes). */
export function jamStopAll() {
  for (const v of voices.values())
    try {
      v.src.stop();
    } catch {
      /* already stopped */
    }
  voices.clear();
  lastVoice = null;
  playback.jamPos = -1;
}

/** Drop cached buffers + stop live voices (called on track change). */
function resetJam() {
  bufGen++;
  bufCache.clear();
  for (const v of voices.values())
    try {
      v.src.stop();
    } catch {
      /* already stopped */
    }
  voices.clear();
  lastVoice = null;
}

async function sampleBuffer(idx: number) {
  if (bufCache.has(idx)) return bufCache.get(idx) ?? null;
  const gen = bufGen;
  const data = await readSample(idx);
  let entry: { buffer: AudioBuffer; info: SampleInfo } | null = null;
  if (player && data && data.pcm.length > 0) {
    const rate = data.info.rate || 8363;
    const buffer = player.context.createBuffer(1, data.pcm.length, rate);
    buffer.copyToChannel(data.pcm, 0);
    entry = { buffer, info: data.info };
  }
  if (gen === bufGen) bufCache.set(idx, entry); // don't cache across a track change
  return entry;
}

// Update the waveform play cursor (playback.jamPos) from the most recent voice.
function tickCursor() {
  if (!lastVoice || !player) {
    playback.jamPos = -1;
    cursorRaf = 0;
    return;
  }
  const v = lastVoice;
  let f = v.startFrame + (player.context.currentTime - v.start) * v.speed * v.rate;
  if (v.loop && v.loopEnd > v.loopStart) {
    if (f >= v.loopEnd) f = v.loopStart + ((f - v.loopStart) % (v.loopEnd - v.loopStart));
    playback.jamPos = Math.floor(f);
  } else {
    playback.jamPos = f < v.length ? Math.floor(f) : -1;
  }
  cursorRaf = requestAnimationFrame(tickCursor);
}

/** Play sample `sampleIdx` (1-based) at `note` (60 = middle C), optionally from
 *  `offsetFrames` into the sample (for click-to-audition). Returns a voice id to
 *  stop on key-up, or -1. */
export async function jamNote(sampleIdx: number, note: number, offsetFrames = 0): Promise<number> {
  if (!player || !playback.canReadSamples) return -1;
  await wakeAudio(); // resume a possibly-suspended context inside the key gesture
  const sb = await sampleBuffer(sampleIdx);
  if (!sb) return -1;
  const src = player.context.createBufferSource();
  src.buffer = sb.buffer;
  const speed = Math.pow(2, (note - 60) / 12);
  src.playbackRate.value = speed;
  const loop = !playback.jamOneShot && !!(sb.info.flags & 1) && sb.info.loopEnd > sb.info.loopStart;
  if (loop) {
    src.loop = true;
    src.loopStart = sb.info.loopStart / sb.info.rate;
    src.loopEnd = sb.info.loopEnd / sb.info.rate;
  }
  src.connect(jamOutput());
  const id = ++voiceId;
  const voice: JamVoice = {
    src,
    start: player.context.currentTime,
    startFrame: offsetFrames,
    rate: sb.info.rate,
    speed,
    length: sb.info.length,
    loop,
    loopStart: sb.info.loopStart,
    loopEnd: sb.info.loopEnd,
  };
  src.onended = () => dropVoice(id, voice);
  voices.set(id, voice);
  lastVoice = voice;
  src.start(0, Math.max(0, offsetFrames) / sb.info.rate);
  if (!cursorRaf) cursorRaf = requestAnimationFrame(tickCursor);
  return id;
}

function dropVoice(id: number, voice: JamVoice) {
  voices.delete(id);
  if (lastVoice === voice) {
    const rest = [...voices.values()];
    lastVoice = rest.length ? rest[rest.length - 1] : null;
  }
}

/** Stop a jammed voice (from jamNote) on key-up. */
export function jamStop(id: number) {
  const v = voices.get(id);
  if (!v) return;
  try {
    v.src.stop();
  } catch {
    /* already stopped */
  }
  dropVoice(id, v);
}

// --- editor: edit buffer + Web Audio sequencer -------------------------------
// The editor is a SEPARATE engine (libopenmpt is read-only). Edits live in a
// copy-on-write buffer keyed by pattern; the sequencer plays that buffer's
// current pattern through the Web Audio sampler primitives (one voice per
// channel), so you hear edits independently of libopenmpt. Each channel has its
// own gain + analyser, giving true per-channel scopes for free.

// Edited cells per pattern (deep-copied from the read-only song on first edit).
// Reactive so the grid re-renders on edits; reset on track load.
let editBuffer = $state<Record<number, number[][][]>>({});

/** Structured cells for pattern `p` with edits applied (falls back to the
 *  read-only song cells; null if the build exposes no structured cells). */
export function patternCells(p: number): number[][][] | null {
  return editBuffer[p] ?? playback.song?.patterns?.[p]?.cells ?? null;
}

/** Get pattern `p`'s cells as a mutable copy-on-write buffer (creates it from the
 *  song on first call). Null if there are no structured cells. */
function ensureEditable(p: number): number[][][] | null {
  if (editBuffer[p]) return editBuffer[p];
  const src = playback.song?.patterns?.[p]?.cells;
  if (!src) return null;
  editBuffer[p] = src.map((row) => row.map((cell) => cell.slice()));
  return editBuffer[p];
}

function clearEdits() {
  editBuffer = {};
  playback.editing = false;
  seqStop();
}

/** Toggle edit mode. Leaving edit mode stops the editor sequencer. */
export function setEditing(on: boolean) {
  if (!playback.canReadCells) return;
  playback.editing = on;
  if (!on) seqStop();
}

// -- cell editing (note / hex-field entry) --
/** Editable cursor columns (index into a structured cell). */
export const FIELD = { note: 0, inst: 1, vol: 2, fx: 3, param: 4 } as const;
export const NUM_FIELDS = 5;
const EDIT_FIELDS = [CELL.note, CELL.inst, CELL.vol, CELL.fx, CELL.param]; // cursor field → cell index

// QWERTY → semitone offset from the base octave's C (two-octave tracker layout,
// same map as JamKeyboard). Bottom row 0..12, top row 12..24.
const NOTE_KEYS: Record<string, number> = {
  z: 0,
  s: 1,
  x: 2,
  d: 3,
  c: 4,
  v: 5,
  g: 6,
  b: 7,
  h: 8,
  n: 9,
  j: 10,
  m: 11,
  ",": 12,
  q: 12,
  "2": 13,
  w: 14,
  "3": 15,
  e: 16,
  r: 17,
  "5": 18,
  t: 19,
  "6": 20,
  y: 21,
  "7": 22,
  u: 23,
  i: 24,
};
const HEX: Record<string, number> = {
  "0": 0,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  a: 10,
  b: 11,
  c: 12,
  d: 13,
  e: 14,
  f: 15,
};

function hx(n: number, w: number): string {
  return n.toString(16).toUpperCase().padStart(w, "0");
}

/** Display text for one field of a structured cell (editor render). */
export function cellFieldText(cell: number[], field: number): string {
  switch (field) {
    case FIELD.note:
      return noteName(cell[CELL.note]);
    case FIELD.inst:
      return cell[CELL.inst] ? hx(cell[CELL.inst], 2) : "··";
    case FIELD.vol:
      return cell[CELL.volcmd] ? hx(cell[CELL.vol], 2) : "··";
    case FIELD.fx:
      return cell[CELL.fx] || cell[CELL.param] ? hx(cell[CELL.fx], 1) : "·";
    case FIELD.param:
      return cell[CELL.fx] || cell[CELL.param] ? hx(cell[CELL.param], 2) : "··";
    default:
      return "";
  }
}

function editCursorCell(): number[] | null {
  const cells = ensureEditable(playback.pattern);
  return cells?.[playback.cursorRow]?.[playback.cursorCh] ?? null;
}

function advanceRow() {
  const { rows } = patternDims();
  if (rows) playback.cursorRow = Math.min(rows - 1, playback.cursorRow + playback.editStep);
}

let auditionVoice = -1;
async function auditionNote(inst: number, note: number) {
  if (auditionVoice >= 0) jamStop(auditionVoice);
  const id = await jamNote(inst, noteToJam(note));
  auditionVoice = id;
  if (id >= 0) setTimeout(() => jamStop(id), 350); // short audition, even for looped samples
}

/** Move the cursor between fields, wrapping across channels. */
export function moveField(dir: number) {
  const { chans } = patternDims();
  if (!chans) return;
  let f = playback.cursorField + dir;
  let ch = playback.cursorCh;
  while (f < 0) {
    ch -= 1;
    f += NUM_FIELDS;
  }
  while (f >= NUM_FIELDS) {
    ch += 1;
    f -= NUM_FIELDS;
  }
  if (ch < 0) {
    ch = 0;
    f = 0;
  } else if (ch > chans - 1) {
    ch = chans - 1;
    f = NUM_FIELDS - 1;
  }
  playback.cursorCh = ch;
  playback.cursorField = f;
}

function enterNote(note: number) {
  const cell = editCursorCell();
  if (!cell) return;
  cell[CELL.note] = note;
  if (isRealNote(note)) {
    if (!cell[CELL.inst]) cell[CELL.inst] = playback.editInst || 1;
    else playback.editInst = cell[CELL.inst];
    void auditionNote(cell[CELL.inst], note);
  }
  advanceRow();
}

let lastHexPos = "";
function enterHex(digit: number) {
  const cell = editCursorCell();
  if (!cell) return;
  const idx = EDIT_FIELDS[playback.cursorField];
  const pos = `${playback.pattern}:${playback.cursorRow}:${playback.cursorCh}:${playback.cursorField}`;
  // Second consecutive digit on the same field shifts in a low nibble; a fresh
  // field starts over.
  cell[idx] = pos === lastHexPos ? ((cell[idx] << 4) | digit) & 0xff : digit;
  lastHexPos = pos;
  if (playback.cursorField === FIELD.vol) cell[CELL.volcmd] ||= 1; // mark a volume-column value present
  if (playback.cursorField === FIELD.inst) playback.editInst = cell[CELL.inst] || playback.editInst;
}

/** Clear the cursor cell (all fields) and advance by the edit step. */
export function clearCellAtCursor() {
  const cell = editCursorCell();
  if (!cell) return;
  for (let i = 0; i < cell.length; i++) cell[i] = 0;
  advanceRow();
}

export function setEditOctave(o: number) {
  playback.editOctave = Math.max(0, Math.min(9, o));
}
export function setEditStep(s: number) {
  playback.editStep = Math.max(0, Math.min(16, s));
}
export function setEditInst(i: number) {
  playback.editInst = Math.max(1, i);
}

/** Handle a keydown while a pattern grid is focused in edit mode. Returns true if
 *  it consumed the key (the grid then prevents default + stops propagation). */
export function handleEditKey(e: KeyboardEvent): boolean {
  if (!playback.editing) return false;
  const k = e.key;
  // Navigation (repeat allowed).
  if (k === "ArrowUp") return (moveCursor(-1, 0), true);
  if (k === "ArrowDown") return (moveCursor(1, 0), true);
  if (k === "ArrowLeft") return (moveField(-1), true);
  if (k === "ArrowRight") return (moveField(1), true);
  if (k === "Tab") return (moveField(e.shiftKey ? -1 : 1), true);
  if (e.repeat) return true; // don't machine-gun entry on auto-repeat
  if (k === "Delete" || k === "Backspace") return (clearCellAtCursor(), true);
  if (playback.cursorField === FIELD.note) {
    if (k === "`") return (enterNote(NOTE_OFF), true); // note-off (===)
    const off = NOTE_KEYS[k.toLowerCase()];
    if (off !== undefined) {
      const n = playback.editOctave * 12 + off + 1;
      if (n >= 1 && n <= 120) enterNote(n);
      return true;
    }
    return false;
  }
  const d = HEX[k.toLowerCase()];
  if (d !== undefined) return (enterHex(d), true);
  return false;
}

// -- sequencer engine --
const SEQ_LOOKAHEAD = 0.1; // schedule this far ahead (s)
const SEQ_TICK = 25; // scheduler wakeups (ms)
export const SEQ_SCOPE_SIZE = 256;

let seqOut: GainNode | null = null;
let seqChanGain: GainNode[] = [];
let seqChanScope: AnalyserNode[] = [];
let seqChanVoice: (AudioBufferSourceNode | null)[] = [];
let seqChanInst: number[] = []; // running instrument per channel
let seqTimer: ReturnType<typeof setInterval> | 0 = 0;
let seqPausedSong = false; // did we worklet-pause libopenmpt for the sequencer?
let seqPattern = 0;
let seqNextRow = 0;
let seqNextTime = 0;

function seqRowDur(): number {
  // classic tracker timing: row seconds = 2.5 * speed / BPM
  return (2.5 * playback.seqSpeed) / Math.max(32, playback.seqBpm);
}

function seqSetup(nch: number) {
  const ctx = player.context as AudioContext;
  seqOut = ctx.createGain();
  // Mix headroom so the summed channels sit near libopenmpt's own output level
  // (which mixes with gain staging) instead of full-scale-per-channel — matches
  // playback loudness and prevents clipping as channel count grows. ~1/sqrt(N)
  // is the standard uncorrelated-sum headroom.
  seqOut.gain.value = Math.min(0.85, 1.4 / Math.sqrt(Math.max(1, nch)));
  seqOut.connect(player.gain);
  seqChanGain = [];
  seqChanScope = [];
  seqChanVoice = [];
  seqChanInst = [];
  for (let c = 0; c < nch; c++) {
    const g = ctx.createGain();
    const a = ctx.createAnalyser();
    a.fftSize = SEQ_SCOPE_SIZE;
    g.connect(a); // scope tap (observer)
    g.connect(seqOut); // audio path
    seqChanGain.push(g);
    seqChanScope.push(a);
    seqChanVoice.push(null);
    seqChanInst.push(0);
  }
}

function seqTeardown() {
  if (seqTimer) clearInterval(seqTimer);
  seqTimer = 0;
  for (const v of seqChanVoice)
    try {
      v?.stop();
    } catch {
      /* already stopped */
    }
  seqChanVoice = [];
  try {
    seqOut?.disconnect();
  } catch {
    /* not connected */
  }
  seqOut = null;
  seqChanGain = [];
  seqChanScope = [];
}

function stopSeqVoice(c: number, when: number) {
  const v = seqChanVoice[c];
  if (v) {
    try {
      v.stop(when);
    } catch {
      /* already stopped */
    }
    seqChanVoice[c] = null;
  }
}

function triggerSeqNote(c: number, inst: number, note: number, when: number) {
  const sb = bufCache.get(inst); // preloaded in seqPlay → sync cache hit
  if (!sb) return;
  stopSeqVoice(c, when);
  const src = player.context.createBufferSource();
  src.buffer = sb.buffer;
  src.playbackRate.value = Math.pow(2, (noteToJam(note) - 60) / 12);
  if (sb.info.flags & 1 && sb.info.loopEnd > sb.info.loopStart) {
    src.loop = true;
    src.loopStart = sb.info.loopStart / sb.info.rate;
    src.loopEnd = sb.info.loopEnd / sb.info.rate;
  }
  seqChanGain[c].gain.setValueAtTime(Math.min(1, (sb.info.volume || 256) / 256), when);
  src.connect(seqChanGain[c]);
  src.start(when);
  seqChanVoice[c] = src;
}

function scheduleSeqRow(cells: number[][][], row: number, when: number) {
  const nch = seqChanGain.length;
  for (let c = 0; c < nch; c++) {
    const cell = cells[row]?.[c];
    if (!cell) continue;
    const note = cell[CELL.note];
    if (cell[CELL.inst]) seqChanInst[c] = cell[CELL.inst];
    if (note === NOTE_OFF || note === NOTE_CUT || note === NOTE_FADE) {
      stopSeqVoice(c, when);
    } else if (isRealNote(note) && seqChanInst[c]) {
      triggerSeqNote(c, seqChanInst[c], note, when);
    }
  }
}

function seqSchedule() {
  if (!player || !seqOut) return;
  const cells = patternCells(seqPattern);
  if (!cells || !cells.length) return;
  const now = player.context.currentTime;
  while (seqNextTime < now + SEQ_LOOKAHEAD) {
    const row = seqNextRow;
    scheduleSeqRow(cells, row, seqNextTime);
    // reflect the sounding row for the UI playhead (approx; display-only)
    const delayMs = Math.max(0, (seqNextTime - now) * 1000);
    setTimeout(() => {
      if (!playback.seqPlaying) return;
      playback.seqRow = row;
      playback.row = row; // libopenmpt is stopped → drive the grid playhead
    }, delayMs);
    seqNextRow = (seqNextRow + 1) % cells.length;
    seqNextTime += seqRowDur();
  }
}

/** Start the editor sequencer on the current pattern (loops). Pauses libopenmpt
 *  so you don't hear both. Preloads the pattern's instruments first. */
export async function seqPlay() {
  if (!player || !playback.canReadCells) return;
  const nch = playback.song?.channels?.length ?? 0;
  const cells = patternCells(playback.pattern);
  if (!nch || !cells) return;
  await wakeAudio();
  seqStop();
  // Preload every instrument the pattern references (async worker reads) so row
  // scheduling is synchronous. Read BEFORE silencing libopenmpt and WITHOUT
  // stopping it — player.stop() destroys the worker's module, which would make
  // smp_read (and note auditioning) return nothing.
  const insts = new Set<number>();
  for (const row of cells) for (const cell of row) if (cell[CELL.inst]) insts.add(cell[CELL.inst]);
  await Promise.all([...insts].map((i) => sampleBuffer(i)));
  // Silence libopenmpt's own output (worklet-level pause) so we don't hear both;
  // the module stays loaded and the sequencer's node path is independent of the
  // worklet, so this doesn't touch our audio. Restored on seqStop.
  seqPausedSong = false;
  if (playback.playing && !playback.paused) {
    player.pause();
    seqPausedSong = true;
  }
  seqSetup(nch);
  seqPattern = playback.pattern;
  seqNextRow = 0;
  seqNextTime = player.context.currentTime + 0.06;
  playback.seqRow = 0;
  playback.seqPlaying = true;
  seqTimer = setInterval(seqSchedule, SEQ_TICK);
}

/** Stop the editor sequencer. */
export function seqStop() {
  playback.seqPlaying = false;
  seqTeardown();
  if (seqPausedSong && player) {
    player.unpause(); // resume libopenmpt's own output we paused for the sequencer
    seqPausedSong = false;
  }
}

export function seqToggle() {
  if (playback.seqPlaying) seqStop();
  else void seqPlay();
}

/** Fill `buf` (length SEQ_SCOPE_SIZE) with channel `ch`'s current sequencer
 *  waveform (0–255, 128 = silence). False until the sequencer is running. */
export function readSeqScope(ch: number, buf: Uint8Array<ArrayBuffer>): boolean {
  const a = seqChanScope[ch];
  if (!a) return false;
  a.getByteTimeDomainData(buf);
  return true;
}

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
      seqTeardown();
      player?.stop();
      player?.context?.close?.();
    } catch {
      /* nothing to tear down */
    }
  });
}
