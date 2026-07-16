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
 *  iOS suspends an idle/interrupted AudioContext after a while — and once output
 *  has been routed to the <audio> element (context.destination disconnected),
 *  that element is the worklet's ONLY sink. resume() + play() alone often can't
 *  revive a context/element iOS has torn down, which left a long pause dead until
 *  a reload. So: resume the context; and if it HAD been suspended (the iOS case)
 *  rebuild the media-element route from scratch inside this gesture — a fresh
 *  MediaStreamDestination + <audio>, since the old element/stream is usually
 *  dead. When the context was already running (a quick desktop unpause) just
 *  replay the element. Safe to call on every gesture. */
export async function wakeAudio() {
  if (!engine) return;
  const wasSuspended = engine.context.state !== "running";
  try {
    if (wasSuspended) await engine.context.resume();
  } catch {
    /* resume blocked/unsupported — recovers on the next gesture */
  }
  if (!routedToElement || !mediaEl) return;
  if (wasSuspended) {
    // iOS almost certainly tore down the element + its MediaStream alongside the
    // suspended context; a plain play() won't revive them, so rebuild the route.
    await rebuildMediaElementRoute();
  } else {
    try {
      await mediaEl.play();
    } catch {
      /* running but the element stalled — rebuild as a fallback */
      await rebuildMediaElementRoute();
    }
  }
}

/** Tear down and recreate the <audio> route (fresh MediaStreamDestination +
 *  element), reconnecting the graph and playing inside the current gesture. iOS
 *  can leave the routed element and its stream dead after a suspend, where
 *  play()/resume() won't bring them back — only a fresh route does. No-op when we
 *  never routed to an element (desktop stays on context.destination). */
async function rebuildMediaElementRoute() {
  if (!engine || !routedToElement) return;
  try {
    if (streamDest) {
      try {
        engine.monoNode.disconnect(streamDest);
      } catch {
        /* already disconnected */
      }
    }
    mediaEl?.pause();
    mediaEl?.remove();
    mediaEl = null;
    streamDest = null;
    routedToElement = false; // let setup + route run fresh
    setupMediaElementRoute(); // new streamDest + <audio>
    await routeAudioToElement(); // play() + re-disconnect context.destination
  } catch {
    /* rebuild failed — a later gesture retries */
  }
}
