import { render } from "vitest-browser-svelte";
import { expect, test } from "vitest";

import NixieScene from "../NixieScene.svelte";

// Smoke test (browser — three.js + WebGL): the 3D nixie-tube scene mounts, lazy-
// loads three, builds the scene and paints without throwing (idle, active:false).
// Guards the wiring — the dynamic three import, the @glowbox/nixie digit textures,
// the geometry/material setup — and a breaking three or @glowbox bump.
test("NixieScene mounts and renders a WebGL canvas", async () => {
  render(NixieScene, { props: { active: false } });
  // three is dynamically imported, then the renderer + scene are built — give it
  // a beat before asserting the canvas is present and the scene root mounted.
  await new Promise((r) => setTimeout(r, 400));
  expect(document.querySelector('[data-testid="nixie-scene"] canvas')).toBeTruthy();
});
