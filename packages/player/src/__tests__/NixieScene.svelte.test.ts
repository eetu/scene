import { render } from "vitest-browser-svelte";
import { expect, test } from "vitest";

import NixieScene from "../NixieScene.svelte";

// Smoke test (browser — three.js + WebGL): the 3D nixie scene mounts, lazy-loads
// three + @glowbox/nixie, builds the scene (wire cathodes, glass, bloom) and
// appends a canvas without throwing (idle, active:false). Polls for the canvas —
// the lazy import + scene build can take a moment on a cold CI runner. Guards the
// wiring — the dynamic imports, the ported scene, a breaking three/@glowbox bump.
test("NixieScene mounts and renders a WebGL canvas", async () => {
  render(NixieScene, { props: { active: false } });
  await expect
    .poll(() => document.querySelector('[data-testid="nixie-scene"] canvas'), { timeout: 8000 })
    .toBeTruthy();
});
