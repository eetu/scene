/// <reference lib="webworker" />
// SID decode worker — the second engine behind the shared audio pipeline.
//
// It speaks exactly the protocol `decoder.worker.js` does, because the worklet
// (`chiptune3.worklet.js`) is format-agnostic: it drains `{gen, frames, left,
// right, pos, order, pattern, row, vu}` chunks and relays the metadata back when
// each one starts playing. So SID reuses the whole hand-tuned pipe — the
// credit-based flow control, the jitter buffer, the underrun/drift telemetry —
// and only the thing producing PCM differs.
//
// Unlike the libopenmpt worker this is bundled TypeScript, not a vendored static
// asset: libsidplayfp-wasm is an npm dependency, so Vite has to resolve it. That
// is why the wrapper takes a `workerFactory` rather than a URL.
import { SidAudioEngine } from "libsidplayfp-wasm";

// Frames per chunk (~21ms @48k), matching the module decoder so the worklet's
// queue maths and the reported position granularity are identical.
const CHUNK = 1024;
// Chunks kept in flight — the same ~1.5s jitter buffer, sized in the module
// decoder against measured background-throttling stalls. See decoder.worker.js.
const TARGET = 72;

/** Registers per SID chip, and the per-voice stride within them. */
const VOICE_STRIDE = 7;
const VOICES_PER_CHIP = 3;
const CHIP_REGS = 32;

/** Cycles in one PAL raster frame (312 lines × 63 cycles) — the interval the
 *  6502 play routine runs on, and therefore one row of the trace grid. The rest
 *  of this engine already assumes PAL (see the render call and `PAL_CLOCK` in
 *  registers.ts); NTSC tunes play at the PAL rate here as they always have. */
const FRAME_CYCLES = 19656;
/** PAL dot clock, Hz. Mirrors `PAL_CLOCK` in registers.ts — duplicated rather
 *  than imported because a worker's module graph is its own. */
const PAL_CLOCK = 985248;

let engine: SidAudioEngine | null = null;
let pcmPort: MessagePort | null = null;
let sampleRate = 48000;
let gen = 0;
let inflight = 0;
let playing = false;
let eof = false;
let subsong = 0;
let voices = VOICES_PER_CHIP;
/** Raw SID bytes of the loaded tune, kept so a subsong change can reload. */
let loaded: Uint8Array | null = null;
let romBytes: [Uint8Array, Uint8Array, Uint8Array] | null = null;
/** Voices the UI has muted, applied again after every reload. */
const muted = new Set<number>();

let renderMs = 0;
let renderedFrames = 0;
function reportLoad() {
  if (renderedFrames < sampleRate * 5) return;
  const audioMs = (renderedFrames / sampleRate) * 1000;
  self.postMessage({
    cmd: "renderload",
    percent: Math.round((renderMs / audioMs) * 1000) / 10,
    perChunkMs: Math.round((renderMs / (renderedFrames / CHUNK)) * 100) / 100,
  });
  renderMs = 0;
  renderedFrames = 0;
}

/** Fetch the three C64 ROMs. They are operator-supplied and copyrighted, so the
 *  app serves them from a configured path rather than bundling them; without
 *  them a BASIC-driven RSID renders as near-silence. Failing is not fatal —
 *  libsidplayfp falls back to built-in images and most tunes still play. */
async function loadRoms(base: string): Promise<void> {
  if (!base) return;
  try {
    const names = ["kernal", "basic", "chargen"] as const;
    const bufs = await Promise.all(
      names.map((n) => fetch(`${base}/${n}`).then((r) => (r.ok ? r.arrayBuffer() : null))),
    );
    if (bufs.some((b) => b === null)) return;
    romBytes = bufs.map((b) => new Uint8Array(b!)) as [Uint8Array, Uint8Array, Uint8Array];
  } catch {
    /* offline / not configured — built-in images it is */
  }
}

