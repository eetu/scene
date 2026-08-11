// The panels stay reachable on a short window.
//
// A grid item's minimum height is its content unless it is told otherwise, so a
// side panel that outgrows the viewport pushes its own bottom off the screen —
// and because the row grew rather than overflowed, no scrollbar appears to bring
// it back. The frame strip is the bottom of the right rail and was the casualty:
// on a 1024×700 window it was simply gone, with nothing to say so.
import { mount, unmount } from "svelte";
import { expect, test } from "vitest";
import { page } from "vitest/browser";

import App from "../App.svelte";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const height of [700, 520]) {
  test(`the frame strip is reachable at 1024×${height}`, async () => {
    await page.viewport(1024, height);
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0";
    document.body.appendChild(host);
    const app = mount(App, { target: host });
    await sleep(200);

    const shell = host.querySelector(".app") as HTMLElement;
    const rail = host.querySelector("aside.right") as HTMLElement;
    const frames = [...host.querySelectorAll("h2, h3")].find((h) =>
      h.textContent?.toLowerCase().includes("frames"),
    );
    expect(frames, "no frames section").toBeTruthy();

    // The app never grows past its own box — that is what pushed the rail's
    // bottom off the screen and took the scrollbar with it.
    expect(shell.scrollHeight).toBeLessThanOrEqual(shell.clientHeight + 1);
    // Either the rail fits or it scrolls; either way the strip can be got to.
    rail.scrollTop = rail.scrollHeight;
    await sleep(60);
    const box = (frames as HTMLElement).getBoundingClientRect();
    const railBox = rail.getBoundingClientRect();
    expect(box.top).toBeGreaterThanOrEqual(railBox.top - 1);
    expect(box.bottom).toBeLessThanOrEqual(railBox.bottom + 1);

    unmount(app);
    host.remove();
  });
}
