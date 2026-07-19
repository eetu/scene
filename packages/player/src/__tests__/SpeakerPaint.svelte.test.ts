import { render } from "vitest-browser-svelte";
import { expect, test } from "vitest";

import SpeakerPaint from "../SpeakerPaint.svelte";

// Smoke test (browser — three.js + WebGL): the paint scene mounts, lazy-loads
// three, builds the MarchingCubes metaball scene (glossy material, env reflection,
// bloom) and appends a canvas without throwing (idle, active:false). Polls for the
// canvas — the lazy import + scene build can take a moment on a cold CI runner.
// Guards the wiring — the dynamic import, the MarchingCubes API, a breaking three bump.
test("SpeakerPaint mounts and renders a WebGL canvas", async () => {
  render(SpeakerPaint, { props: { active: false } });
  await expect
    .poll(() => document.querySelector('[data-testid="speaker-paint"] canvas'), { timeout: 8000 })
    .toBeTruthy();
});
