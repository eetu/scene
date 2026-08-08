// `createEngine` casts the vendored (untyped, @ts-nocheck) ChiptuneJsPlayer to
// the `Engine` interface through `unknown`, so the compiler verifies nothing
// about that pairing. This test does: every method the interface promises must
// actually exist on the wrapper.
import { describe, expect, test } from "vitest";

import { ChiptuneJsPlayer } from "../vendor/chiptune3.js";

/** Every method `Engine` declares. Kept as a literal list on purpose: an
 *  interface is erased at runtime, so this is the only place the two can be
 *  compared, and adding to `Engine` without adding here would defeat it. */
const ENGINE_METHODS = [
  // lifecycle / events
  "onInitialized",
  "onProgress",
  "onMetadata",
  "onEnded",
  "onError",
  "onParsed",
  // render-health telemetry
  "onUnderrun",
  "onRenderLoad",
  "onRateDrift",
  "onLoadGap",
  // transport
  "load",
  "play",
  "stop",
  "pause",
  "unpause",
  "togglePause",
  "setRepeatCount",
  "setPos",
  "setOrderRow",
  "setVol",
  "setMono",
  "muteChannel",
  "selectSubsong",
  // decode / parse
  "parse",
  "decodeSong",
  "whenWorkerReady",
  // sample extraction (custom build)
  "readSample",
  "readSampleRaw",
] as const;

describe("the vendored engine satisfies the Engine interface", () => {
  test("every declared method exists on ChiptuneJsPlayer", () => {
    const proto = ChiptuneJsPlayer.prototype as unknown as Record<string, unknown>;
    const missing = ENGINE_METHODS.filter((m) => typeof proto[m] !== "function");
    expect(missing, "Engine declares methods the wrapper doesn't implement").toEqual([]);
  });

  test("selectSubsong is real, not aspirational", () => {
    // Multi-tune formats (SID carries up to 256 per file) need it after load.
    // It was implemented in the vendor layer but absent from the interface, so
    // nothing could reach it — the gap this suite is meant to keep shut.
    const proto = ChiptuneJsPlayer.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.selectSubsong).toBe("function");
    expect((proto.selectSubsong as (n: number) => void).length).toBe(1);
  });
});
