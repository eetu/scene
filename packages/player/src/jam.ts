// Web Audio sampler: play a module's raw sample PCM directly (a plain
// AudioBufferSource pitched to the key, looped at the sample's loop points),
// independent of libopenmpt's song playback. Requires the custom build
// (playback.canReadSamples); no-ops otherwise.
//
// Self-contained: it holds its own engine + wakeAudio references, attached by
// the store's ensurePlayer (so there's no import cycle with the orchestration
// file), and reads/writes the shared `playback` store.

import type { Engine } from "./engine";
import type { SampleInfo } from "./player.svelte";
import { playback } from "./state.svelte";

let engine: Engine | null = null;
let wakeAudio: () => Promise<void> = async () => {};

/** Wire the sampler to the live engine + the store's context-resume helper.
 *  Called from ensurePlayer once the audio graph exists. */
export function attachJam(e: Engine, wake: () => Promise<void>) {
  engine = e;
  wakeAudio = wake;
}

// AudioBuffers built from sample PCM, cached per index; invalidated on track load
// (indices are reused for different samples across modules).
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const bufCache = new Map<number, { buffer: AudioBuffer; info: SampleInfo } | null>();
let bufGen = 0;

// Tiny note-on/off gain ramps to declick jammed samples: a raw PCM buffer whose
// first/last frame sits away from zero snaps audibly on an instant start/stop, so
// each voice gets its own gain node ramped up on start and down before stop.
const JAM_ATTACK = 0.004; // s — fade-in on note-on
const JAM_RELEASE = 0.006; // s — fade-out on note-off

type JamVoice = {
  src: AudioBufferSourceNode;
  env: GainNode; // per-voice declick envelope (src → env → jamOutput)
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

// Jammed/auditioned samples play at full-scale PCM, but libopenmpt's song mix
// sits below full-scale (mixing headroom), so a raw note would drown the song.
// Route all jam voices through one gain node (a plain user fader, playback.jamLevel
// 0..2 → gain jamLevel/2) so they sit ON TOP of the song. Connected to the
// engine's gain, so it respects volume/mute.
let jamGain: GainNode | null = null;

function jamOutput(eng: Engine): AudioNode {
  if (!jamGain) {
    jamGain = eng.context.createGain();
    jamGain.connect(eng.gain);
    applyJamGain();
  }
  return jamGain;
}

// Plain fader: gain = jamLevel/2 (1 = half-scale). Clamped + ramped so it never
// clicks.
function applyJamGain() {
  if (!jamGain || !engine) return;
  const target = Math.min(1, Math.max(0, playback.jamLevel / 2));
  jamGain.gain.setTargetAtTime(target, engine.context.currentTime, 0.12);
}

/** Set the jam/audition level (0..2 → gain 0..1). */
export function setJamLevel(v: number) {
  playback.jamLevel = Math.max(0, Math.min(2, v));
  applyJamGain();
}

// Fade a voice out over the release ramp, then stop its source — declicks the
// note-off (an instant stop mid-waveform snaps just like an instant start). The
// source keeps rendering until the scheduled stop even after we drop our
// bookkeeping, so the tail plays out.
function releaseVoice(v: JamVoice) {
  if (!engine) return;
  const t = engine.context.currentTime;
  try {
    v.env.gain.cancelScheduledValues(t);
    v.env.gain.setValueAtTime(v.env.gain.value, t);
    v.env.gain.linearRampToValueAtTime(0, t + JAM_RELEASE);
    v.src.stop(t + JAM_RELEASE);
  } catch {
    /* already stopped */
  }
}

/** Stop every sounding jam voice (e.g. when the selected sample changes). */
export function jamStopAll() {
  for (const v of voices.values()) releaseVoice(v);
  voices.clear();
  lastVoice = null;
  playback.jamPos = -1;
}

/** Drop cached buffers + stop live voices (called on track change). */
export function resetJam() {
  bufGen++;
  bufCache.clear();
  for (const v of voices.values()) releaseVoice(v);
  voices.clear();
  lastVoice = null;
}

/** Build (and cache) the AudioBuffer for sample `idx` (1-based). Also used by the
 *  editor sequencer to warm buffers. */
export async function sampleBuffer(idx: number) {
  if (bufCache.has(idx)) return bufCache.get(idx) ?? null;
  const eng = engine;
  const gen = bufGen;
  const data = eng && playback.canReadSamples ? await eng.readSample(idx) : null;
  let entry: { buffer: AudioBuffer; info: SampleInfo } | null = null;
  if (eng && data && data.pcm.length > 0) {
    const rate = data.info.rate || 8363;
    const buffer = eng.context.createBuffer(1, data.pcm.length, rate);
    buffer.getChannelData(0).set(data.pcm);
    entry = { buffer, info: data.info };
  }
  if (gen === bufGen) bufCache.set(idx, entry); // don't cache across a track change
  return entry;
}

/** Synchronous cache lookup for a preloaded sample buffer (the editor sequencer
 *  warms these via sampleBuffer() before playing, then reads them per row). */
export function cachedBuffer(idx: number): { buffer: AudioBuffer; info: SampleInfo } | null {
  return bufCache.get(idx) ?? null;
}

// Update the waveform play cursor (playback.jamPos) from the most recent voice.
function tickCursor() {
  if (!lastVoice || !engine) {
    playback.jamPos = -1;
    cursorRaf = 0;
    return;
  }
  const v = lastVoice;
  let f = v.startFrame + (engine.context.currentTime - v.start) * v.speed * v.rate;
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
  const eng = engine;
  if (!eng || !playback.canReadSamples) return -1;
  await wakeAudio(); // resume a possibly-suspended context inside the key gesture
  const sb = await sampleBuffer(sampleIdx);
  if (!sb) return -1;
  const src = eng.context.createBufferSource();
  src.buffer = sb.buffer;
  const speed = Math.pow(2, (note - 60) / 12);
  src.playbackRate.value = speed;
  const loop = !playback.jamOneShot && !!(sb.info.flags & 1) && sb.info.loopEnd > sb.info.loopStart;
  if (loop) {
    src.loop = true;
    src.loopStart = sb.info.loopStart / sb.info.rate;
    src.loopEnd = sb.info.loopEnd / sb.info.rate;
  }
  const now = eng.context.currentTime;
  // Per-voice envelope: ramp 0→1 over the attack so the note-on doesn't snap.
  const env = eng.context.createGain();
  env.gain.setValueAtTime(0, now);
  env.gain.linearRampToValueAtTime(1, now + JAM_ATTACK);
  src.connect(env).connect(jamOutput(eng));
  const id = ++voiceId;
  const voice: JamVoice = {
    src,
    env,
    start: now,
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
  src.start(now, Math.max(0, offsetFrames) / sb.info.rate);
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
  releaseVoice(v);
  dropVoice(id, v);
}
