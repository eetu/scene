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
export type Pattern = { name: string; rows: string[][] };
export type Song = {
  channels?: string[];
  instruments?: string[];
  samples?: string[];
  patterns?: Pattern[];
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
  beat: 0, // bumps once per musical beat (see noteRow) — a reactive on-beat tick
  vu: [] as number[],
  song: null as Song | null,
  samples: [] as string[],
  instruments: [] as string[],
  muted: false,
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
    player.gain.connect(dest);
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
      player.gain.disconnect(player.context.destination);
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
  if (!playback.playing) void playTrack(playback.current);
  else togglePause();
}

export function togglePause() {
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
      player?.stop();
      player?.context?.close?.();
    } catch {
      /* nothing to tear down */
    }
  });
}
