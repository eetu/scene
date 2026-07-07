import { describe, expect, test, vi } from "vitest";
import { createActor, fromPromise, waitFor } from "xstate";

import { DECODE_TIMEOUT_MS, transportMachine } from "../transport-machine";

/** An actor with controllable decode / startPlayback outcomes (no engine). */
function makeActor(
  opts: { decode?: () => Promise<void>; startPlayback?: () => Promise<void> } = {},
) {
  return createActor(
    transportMachine.provide({
      actors: {
        decode: fromPromise(opts.decode ?? (() => Promise.resolve())),
        startPlayback: fromPromise(opts.startPlayback ?? (() => Promise.resolve())),
      },
    }),
  );
}

describe("transport machine", () => {
  test("cold restore: CUE decodes then waits (never auto-plays)", async () => {
    const actor = makeActor().start();
    actor.send({ type: "CUE" });
    expect(actor.getSnapshot().matches({ cued: "decoding" })).toBe(true);

    await waitFor(actor, (s) => s.matches({ cued: "ready" }));
    // Decoded, but NOT playing — this is the honest state the reload bug lacked.
    expect(actor.getSnapshot().matches("playing")).toBe(false);

    // The impossible state: a stray PROGRESS while cued must not flip to playing.
    actor.send({ type: "PROGRESS" });
    expect(actor.getSnapshot().matches({ cued: "ready" })).toBe(true);
  });

  test("cued → PLAY (a user gesture) → playing", async () => {
    const actor = makeActor().start();
    actor.send({ type: "CUE" });
    await waitFor(actor, (s) => s.matches({ cued: "ready" }));

    actor.send({ type: "PLAY" });
    await waitFor(actor, (s) => s.matches("playing"));
    expect(actor.getSnapshot().value).toBe("playing");
  });

  test("a decode that never delivers times out to error (no infinite 'decoding…')", async () => {
    vi.useFakeTimers();
    try {
      const actor = makeActor({ decode: () => new Promise<void>(() => {}) }).start();
      actor.send({ type: "CUE" });
      expect(actor.getSnapshot().matches({ cued: "decoding" })).toBe(true);

      await vi.advanceTimersByTimeAsync(DECODE_TIMEOUT_MS + 10);
      expect(actor.getSnapshot().value).toBe("error");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a decode failure → error", async () => {
    const actor = makeActor({ decode: () => Promise.reject(new Error("bad module")) }).start();
    actor.send({ type: "CUE" });
    await waitFor(actor, (s) => s.matches("error"));
    expect(actor.getSnapshot().value).toBe("error");
  });

  test("click path: LOAD → playing, then pause ⇄ resume", async () => {
    const actor = makeActor().start();
    actor.send({ type: "LOAD" });
    await waitFor(actor, (s) => s.matches("playing"));

    actor.send({ type: "PAUSE" });
    expect(actor.getSnapshot().value).toBe("paused");
    actor.send({ type: "TOGGLE" });
    expect(actor.getSnapshot().value).toBe("playing");
  });

  test("playing → ENDED → ended, and PLAY restarts", async () => {
    const actor = makeActor().start();
    actor.send({ type: "LOAD" });
    await waitFor(actor, (s) => s.matches("playing"));

    actor.send({ type: "ENDED" });
    expect(actor.getSnapshot().value).toBe("ended");

    actor.send({ type: "PLAY" });
    await waitFor(actor, (s) => s.matches("playing"));
    expect(actor.getSnapshot().value).toBe("playing");
  });
});
