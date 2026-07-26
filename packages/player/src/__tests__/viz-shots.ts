// Frame capture + motion measurement for the visualiser harnesses. Shared by the
// whole-collection gallery and the focused per-viz checks, so both measure the
// same way and their numbers are comparable.
import { page } from "vitest/browser";
import { mount, unmount } from "svelte";

import { startVizFeed } from "./viz-feed";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Screenshot an element and return it downscaled, optionally saving the PNG. */
export async function grab(loc: unknown, path: string | null): Promise<ImageData> {
  const opts: Record<string, unknown> = { element: loc, base64: true };
  if (path) opts.path = path;
  else opts.save = false;
  // With `save: false` the base64 comes back as a bare string; with a path it
  // arrives as { path, base64 }.
  const res = await page.screenshot(opts as never);
  const b64 = typeof res === "string" ? res : (res as unknown as { base64: string }).base64;
  const img = new Image();
  img.src = "data:image/png;base64," + b64;
  await img.decode();
  // Downscale: we want structural change between frames, not per-pixel aliasing.
  const c = document.createElement("canvas");
  c.width = 160;
  c.height = 100;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return ctx.getImageData(0, 0, c.width, c.height);
}

/** Mean absolute luma change per pixel, 0–100. */
export function motion(a: ImageData, b: ImageData): number {
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const la = 0.299 * a.data[i] + 0.587 * a.data[i + 1] + 0.114 * a.data[i + 2];
    const lb = 0.299 * b.data[i] + 0.587 * b.data[i + 1] + 0.114 * b.data[i + 2];
    sum += Math.abs(la - lb);
  }
  return (sum / (a.data.length / 4) / 255) * 100;
}

/** Fraction of pixels that are not near-black, i.e. how much of the frame is used. */
export function fill(a: ImageData): number {
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (Math.max(a.data[i], a.data[i + 1], a.data[i + 2]) > 40) n++;
  }
  return (n / (a.data.length / 4)) * 100;
}

/** Luma spread over a frame — how harsh its contrast is, 0–100. */
export function contrast(a: ImageData): number {
  const l: number[] = [];
  for (let i = 0; i < a.data.length; i += 4) {
    l.push(0.299 * a.data[i] + 0.587 * a.data[i + 1] + 0.114 * a.data[i + 2]);
  }
  l.sort((x, y) => x - y);
  // 5th–95th percentile rather than min/max, so one stray pixel can't define it.
  return ((l[Math.floor(l.length * 0.95)] - l[Math.floor(l.length * 0.05)]) / 255) * 100;
}

/**
 * How much of each frame edge is covered by non-background content, as
 * percentages [top, right, bottom, left]. A subject that is being cut off by the
 * viewport shows up as a high number on that edge; judging this by eye from a
 * screenshot is unreliable, which is the whole reason it's measured.
 */
export function edges(a: ImageData): [number, number, number, number] {
  const { width: w, height: h, data } = a;
  const lit = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    return Math.max(data[i], data[i + 1], data[i + 2]) > 40 ? 1 : 0;
  };
  let top = 0;
  let bottom = 0;
  for (let x = 0; x < w; x++) {
    top += lit(x, 0);
    bottom += lit(x, h - 1);
  }
  let left = 0;
  let right = 0;
  for (let y = 0; y < h; y++) {
    left += lit(0, y);
    right += lit(w - 1, y);
  }
  return [(top / w) * 100, (right / h) * 100, (bottom / w) * 100, (left / h) * 100];
}

/** Centre of mass of lit pixels, as percentages of width/height. */
export function centroid(a: ImageData): [number, number] {
  const { width: w, height: h, data } = a;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (Math.max(data[i], data[i + 1], data[i + 2]) > 40) {
        sx += x;
        sy += y;
        n++;
      }
    }
  }
  return n ? [(sx / n / w) * 100, (sy / n / h) * 100] : [50, 50];
}

export type Shot = {
  motion: number;
  peak: number;
  fill: number;
  contrast: number;
  edges: [number, number, number, number];
  centroid: [number, number];
  frames: ImageData[];
};

/**
 * Mount a visualiser full-viewport, let it settle, and capture `count` frames
 * ~115ms apart (a quarter beat at 125bpm, so a set of 5 spans a full beat and
 * catches the kick at different points in its decay).
 *
 * `onReady` runs after settle and before capture — use it to click a control or
 * poke the component into a particular state.
 */
export async function captureViz(
  comp: unknown,
  opts: {
    id: string;
    outDir?: string | null;
    props?: Record<string, unknown>;
    jitter?: number;
    gain?: number;
    settleMs?: number;
    count?: number;
    onReady?: (host: HTMLElement) => void | Promise<void>;
  },
): Promise<Shot> {
  const feed = startVizFeed({ jitter: opts.jitter ?? 1, gain: opts.gain });
  const host = document.createElement("div");
  // Full viewport: a host wider than the harness page overflows and the capture
  // silently crops, which looks exactly like a rendering bug.
  host.style.cssText = "position:fixed;inset:0;overflow:hidden;background:var(--surface,#0f0f0f)";
  document.body.appendChild(host);
  const app = mount(comp as never, {
    target: host,
    props: (opts.props ?? { active: true }) as never,
  });

  await sleep(opts.settleMs ?? 2200); // lazy three.js imports + first layout
  await opts.onReady?.(host);

  const loc = (page as unknown as { elementLocator: (e: Element) => unknown }).elementLocator(host);
  const frames: ImageData[] = [];
  const count = opts.count ?? 5;
  for (let i = 0; i < count; i++) {
    frames.push(await grab(loc, opts.outDir ? `${opts.outDir}/${opts.id}-${i}.png` : null));
    await sleep(115);
  }

  unmount(app);
  host.remove();
  feed.stop();

  const diffs: number[] = [];
  for (let i = 1; i < frames.length; i++) diffs.push(motion(frames[i - 1], frames[i]));
  const mid = frames[Math.floor(frames.length / 2)];
  return {
    motion: diffs.reduce((a, b) => a + b, 0) / diffs.length,
    peak: Math.max(...diffs),
    fill: fill(mid),
    contrast: contrast(mid),
    // Worst edge coverage across the whole set, not just the middle frame — a
    // subject that only clips at one point in its orbit still clips.
    edges: frames.reduce(
      (acc, f) => edges(f).map((v, i) => Math.max(v, acc[i])) as [number, number, number, number],
      [0, 0, 0, 0] as [number, number, number, number],
    ),
    centroid: centroid(mid),
    frames,
  };
}
