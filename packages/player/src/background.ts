// Background-playback audio routing + context-resume. iOS Safari (and
// backgrounded desktop Safari) suspend a bare AudioContext when the tab is
// hidden or the screen locks, which freezes the worklet → silence. Audio routed
// through an <audio> *media element*, however, keeps playing in the background.
// So we tap the graph with a MediaStreamDestination and play its stream through
// a hidden <audio> element; once that element is actually playing we move output
// entirely onto it (disconnecting context.destination so it isn't heard twice).
// Best-effort: if the element won't play we keep the normal destination.
//
// Engine-only (no store/transport deps): the engine is attached by ensurePlayer,
// so this stays a leaf module and `wakeAudio` can be shared (playTrack, the jam
// sampler, the foreground-resume handler all call it).

import type { Engine } from "./engine";

let engine: Engine | null = null;

/** Wire to the live engine. Called from ensurePlayer once the graph exists. */
export function attachBackground(e: Engine) {
  engine = e;
}

let mediaEl: HTMLAudioElement | null = null;
let streamDest: MediaStreamAudioDestinationNode | null = null;
let routedToElement = false;

export function setupMediaElementRoute() {
  if (!engine || streamDest || typeof Audio === "undefined") return;
  try {
    const dest: MediaStreamAudioDestinationNode = engine.context.createMediaStreamDestination();
    engine.monoNode.connect(dest); // after the mono downmix, like the speaker path
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

/** Keep the routed <audio> element PLAYING through a transport pause, so iOS
 *  doesn't suspend the AudioContext during the pause. Once output is moved to it
 *  that element is the context's only sink, and iOS kills an idle context after
 *  a few seconds — which left a paused track unrecoverable (unpause couldn't
 *  revive the dead context; only a reload did). The paused worklet fills zeros,
 *  so the element just streams silence, holding the context alive; the OS
 *  transport stays coherent via mediaSession.playbackState = "paused" (set by
 *  syncNowPlaying), not by pausing the element. Re-issues play() defensively in
 *  case iOS had already stalled it. */
export function holdMediaElement() {
  if (routedToElement && mediaEl) void mediaEl.play().catch(() => {});
}

/** Move audible output onto the media element so playback survives the page
 *  being backgrounded. Call inside the play gesture; no-op once routed or if
 *  the element can't play (we then stay on context.destination). */
export async function routeAudioToElement() {
  if (!mediaEl || routedToElement || !engine) return;
  try {
    await mediaEl.play();
    try {
      engine.monoNode.disconnect(engine.context.destination);
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
export async function wakeAudio() {
  if (!engine) return;
  try {
    if (engine.context.state !== "running") await engine.context.resume();
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
