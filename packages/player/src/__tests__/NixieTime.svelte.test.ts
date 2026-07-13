import { render } from "vitest-browser-svelte";
import { expect, test } from "vitest";

import NixieTime from "../NixieTime.svelte";

// Smoke test (browser — the nixie tubes render to a canvas): the clock viz mounts
// over @glowbox/svelte's <NixieTube> and paints without throwing, idle
// (active:false). Guards the wiring — the namespace import, the time formatting,
// the glass-pulse props — and a breaking @glowbox bump.
test("NixieTime mounts and renders nixie-tube canvases", async () => {
  render(NixieTime, { props: { active: false } });
  await new Promise((r) => setTimeout(r, 60)); // tubes create their canvases on mount
  expect(document.querySelector("canvas"), "a <NixieTube> canvas rendered").toBeTruthy();
});
