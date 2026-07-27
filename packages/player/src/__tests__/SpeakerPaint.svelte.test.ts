import { render } from "vitest-browser-svelte";
import { expect, test } from "vitest";

import SpeakerPaint from "../SpeakerPaint.svelte";

// Smoke test (browser — three.js + WebGL): the paint scene mounts, lazy-loads
// three, builds the MarchingCubes metaball scene (glossy material, env reflection,
// bloom) and appends a canvas without throwing (idle, active:false). Polls for the
// canvas — the lazy import + scene build can take a moment on a cold CI runner.
// Guards the wiring — the dynamic import, the MarchingCubes API, a breaking three bump.
// Generous timeouts, deliberately. Building a three.js scene means a lazy import, a WASM
// or shader compile and a first render; on a loaded machine — parallel workspace suites,
// each with its own headless browser, plus whatever else is running — that has been
// measured at over 15s, which failed this on CI once and locally since. The test is a
// yes/no on the scene coming up at all, so waiting longer costs nothing when it passes
// and a slow machine is not a defect worth reporting.
test("SpeakerPaint mounts and renders a WebGL canvas", { timeout: 60000 }, async () => {
  render(SpeakerPaint, { props: { active: false } });
  await expect
    .poll(() => document.querySelector('[data-testid="speaker-paint"] canvas'), { timeout: 45000 })
    .toBeTruthy();
});
