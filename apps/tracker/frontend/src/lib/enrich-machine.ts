// Bulk metadata enrichment as a small state machine: a cancellable async run.
// idle → START → enriching (invoke the enrich loop) → idle (done/error), with
// CANCEL bailing back to idle. Modelling it makes "enriching" an explicit state
// with a clean invoked-actor lifecycle (rather than a boolean + a manual guard),
// and it lives in the shared library store so the Settings panel reads it instead
// of taking it as props.
//
// Pure: the run is an injected actor, unit-tested with a mock (see
// __tests__/enrich-machine.test.ts). The library store provides the real run
// (the enrichTracks loop over the un-enriched library).
import { fromPromise, setup } from "xstate";

export type EnrichEvent = { type: "START" } | { type: "CANCEL" };

export const enrichMachine = setup({
  types: {} as { events: EnrichEvent },
  actors: {
    run: fromPromise<void>(async () => {}),
  },
}).createMachine({
  id: "enrich",
  initial: "idle",
  states: {
    idle: {
      on: { START: "enriching" },
    },
    enriching: {
      invoke: { src: "run", onDone: "idle", onError: "idle" },
      on: { CANCEL: "idle" },
    },
  },
});
