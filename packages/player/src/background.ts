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

/** Pause the routed <audio> element when the transport pauses. Once output is
 *  moved to it, that element is the only sink — the worklet going silent doesn't
 *  pause it, so its own `paused` state stays false and the OS transport keeps
 *  reading it as playing; pausing it keeps that state coherent with ours.
 *  (Keeping it *playing* silence to hold the context alive on iOS was tried and
 *  reverted: iOS then auto-derives the media-session state as "playing" and
 *  overrides our "paused", flipping the lock-screen icon and breaking resume.) */
export function pauseMediaElement() {
  mediaEl?.pause();
}

/** Drop the media-element route so a freshly-recreated engine rebuilds it from
 *  scratch (used when the AudioContext is torn down + replaced — see the
 *  recreate-on-stall path). Removes the stale <audio> and clears the route flags
 *  so setupMediaElementRoute()/routeAudioToElement() run again on the new graph. */
export function resetBackgroundRoute() {
  try {
    mediaEl?.pause();
    mediaEl?.remove();
  } catch {
    /* already gone */
  }
  mediaEl = null;
  streamDest = null;
  routedToElement = false;
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
 *  element is the worklet's ONLY sink (we disconnected context.destination). This
 *  resumes the context and re-plays the element; play() on an already-playing
 *  element resolves immediately, so it's safe to call on every gesture.
 *  NOTE: a context iOS left dead behind a state="running" lie can't be revived
 *  here (resume() is a no-op) — that's handled by a full engine recreate on the
 *  next play tap (see player.svelte's recreateEngine). */
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
