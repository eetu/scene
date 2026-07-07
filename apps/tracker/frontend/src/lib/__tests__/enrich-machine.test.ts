import { describe, expect, test } from "vitest";
import { createActor, fromPromise, waitFor } from "xstate";

import { enrichMachine } from "$lib/enrich-machine";

function makeActor(run: () => Promise<void> = () => Promise.resolve()) {
  return createActor(enrichMachine.provide({ actors: { run: fromPromise(run) } }));
}

describe("enrich machine", () => {
  test("START → enriching → idle when the run finishes", async () => {
    const actor = makeActor().start();
    expect(actor.getSnapshot().value).toBe("idle");
    actor.send({ type: "START" });
    expect(actor.getSnapshot().value).toBe("enriching");
    await waitFor(actor, (s) => s.matches("idle"));
    expect(actor.getSnapshot().value).toBe("idle");
  });

  test("CANCEL from enriching returns to idle immediately", async () => {
    const actor = makeActor(() => new Promise<void>(() => {})).start(); // run never resolves
    actor.send({ type: "START" });
    expect(actor.getSnapshot().matches("enriching")).toBe(true);
    actor.send({ type: "CANCEL" });
    expect(actor.getSnapshot().value).toBe("idle");
  });

  test("a run failure still lands back on idle", async () => {
    const actor = makeActor(() => Promise.reject(new Error("boom"))).start();
    actor.send({ type: "START" });
    await waitFor(actor, (s) => s.matches("idle"));
    expect(actor.getSnapshot().value).toBe("idle");
  });
});
