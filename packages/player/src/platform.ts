// OS / platform integration: Media Session (now-playing metadata + lock-screen
// transport buttons), a screen wake lock while playing, finite position state so
// the media-element route reads as a normal track, and a foreground-resume
// handler. iOS keeps Web Audio alive only in the foreground, so this is a
// foreground convenience layer, distinct from the transport store itself.
//
// A leaf module: reads the store + host + background wakeAudio, and takes the
// transport controls the OS buttons drive as a parameter to wirePlatformIntegration
// (so it never imports the orchestration file — no cycle).

import { wakeAudio } from "./background";
import { host } from "./host";
import { playback } from "./state.svelte";

/** Transport actions the OS media-session buttons trigger. */
export type TransportControls = {
  toggle: () => void;
  togglePause: () => void;
  next: () => void;
  prev: () => void;
};

/** Reflect current track + transport state to the OS, and hold a wake lock
 *  while actually playing. */
export function syncNowPlaying() {
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

/** Push the OS scrubber, throttled to ~1s of playback — called from onProgress. */
export function syncPosition() {
  if (Math.abs(playback.position - lastPosSync) >= 1) updatePositionState();
}

let wakeLock: WakeLockSentinel | null = null;
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
 *  foreground, re-arm the wake lock, and route OS transport buttons to the given
 *  transport controls. */
let platformWired = false;
export function wirePlatformIntegration(controls: TransportControls) {
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
    ms.setActionHandler("play", () => controls.toggle());
    ms.setActionHandler("pause", () => {
      if (playback.playing && !playback.paused) controls.togglePause();
    });
    ms.setActionHandler("previoustrack", () => controls.prev());
    ms.setActionHandler("nexttrack", () => controls.next());
  }
}
