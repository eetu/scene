// Typed facade over the vendored (untyped, @ts-nocheck) chiptune3 wrapper — the
// single typed boundary the store + transport machine use to drive libopenmpt.
//
// The Worker + worklet stay vendored assets for now (they encode a working,
// hand-tuned off-thread PCM pipe); a follow-up task consolidates + TS-ifies them
// into this package. This facade gives us types over the wrapper today and the
// seam to absorb the rest later, without rewriting the engine.
import type { Meta, ParsedMeta, ProgressMsg, SampleData, SampleRaw } from "./player.svelte";
import { ChiptuneJsPlayer } from "./vendor/chiptune3.js";

/** What the loaded engine can actually do. The module engine's three flags
 *  distinguish the custom libopenmpt build from party's stock one; `hasPatterns`
 *  distinguishes formats: a SID is 6502 code driving chip registers, with no
 *  pattern grid, sample list or order table anywhere in it, so the player hides
 *  those panes rather than rendering them empty. */
export interface EngineCapabilities {
  canReadSamples: boolean;
  canMuteChannels: boolean;
  canReadCells: boolean;
  /** False for SID. Modules default true. */
  hasPatterns: boolean;
}

/** Audio dropouts since the last report — the worklet ran out of queued PCM. */
export interface UnderrunMsg {
  events: number;
  lostMs: number;
  sinceMs: number;
}
/** How hard the decode worker is working, as a share of real time. */
export interface RenderLoadMsg {
  percent: number;
  perChunkMs: number;
}
/** Drift between the AudioContext clock and wall time — an iOS stall tell. */
export interface RateDriftMsg {
  percent: number;
  windowMs: number;
}
/** Silence between one track ending and the next producing audio. */
export interface LoadGapMsg {
  ms: number;
}
/** A batch of reconstructed SID raster frames, one per row of the trace grid.
 *
 *  Arrives ahead of playback — the decoder runs a jitter buffer in front of the
 *  worklet — which is exactly what lets the grid show incoming notes. `times`
 *  says when each row is due, so "ahead" never means "out of sync". */
export interface TraceRowsMsg {
  /** Load generation; a batch from before a seek or track change is stale. */
  gen: number;
  /** `rows.length / stride` frames of register state, flattened. */
  rows: Uint8Array;
  /** Playback time of each frame, seconds. Parallel to the rows. */
  times: Float64Array;
  /** Bytes per frame — `chips × 32`. */
  stride: number;
  /** The tune writes far more per frame than notes require (sampled playback),
   *  so one row per frame can't represent it. */
  dense: boolean;
}

/** The typed surface of the libopenmpt engine (main-thread wrapper). Audio flows
 *  gain → monoNode → sinks; the store reaches these nodes for scopes, the jam
 *  sampler, and the background-`<audio>` route. */
export interface Engine {
  readonly context: AudioContext;
  readonly gain: GainNode;
  readonly monoNode: GainNode;
  readonly capabilities: EngineCapabilities;

  // Lifecycle / playback events.
  onInitialized(fn: () => void): void;
  onProgress(fn: (d: ProgressMsg) => void): void;
  onMetadata(fn: (m: Meta) => void): void;
  onEnded(fn: () => void): void;
  onError(fn: (e: { type?: string }) => void): void;
  onParsed(fn: (d: { id: number; meta: ParsedMeta | null }) => void): void;

  // Render-health telemetry. Part of the contract, not optional extras: the
  // store drives the underrun counters and the iOS stalled-context recovery off
  // these, so an engine that doesn't report them looks permanently healthy while
  // the audio is glitching. (They were previously reached through an untyped
  // handle, which let exactly that go unnoticed.)
  onUnderrun(fn: (d: UnderrunMsg) => void): void;
  onRenderLoad(fn: (d: RenderLoadMsg) => void): void;
  onRateDrift(fn: (d: RateDriftMsg) => void): void;
  /** SID only: reconstructed raster frames, delivered ahead of playback. Never
   *  fires for libopenmpt, which has a pattern grid instead. */
  onTraceRows(fn: (d: TraceRowsMsg) => void): void;
  onLoadGap(fn: (d: LoadGapMsg) => void): void;

  // Transport.
  /** Fetch and play `url`, optionally starting at a given subtune (0-based).
   *  The subtune travels with the load so a multi-tune file can't race. */
  load(url: string, subsong?: number): void;
  play(buffer: ArrayBuffer): void;
  stop(): void;
  pause(): void;
  unpause(): void;
  togglePause(): void;
  setRepeatCount(n: number): void;
  setPos(sec: number): void;
  setOrderRow(order: number, row: number): void;
  setVol(v: number): void;
  setMono(on: boolean): void;
  muteChannel(ch: number, on: boolean): void;
  /** Select a subtune of the loaded file, 0-based.
   *
   *  Formats that hold several tunes per file (SID above all — one file can
   *  carry up to 256) need this after `load`/`play`; a single-song module
   *  simply never sees anything but 0. */
  selectSubsong(index: number): void;

  // Decode / parse without starting audio.
  parse(id: number, ab: ArrayBuffer): void;
  /** Decode a module's full metadata + song (patterns/cells) — no audio graph
   *  involved. For showing the pattern of a track restored on a cold reload
   *  before a gesture can start audio. When idle (nothing playing) the decoded
   *  module is kept resident, so the samples view can read waveforms/props
   *  without a gesture; it's replaced by the real module once playback starts. */
  decodeSong(ab: ArrayBuffer): Promise<Meta | null>;
  /** Resolves once the decoder Worker's WASM is ready — independent of the audio
   *  worklet (which the browser may keep suspended until a user gesture). */
  whenWorkerReady(): Promise<void>;

  // Sample extraction (custom build only).
  readSample(idx: number): Promise<SampleData | null>;
  readSampleRaw(idx: number): Promise<SampleRaw | null>;
}

export interface EngineConfig {
  repeatCount?: number;
  /** Where the app serves the C64 system ROMs (`<base>/kernal|basic|chargen`).
   *  SID only. They're copyrighted and operator-supplied, so they're fetched at
   *  runtime rather than bundled; without them a BASIC-driven RSID is silent. */
  romBase?: string;
}

/** Which decoder to build. Both share the audio graph, the worklet and the whole
 *  PCM/credit protocol — only the thing producing samples differs. */
export type EngineKind = "module" | "sid";

/**
 * Construct the engine. Call inside a user gesture — `new AudioContext()` runs
 * synchronously in the constructor, so the browser allows audio.
 *
 * `sid` swaps the decode worker for libsidplayfp (bundled, hence a factory
 * rather than a URL — see the `workerFactory` note in chiptune3.js) and points
 * it at the app's C64 ROM route. Everything downstream is unchanged: the
 * worklet drains tagged chunks without knowing or caring which decoder filled
 * them.
 */
export function createEngine(cfg: EngineConfig = {}, kind: EngineKind = "module"): Engine {
  if (kind === "sid") {
    return new ChiptuneJsPlayer({
      ...cfg,
      workerFactory: () =>
        new Worker(new URL("./sid/sid.worker.ts", import.meta.url), {
          type: "module",
        }),
      romBase: cfg.romBase,
    }) as unknown as Engine;
  }
  return new ChiptuneJsPlayer(cfg) as unknown as Engine;
}
