// The shared reactive playback store. Lives in its own module (a `.svelte.ts`,
// so runes work) as the core the store orchestration and the audio subsystems
// (jam sampler, editor sequencer, …) all read/write, without them having to
// import from the big player.svelte.ts orchestration file.

import type { Track } from "./host";
import type { Song } from "./player.svelte";

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
  song: null as Song | null,
  samples: [] as string[],
  instruments: [] as string[],
  muted: false,
  // Downmix output to mono (accessibility). Persisted; applied once the engine
  // is ready. Read at startup so the choice survives reloads.
  mono: typeof localStorage !== "undefined" && localStorage.getItem("player:mono") === "1",
  // Persisted so random mode survives a reload (the seeded order lives in
  // player.svelte.ts, keyed by player:shuffleSeed).
  shuffle: typeof localStorage !== "undefined" && localStorage.getItem("player:shuffle") === "1",
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
  // Jam/audition level (0..2 → gain 0..1): a plain fader over the song.
  jamLevel: 1,
  // Force one-shot playback (ignore the sample's loop) when auditioning/jamming.
  jamOneShot: false,
});
