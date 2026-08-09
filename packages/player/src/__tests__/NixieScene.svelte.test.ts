import { render } from "vitest-browser-svelte";
import { expect, test } from "vitest";

import NixieScene from "../NixieScene.svelte";

// Smoke test (browser — real WebGL2): the nixie scene mounts, extrudes the
// cathode geometry, compiles its programs and appends a canvas without throwing
// (idle, active:false). Polls for the canvas rather than asserting immediately:
// the first frame still has shader compilation and a bloom chain to allocate,
// and on a loaded machine — parallel workspace suites, each with its own headless
// browser — that has taken seconds.
test("NixieScene mounts and renders a WebGL canvas", { timeout: 30000 }, async () => {
  render(NixieScene, { props: { active: false } });
  await expect
    .poll(() => document.querySelector('[data-testid="nixie-scene"] canvas'), { timeout: 20000 })
    .toBeTruthy();
});
