// The shared reactive playback store. Lives in its own module (a `.svelte.ts`,
// so runes work) as the core the store orchestration and the audio subsystems
// (jam sampler, editor sequencer, …) all read/write, without them having to
// import from the big player.svelte.ts orchestration file.

import type { Track, TrackNote } from "./host";
import { readPref } from "./persist";
import type { Song } from "./player.svelte";

/**
 * What master volume a stored `player:volume` string means, 0..1.
 *
 * Its own function so it can be tested without a Storage, but the reason it exists is the
 * order of the two checks. An ABSENT key has to be caught before the coercion, because
 * `Number(null)` is 0 and 0 is a perfectly valid volume — so it walks straight past a
 * finite-and-in-range test and a first-ever load comes up silent, with the knob and the
 * slider both parked at zero. `Number("")` does the same thing.
 *
 * A zero that was genuinely stored still restores: this is about telling "no key" apart
 * from "turned down", not about refusing to be quiet.
 */
export function initialVolume(raw: string | null): number {
  if (raw === null || raw.trim() === "") return 1;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 1;
}

/** Raster frames of SID trace kept for the grid — about 20 seconds at 50 Hz.
 *
 *  Enough to scroll back over the phrase you just heard, which is what the view
 *  is for, without the store growing without bound over a 10-minute tune. */
export const TRACE_ROWS = 1024;

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
  // The queue reached its natural end (last track finished, no auto-advance) —
  // distinct from a user stop. Lets the app return to the list on finish. Cleared
  // the moment anything loads/cues/plays again.
  ended: false,
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
  followPlay: false, // edit mode: view + cursor ride the playhead (live-record)
  seqBpm: 125, // classic default (row secs = 2.5 * speed / bpm)
  seqSpeed: 6,
  beat: 0, // bumps once per musical beat (see noteRow) — a reactive on-beat tick
  vu: [] as number[],
  /** Live SID chip registers (32 per installed chip, concatenated), sampled at
   *  the start of the chunk currently playing. Empty for module playback. */
  sidRegs: [] as number[],
  /** The SID trace: one entry per PAL raster frame, oldest first, each a full
   *  register snapshot (`chips × 32`) reconstructed from that frame's writes.
   *
   *  This is the SID's answer to pattern rows. It reaches ~1.5s past the
   *  playhead, because the decoder renders that far ahead of the worklet — so
   *  the grid can show incoming notes, not just what's been played. Still not a
   *  score: nothing exists until it's been decoded, so there's no seeking within
   *  it and nothing to edit. Capped at [`TRACE_ROWS`]. */
  sidTrace: [] as Uint8Array[],
  /** When each `sidTrace` frame is due, seconds into the tune. Parallel array
   *  rather than a field on the row so the rows stay plain `Uint8Array` views
   *  over the decoder's buffer — they're the cache key for the row decoder. */
  sidTraceAt: [] as number[],
  /** This tune writes far more per frame than notes require — it's streaming
   *  samples through the volume register, not playing a score. One row per frame
   *  can't represent that, so the grid says so rather than implying its rows are
   *  the whole story. */
  sidTraceDense: false,
  song: null as Song | null,
  samples: [] as string[],
  instruments: [] as string[],
  /** Curator notes on the current track (STIL, for HVSC tunes). The text
   *  visualisers' substitute for the sample-slot prose a SID doesn't have.
   *  Fetched after load, so it arrives a beat late and the display just
   *  re-renders — never gating playback on it. */
  notes: [] as TrackNote[],
  muted: false,
  // Downmix output to mono (accessibility). Persisted; applied once the engine
  // is ready. Read at startup so the choice survives reloads.
  mono: readPref("player:mono") === "1",
  // Master output level, 0..1, applied to the engine's gain node. Persisted for the same
  // reason mono is: a level you have to re-set on every reload is worse than no control.
  // `muted` is orthogonal and rides on top — unmuting restores this, rather than 1.
  volume: initialVolume(readPref("player:volume")),
  // Persisted so random mode survives a reload (the seeded order lives in
  // player.svelte.ts, keyed by player:shuffleSeed).
  shuffle: readPref("player:shuffle") === "1",
  repeat: false, // loop the current module forever (libopenmpt repeat_count = -1)
  // Position in the play queue (the ordered list the current track was opened
  // from), so next/prev and auto-advance work. -1 = no queue.
  queueIndex: -1,
  queueLength: 0,
  error: null as string | null,
  // Audio dropped because the decode worker couldn't keep the worklet fed (see the
  // onUnderrun wiring). Counters, not a fault state: a dropout is already audible, and
  // these exist to say how bad and how often.
  underruns: 0,
  underrunMs: 0,
  // Silence spent loading the current track (parse + first render), not a fault.
  loadGapMs: 0,
  // Custom-build capability (this app's vendored WASM carries the sample-read
  // shim; party's stock build doesn't). Set once the engine reports ready. UI
  // (keyboard, waveform pane) gates on it so the shared package degrades.
  canReadSamples: false,
  /** Does the loaded format have a pattern grid at all? False for SID, whose
   *  music is 6502 code driving chip registers — there is no grid, sample list
   *  or order table to show, so those panes are replaced rather than emptied. */
  hasPatterns: true,
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
  // Jam/audition level (0..2 → gain 0..1): a plain fader over the song.
  jamLevel: 1,
  // Force one-shot playback (ignore the sample's loop) when auditioning/jamming.
  jamOneShot: false,
});
