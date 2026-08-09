// Do the 3D visualisers get a usable size inside the app's ACTUAL pane layout?
//
// Every other test in here mounts a visualiser into a bare full-viewport div, which
// is nothing like PlayerView: there the pane is a flex item, nested in a column flex
// parent, inside a wrapper carrying `container-type: size`. paint, tubes and dancer
// each size their renderer from the container, so a container that resolves to zero
// height renders them at 0x0 — a black pane, with no error anywhere.
import { mount, unmount } from "svelte";
import { expect, test } from "vitest";

import DancerScene from "../DancerScene.svelte";
import NixieScene from "../NixieScene.svelte";
import { installTheme, startVizFeed } from "./viz-feed";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The pane chain from PlayerView: .viz-view (column flex) > .vizstage > .vizbody. */
function appPane(withContainerType: boolean): { body: HTMLElement; root: HTMLElement } {
  const root = document.createElement("div");
  root.style.cssText =
    "position:fixed;inset:0;display:flex;flex-direction:column;min-height:0;overflow:hidden";
  // Stand-in for the viz picker row, which is `flex: 0 0 auto` above the pane.
  const pick = document.createElement("div");
  pick.style.cssText = "flex:0 0 auto;height:30px";
  root.appendChild(pick);

  const stage = document.createElement("div");
  stage.style.cssText =
    "position:relative;flex:1;min-height:0;display:flex" +
    (withContainerType ? ";container-type:size" : "");
  const body = document.createElement("div");
  body.style.cssText = "flex:1;min-height:0";
  stage.appendChild(body);
  root.appendChild(stage);
  document.body.appendChild(root);
  return { body, root };
}

const CASES = [
  { id: "tubes", comp: NixieScene },
  { id: "dancer", comp: DancerScene },
];

test("3D visualisers get a real size in the app pane", { timeout: 240000 }, async () => {
  installTheme("dark");
  const rows: string[] = [];

  for (const withCt of [true, false]) {
    for (const c of CASES) {
      const feed = startVizFeed({});
      const { body, root } = appPane(withCt);
      const app = mount(c.comp as never, { target: body, props: { active: true } as never });
      await sleep(2600); // lazy three import + scene build

      const canvas = body.querySelector("canvas") as HTMLCanvasElement | null;
      const r = body.getBoundingClientRect();
      rows.push(
        `containerType=${String(withCt).padEnd(5)} ${c.id.padEnd(6)} ` +
          `body=${r.width.toFixed(0)}x${r.height.toFixed(0)} ` +
          `canvas=${canvas ? `${canvas.width}x${canvas.height}` : "NONE"}`,
      );

      unmount(app);
      root.remove();
      feed.stop();
    }
  }

  for (const row of rows) {
    // A canvas that exists but is 0-sized, or no canvas at all, is a black pane.
    expect.soft(row, row).not.toMatch(/canvas=(NONE|0x|\d+x0$)/);
  }
  expect.soft(rows.join("\n")).toBeTruthy();
  // Surface the table on failure by asserting it last; on success it's just green.
  if (rows.some((r) => /canvas=(NONE|0x|\d+x0$)/.test(r))) throw new Error("\n" + rows.join("\n"));
});
