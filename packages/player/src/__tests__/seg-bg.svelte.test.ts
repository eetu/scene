// Characterises SevenSegment's `background`: it is a translucent window TINT, not an
// opaque fill — measured at alpha ~40/255 over the window body, with the canvas corners
// fully clear. That is the component behaving correctly; it expects a housing behind it.
//
// It matters here because the CRT screen composites canvases and not CSS, so the
// dancer's readout cannot get its housing from a CSS background — it paints its own
// face canvas instead (see DancerScene). If a future version ever made this opaque,
// that face becomes redundant, and this test is what would say so.
import { SevenSegment } from "@glowbox/svelte";
import { mount, unmount } from "svelte";
import { expect, test } from "vitest";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("seven-segment background coverage", { timeout: 60000 }, async () => {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:0;top:0;width:60px;height:90px";
  document.body.appendChild(host);
  const app = mount(SevenSegment as never, {
    target: host,
    props: { value: "8", displayStyle: "vfd", background: "#06050b", glow: 0.7 } as never,
  });
  await sleep(300);

  const c = host.querySelector("canvas") as HTMLCanvasElement;
  const probe = document.createElement("canvas");
  probe.width = c.width;
  probe.height = c.height;
  const ctx = probe.getContext("2d")!;
  ctx.drawImage(c, 0, 0);
  const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
  const at = (x: number, y: number) => {
    const i = (y * probe.width + x) * 4;
    return `rgba(${d[i]},${d[i + 1]},${d[i + 2]},${d[i + 3]})`;
  };
  let opaque = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 250) opaque++;
  const pct = ((opaque / (d.length / 4)) * 100).toFixed(0);

  const report =
    `canvas=${c.width}x${c.height} opaquePixels=${pct}% ` +
    `corner=${at(1, 1)} midLeft=${at(1, Math.floor(probe.height / 2))} ` +
    `centre=${at(Math.floor(probe.width / 2), Math.floor(probe.height / 2))}`;

  unmount(app);
  host.remove();

  // A tint, not a fill: the canvas is substantially transparent, so something else has
  // to supply the face. If this ever exceeds ~95%, `background` became an opaque fill
  // and DancerScene's face canvas can go.
  expect(Number(pct), report).toBeLessThan(95);
  // And the very corner is clear, which is why a CSS panel behind it was invisible
  // once the screen started compositing only canvases.
  expect(at(1, 1), report).toBe("rgba(0,0,0,0)");
});
