// The pattern editor + its own Web Audio sequencer. libopenmpt is read-only, so
// edits live in a copy-on-write buffer keyed by pattern, and the sequencer plays
// that buffer through the sampler primitives (one voice per channel, each with a
// gain + analyser for per-channel scopes) — independent of libopenmpt so you hear
// edits. Tracker-only (party doesn't surface it), gated on canReadCells.
//
// A leaf module: it holds its own engine ref (attached by ensurePlayer via
// attachEditor) and imports the store, background wakeAudio, the jam sampler, and
// the pure note/cell helpers — but never the orchestration file, so no cycle.

import { wakeAudio } from "./background";
import type { Engine } from "./engine";
import { cachedBuffer, jamNote, jamStop, sampleBuffer } from "./jam";
import {
  CELL,
  EDIT_FIELDS,
  FIELD,
  HEX,
  isRealNote,
  NOTE_CUT,
  NOTE_FADE,
  NOTE_KEYS,
  NOTE_OFF,
  noteToJam,
  NUM_FIELDS,
} from "./notes";
import { playback } from "./state.svelte";

let engine: Engine | null = null;

/** Wire to the live engine. Called from ensurePlayer once the graph exists. */
export function attachEditor(e: Engine) {
  engine = e;
}

// --- pattern cursor ---------------------------------------------------------
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
  if (!engine || !playback.current) return;
  engine.setOrderRow(playback.order, playback.cursorRow);
  playback.row = playback.cursorRow;
}

// --- edit buffer ------------------------------------------------------------
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

/** Drop all edits + leave edit mode (called on track change). */
export function clearEdits() {
  editBuffer = {};
  playback.editing = false;
  seqStop();
}

let editResumeSong = false;
/** Toggle edit mode. Edit mode is modal: it SUPPRESSES normal (libopenmpt) song
 *  playback — entering pauses the song (worklet-level, so the module stays loaded
 *  and the sequencer's audio path is unaffected), the transport drives the
 *  pattern loop instead, and leaving resumes the song if it was playing. */
export function setEditing(on: boolean) {
  if (!playback.canReadCells || on === playback.editing) return;
  playback.editing = on;
  if (on) {
    editResumeSong = playback.playing && !playback.paused;
    if (editResumeSong && engine) engine.pause();
  } else {
    seqStop();
    if (editResumeSong && engine) engine.unpause();
    editResumeSong = false;
  }
}

// -- cell editing (note / hex-field entry) --
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
export function setFollowPlay(on: boolean) {
  playback.followPlay = on;
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
  if (k === "Enter") return true; // consume (no view-mode seek while editing)
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
let seqPattern = 0;
let seqNextRow = 0;
let seqNextTime = 0;

function seqRowDur(): number {
  // classic tracker timing: row seconds = 2.5 * speed / BPM
  return (2.5 * playback.seqSpeed) / Math.max(32, playback.seqBpm);
}

function seqSetup(eng: Engine, nch: number) {
  const ctx = eng.context;
  seqOut = ctx.createGain();
  // Mix headroom so the summed channels sit near libopenmpt's own output level
  // (which mixes with gain staging) instead of full-scale-per-channel — matches
  // playback loudness and prevents clipping as channel count grows. ~1/sqrt(N)
  // is the standard uncorrelated-sum headroom.
  seqOut.gain.value = Math.min(0.85, 1.4 / Math.sqrt(Math.max(1, nch)));
  seqOut.connect(eng.gain);
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
  if (!engine) return;
  const sb = cachedBuffer(inst); // preloaded in seqPlay → sync cache hit
  if (!sb) return;
  stopSeqVoice(c, when);
  const src = engine.context.createBufferSource();
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
    if (cell[CELL.inst]) seqChanInst[c] = cell[CELL.inst]; // track running inst even when muted
    if (playback.channelMutes[c]) {
      stopSeqVoice(c, when); // respect mute/solo — same as libopenmpt playback
      continue;
    }
    if (note === NOTE_OFF || note === NOTE_CUT || note === NOTE_FADE) {
      stopSeqVoice(c, when);
    } else if (isRealNote(note) && seqChanInst[c]) {
      triggerSeqNote(c, seqChanInst[c], note, when);
    }
  }
}

function seqSchedule() {
  if (!engine || !seqOut) return;
  // Follow the pattern selected in the UI: if it changed, switch the loop to it
  // (reset to row 0 and cut hanging voices) so selecting a pattern plays it.
  if (playback.pattern !== seqPattern) {
    seqPattern = playback.pattern;
    seqNextRow = 0;
    seqNextTime = engine.context.currentTime + 0.02;
    for (let c = 0; c < seqChanGain.length; c++) stopSeqVoice(c, seqNextTime);
    seqChanInst = seqChanInst.map(() => 0);
  }
  const cells = patternCells(seqPattern);
  if (!cells || !cells.length) return;
  const now = engine.context.currentTime;
  while (seqNextTime < now + SEQ_LOOKAHEAD) {
    const row = seqNextRow;
    scheduleSeqRow(cells, row, seqNextTime);
    // reflect the sounding row for the UI playhead (approx; display-only)
    const delayMs = Math.max(0, (seqNextTime - now) * 1000);
    setTimeout(() => {
      if (!playback.seqPlaying) return;
      playback.seqRow = row;
      playback.row = row; // libopenmpt is stopped → drive the grid playhead
      if (playback.followPlay) playback.cursorRow = row; // ride the playhead (live-record)
    }, delayMs);
    seqNextRow = (seqNextRow + 1) % cells.length;
    seqNextTime += seqRowDur();
  }
}

/** Start the editor sequencer on the current pattern (loops). Pauses libopenmpt
 *  so you don't hear both. Preloads the pattern's instruments first. */
export async function seqPlay() {
  const eng = engine;
  if (!eng || !playback.canReadCells) return;
  const nch = playback.song?.channels?.length ?? 0;
  const cells = patternCells(playback.pattern);
  if (!nch || !cells) return;
  await wakeAudio();
  seqStop();
  // Preload ALL samples (async worker reads) so row scheduling is synchronous and
  // switching the selected pattern mid-loop plays instantly. Read WITHOUT stopping
  // libopenmpt — engine.stop() destroys the worker's module, which would make
  // smp_read (and auditioning) return nothing. The song is already paused by
  // setEditing.
  const nsmp = playback.samples.length;
  await Promise.all(Array.from({ length: nsmp }, (_, i) => sampleBuffer(i + 1)));
  seqSetup(eng, nch);
  seqPattern = playback.pattern;
  seqNextRow = 0;
  seqNextTime = eng.context.currentTime + 0.06;
  playback.seqRow = 0;
  playback.seqPlaying = true;
  seqTimer = setInterval(seqSchedule, SEQ_TICK);
}

/** Stop the editor sequencer. Does NOT resume the song — edit mode keeps it
 *  suppressed; leaving edit mode (setEditing false) resumes it. */
export function seqStop() {
  playback.seqPlaying = false;
  seqTeardown();
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

// Dev-only: tear the sequencer's audio graph down on HMR so a hot reload doesn't
// leave orphaned voices/timer running.
if (import.meta.hot) {
  import.meta.hot.dispose(seqTeardown);
}