/** Every installed chip's 32 registers, concatenated (chip 0 first).
 *
 *  This is the whole voice model: per voice, `$00-$01` frequency, `$02-$03`
 *  pulse width, `$04` control (waveform select + gate/sync/ring), `$05-$06`
 *  attack/decay + sustain/release; then `$15-$18` filter cutoff, resonance,
 *  routing and master volume. libsidplayfp exposes it directly. */
function readRegisters(): number[] {
  if (!engine) return [];
  const out: number[] = [];
  for (let c = 0; c < engine.getInstalledSids(); c++) {
    const r = engine.getSidStatus(c);
    if (r) out.push(...r);
  }
  return out;
}

/** Per-voice output level for the VU, derived from the live SID registers.
 *
 *  The chip exposes no envelope counter to read, so this is the gate bit scaled
 *  by the voice's sustain level — which tracks "this voice is sounding, and how
 *  hard" closely enough for a meter, and costs one register read per frame.
 *  It is deliberately not presented as a true amplitude. */
function voiceLevels(): number[] {
  if (!engine) return [];
  const out: number[] = [];
  const chips = engine.getInstalledSids();
  for (let c = 0; c < chips; c++) {
    const r = engine.getSidStatus(c);
    if (!r) continue;
    for (let v = 0; v < VOICES_PER_CHIP; v++) {
      const base = v * VOICE_STRIDE;
      const gate = r[base + 4] & 1;
      const sustain = (r[base + 6] >> 4) / 15;
      out.push(muted.has(c * VOICES_PER_CHIP + v) ? 0 : gate * sustain);
    }
  }
  return out;
}

// ---------- the trace grid ----------
//
// A SID has no pattern data — its "score" is 6502 code writing chip registers on
// a raster interrupt. But libsidplayfp can report every register write with a
// cycle stamp, so the score can be *reconstructed*: replay the writes into a
// shadow register file and snapshot it at each frame boundary. One snapshot per
// frame is one row, which is exactly what siddump produces and what the grid
// draws.
//
// Costs one small copy per chunk. The alternative — polling getSidStatus() once
// per audio chunk, as the voice monitor does — samples at ~43 Hz against a 50 Hz
// writer and cannot produce stable rows at all.

/** Shadow register file: what the chip holds right now, built from the writes.
 *  Sized on load, `chips × 32`. */
let shadow = new Uint8Array(0);
/** Absolute cycle at which the next frame boundary falls. `-1` until the first
 *  trace arrives, since libsidplayfp's cycle origin isn't ours to assume. */
let nextFrameCycle = -1;
/** How far playback has advanced, in the same cycle domain as the write stamps.
 *  Driven by cycles *rendered*, not by writes — see `captureFrames`. */
let frameCursor = 0;
/** Rows captured during the current chunk, flattened `frames × chips × 32`. */
let rowBuf: number[] = [];
/** Playback time of each captured row, seconds, parallel to `rowBuf`.
 *
 *  This is what lets the grid show the future. The rows are computed up to ~1.5s
 *  before they're audible (the worklet's jitter buffer), so they can't be drawn
 *  against "now" unless each one says when its "now" is. */
let rowTimes: number[] = [];
/** Set when a frame carries far more writes than a note-driven tune produces —
 *  a digi tune bit-banging $D418 for sampled drums. One row per frame genuinely
 *  cannot represent that, so the grid says so rather than implying its rows are
 *  the whole story.
 *
 *  Inferred from the writes we receive rather than read from the decoder:
 *  `SidAudioEngine` doesn't expose `getDroppedSidWriteTraceCount()` (that lives
 *  on the SidPlayerContext it keeps private), so an actual buffer overflow is
 *  invisible from here. This catches the case that causes one. */
let traceDense = false;
/** Writes seen in the frame being assembled. */
let frameWrites = 0;
/** Above this many writes in one frame, the tune isn't playing notes — it's
 *  streaming samples. A busy note-driven tune sits well under 100. */
const DENSE_WRITES = 400;

