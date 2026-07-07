import { describe, expect, test } from "vitest";
import { createActor, fromPromise, waitFor } from "xstate";

import { scanMachine } from "$lib/scan-machine";

type Actors = {
  checkStatus?: () => Promise<boolean>;
  pollStatus?: () => Promise<boolean>;
  loadTracks?: () => Promise<void>;
  rescan?: () => Promise<void>;
};

function makeActor(a: Actors = {}) {
  return createActor(
    scanMachine.provide({
      actors: {
        checkStatus: fromPromise(a.checkStatus ?? (() => Promise.resolve(false))),
        pollStatus: fromPromise(a.pollStatus ?? (() => Promise.resolve(false))),
        loadTracks: fromPromise(a.loadTracks ?? (() => Promise.resolve())),
        rescan: fromPromise(a.rescan ?? (() => Promise.resolve())),
      },
    }),
  );
}

describe("scan machine", () => {
  test("boot with an idle backend → loads tracks → ready", async () => {
    const actor = makeActor({ checkStatus: () => Promise.resolve(false) }).start();
    await waitFor(actor, (s) => s.matches("ready"));
    expect(actor.getSnapshot().value).toBe("ready");
  });

  test("boot while scanning → polls until idle → loads → ready", async () => {
    let polls = 0;
    const actor = makeActor({
      checkStatus: () => Promise.resolve(true), // backend busy at boot
      pollStatus: () => Promise.resolve(++polls < 2), // busy once more, then idle
    }).start();
    await waitFor(actor, (s) => s.matches("scanning"));
    await waitFor(actor, (s) => s.matches("ready"));
    expect(polls).toBeGreaterThanOrEqual(2); // it re-polled before loading
  });

  test("a status-check failure at boot → error", async () => {
    const actor = makeActor({ checkStatus: () => Promise.reject(new Error("net")) }).start();
    await waitFor(actor, (s) => s.matches("error"));
    expect(actor.getSnapshot().value).toBe("error");
  });

  test("a transient poll error keeps scanning (doesn't drop to error)", async () => {
    let polls = 0;
    const actor = makeActor({
      checkStatus: () => Promise.resolve(true),
      pollStatus: () => {
        polls += 1;
        if (polls === 1) return Promise.reject(new Error("transient"));
        return Promise.resolve(false); // idle on the retry
      },
    }).start();
    await waitFor(actor, (s) => s.matches("ready"));
    expect(polls).toBeGreaterThanOrEqual(2); // recovered + kept polling
  });

  test("ready → RESCAN → rescanning → reloads → ready", async () => {
    const actor = makeActor().start();
    await waitFor(actor, (s) => s.matches("ready"));
    actor.send({ type: "RESCAN" });
    expect(actor.getSnapshot().matches("rescanning")).toBe(true);
    await waitFor(actor, (s) => s.matches("ready"));
    expect(actor.getSnapshot().value).toBe("ready");
  });

  test("rescan failure → error, and RESCAN recovers from error", async () => {
    let attempt = 0;
    const actor = makeActor({
      rescan: () => {
        attempt += 1;
        return attempt === 1 ? Promise.reject(new Error("boom")) : Promise.resolve();
      },
    }).start();
    await waitFor(actor, (s) => s.matches("ready"));
    actor.send({ type: "RESCAN" });
    await waitFor(actor, (s) => s.matches("error"));
    actor.send({ type: "RESCAN" }); // recover
    await waitFor(actor, (s) => s.matches("ready"));
    expect(actor.getSnapshot().value).toBe("ready");
  });
});
