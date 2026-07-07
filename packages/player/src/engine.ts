// Typed facade over the vendored (untyped, @ts-nocheck) chiptune3 wrapper — the
// single typed boundary the store + transport machine use to drive libopenmpt.
//
// The Worker + worklet stay vendored assets for now (they encode a working,
// hand-tuned off-thread PCM pipe); a follow-up task consolidates + TS-ifies them
// into this package. This facade gives us types over the wrapper today and the
// seam to absorb the rest later, without rewriting the engine.
import type { Meta, ParsedMeta, ProgressMsg, SampleData, SampleRaw } from "./player.svelte";
import { ChiptuneJsPlayer } from "./vendor/chiptune3.js";

/** Custom-build capabilities (party's stock build reports these false). */
export interface EngineCapabilities {
  canReadSamples: boolean;
  canMuteChannels: boolean;
  canReadCells: boolean;
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

  // Transport.
  load(url: string): void;
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

  // Decode / parse without starting audio.
  parse(id: number, ab: ArrayBuffer): void;
  /** Decode a module's full metadata + song (patterns/cells) on a throwaway
   *  module — no audio graph involved. For showing the pattern of a track
   *  restored on a cold reload before a gesture can start audio. */
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
}

/** Construct the engine. Call inside a user gesture — `new AudioContext()` runs
 *  synchronously in the constructor, so the browser allows audio. */
export function createEngine(cfg: EngineConfig = {}): Engine {
  return new ChiptuneJsPlayer(cfg) as unknown as Engine;
}