function resetTrace() {
  shadow = new Uint8Array((engine?.getInstalledSids() ?? 1) * CHIP_REGS);
  nextFrameCycle = -1;
  frameCursor = 0;
  rowBuf = [];
  rowTimes = [];
  traceDense = false;
  frameWrites = 0;
}

/** Drain the write trace and turn the cycles just rendered into whole frames of
 *  register state.
 *
 *  **The frame clock advances with rendered time, not with writes.** Driving it
 *  from write arrivals seems natural and is wrong: a tune that goes quiet — or
 *  one that sets up a drone and stops writing, like the test fixture, which
 *  writes seven times total — never crosses another boundary, so the grid
 *  emitted no rows at all and simply froze. Frames happen whether or not the
 *  6502 has anything to say; silence is part of the score.
 *
 *  Writes are still placed by their own cycle stamps, so a write lands in the
 *  frame it actually belongs to rather than being lumped at a chunk boundary. */
function captureFrames(cyclesRendered: number, posAtChunkStart: number): void {
  if (!engine) return;
  const writes = engine.getAndClearSidWriteTraces() ?? [];

  // Anchor to the emulator's cycle origin the first time it tells us one. Before
  // any write has happened there is no state worth recording anyway.
  if (nextFrameCycle < 0) {
    if (!writes.length) return;
    frameCursor = writes[0].cyclePhi1;
    nextFrameCycle = frameCursor + FRAME_CYCLES;
  }
  // Where this chunk starts, in the cycle domain. Row times are derived as an
  // offset from it, so the emulator's arbitrary cycle origin (which includes the
  // tune's init, ~0.34s on the fixture) cancels out and never has to line up
  // with the playback clock.
  const chunkStartCycle = frameCursor;
  frameCursor += cyclesRendered;

  const apply = (w: { sidNumber: number; address: number; value: number }) => {
    frameWrites++;
    // Registers mirror every 32 bytes across the chip's address window.
    const at = w.sidNumber * CHIP_REGS + (w.address & 0x1f);
    if (at < shadow.length) shadow[at] = w.value;
  };

  let i = 0;
  while (nextFrameCycle <= frameCursor) {
    for (; i < writes.length && writes[i].cyclePhi1 < nextFrameCycle; i++) apply(writes[i]);
    if (frameWrites > DENSE_WRITES) traceDense = true;
    frameWrites = 0;
    emitRow(posAtChunkStart + (nextFrameCycle - chunkStartCycle) / PAL_CLOCK);
    nextFrameCycle += FRAME_CYCLES;
    // A seek or a long stall would otherwise emit thousands of identical rows
    // in one go and block the worker; cap the catch-up and resync.
    if (rowBuf.length > 240 * shadow.length) {
      nextFrameCycle = frameCursor + FRAME_CYCLES;
      break;
    }
  }
  for (; i < writes.length; i++) apply(writes[i]);
}

function emitRow(at: number): void {
  for (let i = 0; i < shadow.length; i++) rowBuf.push(shadow[i]);
  rowTimes.push(at);
}

/** Render one chunk and post it to the worklet, tagged with the state at its
 *  start so the worklet can report progress synced to playback. */
function renderAndSend(): boolean {
  if (!engine || !pcmPort) return false;
  const pos = engine.getTimeMs() / 1000;
  const vu = voiceLevels();
  // The 32 registers of each installed chip, flattened. This *is* the voice
  // state — frequency, pulse width, waveform select, gate and ADSR per voice,
  // plus filter routing and master volume — so the monitor needs no other
  // source. Cheap: one small copy per ~21ms chunk.
  const regs = readRegisters();

  const t0 = performance.now();
  // Cycles per chunk at the PAL dot clock; libsidplayfp clamps internally, so
  // asking for a chunk's worth is a request, not a guarantee.
  const cyclesRendered = Math.round((CHUNK / sampleRate) * PAL_CLOCK);
  const pcm = engine.renderCycles(cyclesRendered);
  renderMs += performance.now() - t0;

  if (!pcm || pcm.length === 0) {
    eof = true;
    pcmPort.postMessage({ gen, eof: true });
    return false;
  }

  // libsidplayfp hands back interleaved (or mono) int16; the worklet wants two
  // float channels. A mono tune feeds both sides.
  const stereo = engine.isStereo();
  const frames = stereo ? pcm.length >> 1 : pcm.length;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = pcm[stereo ? i * 2 : i] / 32768;
    right[i] = pcm[stereo ? i * 2 + 1 : i] / 32768;
  }
  renderedFrames += frames;
  reportLoad();

  // Turn this render's register writes into whole frames of chip state — the
  // rows of the trace grid. Done after rendering, since that's when the writes
  // happened.
  //
  // Sent STRAIGHT to the main thread rather than riding the PCM through the
  // worklet. The worklet relays a chunk's metadata when that chunk starts
  // *playing*, which is what keeps the position and VU in sync with what you
  // hear — but it also means the rows would arrive only once they were already
  // audible. Rendering runs ~1.5s ahead (TARGET chunks in flight), so posting
  // them now hands the grid that much future, and each row carries the playback
  // time it belongs to so the view can still place it exactly.
  captureFrames(cyclesRendered, pos);
  if (rowBuf.length) {
    const rows = new Uint8Array(rowBuf);
    const times = new Float64Array(rowTimes);
    rowBuf = [];
    rowTimes = [];
    self.postMessage({ cmd: "rows", gen, rows, times, stride: shadow.length, dense: traceDense }, [
      rows.buffer,
      times.buffer,
    ]);
  }

  // order/pattern/row have no analogue in a SID — it is 6502 code, not a grid.
  // They stay 0 and the player gates its pattern UI on `hasPatterns`.
  pcmPort.postMessage(
    {
      gen,
      frames,
      left,
      right,
      pos,
      order: 0,
      pattern: 0,
      row: 0,
      vu,
      regs,
    },
    [left.buffer, right.buffer],
  );
  inflight++;
  return true;
}

function pump(): void {
  if (!pcmPort) return;
  while (playing && !eof && inflight < TARGET) {
    if (!renderAndSend()) break;
  }
}

function applyMutes(): void {
  if (!engine) return;
  const chips = engine.getInstalledSids();
  for (let c = 0; c < chips; c++) {
    for (let v = 0; v < VOICES_PER_CHIP; v++) {
      engine.mute(c, v, muted.has(c * VOICES_PER_CHIP + v));
    }
  }
}

/** Metadata in the shape the store's `applyMeta` expects. A SID has no pattern
 *  data, so `song` carries only the voice names the mute/solo header renders. */
function metaFor(): Record<string, unknown> {
  const info = engine?.getTuneInfo();
  const names = Array.from({ length: voices }, (_, i) => `Voice ${i + 1}`);
  // The PSID header's three 32-byte fields come through as `infoStrings`, in
  // spec order: name, author, released. There are no `title`/`author`/
  // `formatString` properties — reading those returned undefined for every SID,
  // so the now-playing header was blank and the write-back to /api/meta stored
  // nothing. (Unnoticed because this file was outside every typecheck; see
  // tsconfig.worker.json.)
  const [name] = info?.infoStrings ?? [];
  return {
    title: name || undefined,
    type_long: info?.format || undefined,
    // Deliberately absent: a SID has no tracker, and the composer belongs in the
    // artist the index already holds. Putting composers in the tracker slot
    // would fill that facet with hundreds of names that aren't trackers.
    dur: 0, // SIDs carry no length; the host supplies the play window
    song: { channels: names },
  };
}

/** Open (or re-open) the loaded tune at `subsong`.
 *
 *  libsidplayfp *throws* on anything it can't recognise — "SIDTUNE ERROR: Could
 *  not determine file format" for, say, a sidplay v1 info file that only
 *  describes a tune rather than containing one. Caught here and turned into the
 *  engine's normal error signal, so the transport shows its error state instead
 *  of the failure escaping as an unhandled promise rejection. */
async function reload(): Promise<boolean> {
  if (!engine || !loaded) return false;
  try {
    await engine.loadSidBuffer(loaded, subsong);
  } catch (e) {
    playing = false;
    eof = true;
    self.postMessage({ cmd: "err", val: e instanceof Error ? e.message : String(e) });
    return false;
  }
  voices = engine.getInstalledSids() * VOICES_PER_CHIP;
  applyMutes();
  // Rebuild the shadow file: the new tune may install a different number of
  // chips, and its cycle clock starts over.
  resetTrace();
  return true;
}

async function boot(romBase: string): Promise<void> {
  await loadRoms(romBase);
  engine = new SidAudioEngine({ sampleRate, engine: "residfp" });
  if (romBytes) await engine.setSystemROMs(romBytes[0], romBytes[1], romBytes[2]);
  // Cycle-stamped register writes — the trace grid's only source. Left on for
  // the session: the records are small and drained every chunk, and turning it
  // on lazily when the tab opens would start the grid mid-tune with no history.
  engine.setSidWriteTraceEnabled(true);
  const rom = engine.getRomStatus();
  self.postMessage({
    cmd: "ready",
    // A SID has no samples, no pattern cells and no tracker channels — the
    // player hides those panes rather than showing empty ones. Voices are muted
    // through the same control the module engine uses for channels.
    caps: { canReadSamples: false, canMuteChannels: true, canReadCells: false, hasPatterns: false },
    rom,
  });
}

self.onmessage = (e: MessageEvent) => {
  const d = e.data;
  switch (d.cmd) {
    case "config":
      break;
    case "init":
      sampleRate = d.sampleRate || sampleRate;
      break;
    case "pcmport":
      sampleRate = d.sampleRate || sampleRate;
      pcmPort = d.port;
      pcmPort!.onmessage = (ev: MessageEvent) => {
        if (ev.data?.cmd === "ack" && ev.data.gen === gen) {
          inflight--;
          pump();
        }
      };
      void boot(d.config?.romBase ?? "");
      break;
    case "load":
      if (!engine) return self.postMessage({ cmd: "err", val: "notready" });
      gen = d.gen;
      eof = false;
      inflight = 0;
      // Carried on the load itself, so opening the tune and picking its subtune
      // can't race (see chiptune3.js `load`).
      subsong = d.subsong | 0;
      muted.clear();
      loaded = new Uint8Array(d.bytes);
      void reload().then((ok) => {
        // reload() has already reported the reason on failure.
        if (!ok) return;
        playing = true;
        self.postMessage({ cmd: "meta", meta: metaFor() });
        pump();
      });
      break;
    case "stop":
      playing = false;
      eof = true;
      inflight = 0;
      break;
    case "setPos":
      if (!engine) return;
      gen = d.gen ?? gen;
      inflight = 0;
      eof = false;
      // The buffered frames are for the old position and their times are now
      // wrong; the cycle clock restarts with the seek.
      resetTrace();
      void engine.seekSeconds(d.val).then(() => pump());
      break;
    case "setOrderRow":
      break; // no pattern grid to seek within
    case "repeatCount":
      break; // a SID loops by construction; the host's window ends it
    case "selectSubsong":
      subsong = d.val | 0;
      gen = d.gen ?? gen;
      inflight = 0;
      eof = false;
      void reload().then((ok) => {
        if (!ok) return;
        self.postMessage({ cmd: "meta", meta: metaFor() });
        pump();
      });
      break;
    case "muteChannel":
      if (d.val) muted.add(d.ch);
      else muted.delete(d.ch);
      applyMutes();
      break;
    // A SID's metadata is parsed server-side from its header, so the browser
    // never needs these; answer so callers don't hang waiting.
    case "parse":
      self.postMessage({ cmd: "parsed", id: d.id, meta: null });
      break;
    case "decodeSong":
      self.postMessage({ cmd: "decoded", id: d.id, meta: null });
      break;
    default:
      break;
  }
};
