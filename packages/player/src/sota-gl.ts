// The WebGL half of the dancer viz: op-art backdrop + echo-trailed dancer, after
// Spaceballs' "State of the Art" (Amiga, 1992).
//
// Both live in one renderer and one canvas — a second WebGL context just to draw
// a background would be wasteful, and compositing two canvases costs a layer. The
// backdrop draws first as a fullscreen triangle, then the figure over it.
//
// Three things carry the look, and all are deliberate:
//
//   * ECHO TRAIL. The figure is drawn several times, each a frame or two behind
//     the last and slightly smaller, tinted along a gradient. Because the poses
//     differ, the older copies peek out where the limbs *were* — motion blur
//     built from discrete steps, which is what the era's hardware could do.
//   * NO SHADING. Flat unlit colour. These are silhouettes with a tint, not lit
//     objects; any shading breaks it.
//   * STEPPED, NOT SMOOTH. The figure snaps between poses like traced film.
//     Smooth playback reads as "3D model".
//
// Those last two are why there is no skeleton here. The dance is a fixed set of
// poses, so `assets/build-dancer.py` bakes the deformed mesh once per frame and
// this draws pose N — no glTF loader, no skinning, no animation system, and
// therefore no three.js. Every pose of a clip lives in one vertex buffer, so
// changing frame is an attribute offset rather than an upload, and an echo is the
// same buffer read at a different offset.
import { BACKDROP_FRAGMENT, BACKDROP_VERTEX } from "./backdrop-shader";
import {
  compose,
  createContext,
  createFullscreenTriangle,
  createProgram,
  drawFullscreen,
  type GL,
  lookAt,
  multiply,
  perspective,
  type Program,
} from "./gl3";

export type SotaOptions = {
  /** Baked pose files, one per dance (see `assets/build-dancer.py`). Empty =
   *  backdrop only. */
  urls: string[];
  /** Which dance, by index — wrapped, so any number is safe. */
  clip?: number;
  /** Number of trailing copies behind the leading figure. */
  echoes?: number;
  /** Baked poses each echo lags the one in front. In *frames*, not seconds: the
   *  dance is stored one pose per 1/10s, so a lag under that rounds every copy
   *  onto the same pose and the trail disappears. */
  echoLag?: number;
  /** Leading figure's colour, and the far end of the trail's gradient. */
  colorNear?: string;
  colorFar?: string;
  /** Palette index into PALETTES — wrapped. Overrides colorNear/colorFar. */
  palette?: number;
  /** Clip rate at the reference tempo. */
  baseRate?: number;
  /** The dances' own natural tempo — the rate is the tune's BPM against this. */
  refBpm?: number;
};

/** Trail gradients. Each runs hot leading colour → cool tail, so the figure reads
 *  as one shape with a wake rather than a stack of separate bodies. */
export const PALETTES: ReadonlyArray<readonly [near: string, far: string]> = [
  ["#ff3fa4", "#2b0f4a"], // magenta → deep violet
  ["#3ff0e0", "#0b2a5c"], // cyan → deep blue
  ["#ff8a1f", "#4a1030"], // orange → maroon
  ["#c46bff", "#160a3a"], // purple → near-black indigo
];

export type SotaScene = {
  /** Advance by `dt` seconds, with the dance scaled to `bpm` (0 = unknown). */
  advance(dt: number, bpm: number): void;
  /** Bass, 0..1 — swells the backdrop's twist and leans the figure. */
  setPulse(p: number): void;
  setActive(on: boolean): void;
  /** True once a dance is loaded and drawing. */
  hasDancer(): boolean;
  /** How many dances are available. */
  clipCount(): number;
  /** Switch dance, by index — wrapped. Fetches that dance's poses if this is the
   *  first time it has been asked for. */
  setClip(index: number): void;
  /** Recolour the trail from PALETTES, by index — wrapped. */
  setPalette(index: number): void;
  resize(): void;
  dispose(): void;
};

/** One dance: every pose in one buffer, plus how to scale them back. */
type Clip = {
  vao: WebGLVertexArrayObject;
  positions: WebGLBuffer;
  indices: WebGLBuffer;
  indexCount: number;
  vertexCount: number;
  frames: number;
  fps: number;
  /** Seconds — `frames / fps`. */
  duration: number;
  /** Quantised 0..1 positions map back through `offset + q * scale`. */
  scale: [number, number, number];
  offset: [number, number, number];
};

/**
 * Clip playback rate for a tune at `bpm`, against the dances' natural tempo.
 *
 * The tempo comes from onset detection, which counts events rather than beats —
 * a busy pattern in a slow tune reports double or quadruple time, and the dancer
 * then looks manic under music that's crawling. Anything implausibly fast for a
 * dance is folded in half before use. Only downwards: a genuinely slow tune
 * should get a slow dance, which is the whole point.
 *
 * Unknown tempo (before the first beat) runs at reference speed.
 */
export function danceRate(bpm: number, refBpm = 125): number {
  if (bpm <= 0) return 1;
  let musical = bpm;
  while (musical > 165) musical /= 2;
  return Math.min(1.5, Math.max(0.3, musical / refBpm));
}

/** The baked-pose file's header, as `build-dancer.py` writes it. */
type PoseHeader = {
  version: number;
  name: string;
  fps: number;
  vertexCount: number;
  indexCount: number;
  frames: number;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
};

/** Split a baked pose file into its header and its two typed-array views. */
export function decodePoses(buffer: ArrayBuffer) {
  const headerLength = new DataView(buffer).getUint32(0, true);
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength)),
  ) as PoseHeader;
  if (header.version !== 1) throw new Error(`dancer: unknown pose format v${header.version}`);
  const indicesAt = 4 + headerLength;
  const indices = new Uint16Array(buffer, indicesAt, header.indexCount);
  const positions = new Uint16Array(
    buffer,
    indicesAt + header.indexCount * 2,
    header.frames * header.vertexCount * 3,
  );
  return { header, indices, positions };
}

const FIGURE_VERT = `#version 300 es
layout(location = 0) in vec3 aPos; // 0..1 within the clip's bounding box
uniform mat4 uModel, uViewProj;
uniform vec3 uScale, uOffset;
void main() {
  gl_Position = uViewProj * uModel * vec4(uOffset + aPos * uScale, 1.0);
}`;

const FIGURE_FRAG = `#version 300 es
precision highp float;
uniform vec3 uColor;
out vec4 frag;
void main() { frag = vec4(uColor, 1.0); }`;

const CAM_FOV = (35 * Math.PI) / 180;

function rgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [1, 1, 1];
  return [
    parseInt(m[1].slice(0, 2), 16) / 255,
    parseInt(m[1].slice(2, 4), 16) / 255,
    parseInt(m[1].slice(4, 6), 16) / 255,
  ];
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const wrap = (i: number, n: number) => (n ? ((i % n) + n) % n : 0);
const scaleOf = (s: number): [number, number, number] => [s, s, s];

export async function createSotaScene(host: HTMLElement, opts: SotaOptions): Promise<SotaScene> {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "display:block;width:100%;height:100%";
  host.appendChild(canvas);

  const ctx = createContext(canvas);
  if (!ctx) return deadScene(canvas);
  const g: GL = ctx;

  // Compiled together so one failure tears the other down instead of leaking it,
  // and destructured after the check so the rest of the file has non-null programs.
  const built = [
    createProgram(g, BACKDROP_VERTEX, BACKDROP_FRAGMENT, "dancer backdrop"),
    createProgram(g, FIGURE_VERT, FIGURE_FRAG, "dancer figure"),
  ];
  if (built.some((p) => !p)) {
    built.forEach((p) => p?.destroy());
    return deadScene(canvas);
  }
  const [backdrop, figure] = built as Program[];
  const tri = createFullscreenTriangle(g);

  // --- clips ----------------------------------------------------------------

  const urls = opts.urls ?? [];
  const clips: (Clip | null)[] = urls.map(() => null);
  const pending = new Map<number, Promise<void>>();

  async function loadClip(index: number): Promise<void> {
    if (clips[index] || !urls[index]) return;
    const existing = pending.get(index);
    if (existing) return existing;
    const job = (async () => {
      const buffer = await fetch(urls[index]).then((r) => {
        if (!r.ok) throw new Error(`dancer poses: HTTP ${r.status}`);
        return r.arrayBuffer();
      });
      const { header, indices, positions } = decodePoses(buffer);

      const vao = g.createVertexArray()!;
      g.bindVertexArray(vao);
      const posBuf = g.createBuffer()!;
      g.bindBuffer(g.ARRAY_BUFFER, posBuf);
      g.bufferData(g.ARRAY_BUFFER, positions, g.STATIC_DRAW);
      const idxBuf = g.createBuffer()!;
      g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, idxBuf);
      g.bufferData(g.ELEMENT_ARRAY_BUFFER, indices, g.STATIC_DRAW);
      g.bindVertexArray(null);

      const span = header.bboxMax.map((hi, i) => hi - header.bboxMin[i]) as [
        number,
        number,
        number,
      ];
      clips[index] = {
        vao,
        positions: posBuf,
        indices: idxBuf,
        indexCount: header.indexCount,
        vertexCount: header.vertexCount,
        frames: header.frames,
        fps: header.fps,
        duration: header.frames / header.fps,
        // Normalised attributes arrive as 0..1, so the box maps straight on.
        scale: span,
        offset: header.bboxMin,
      };
      frameCamera(clips[index]!);
    })().finally(() => pending.delete(index));
    pending.set(index, job);
    return job;
  }

  // --- camera ---------------------------------------------------------------

  let camDistance = 4;
  let camAimY = 0;
  let camNear = 0.1;
  let camFar = 100;

  /**
   * Frame on the figure. Tight, so it crops at the edges rather than standing
   * small in the middle — how the demo shot its dancers. Height only: the bind
   * pose has its arms out, and fitting those would push the camera miles back for
   * a span the dance never uses.
   */
  function frameCamera(clip: Clip) {
    const height = Math.max(clip.scale[1], 1e-3);
    const centreY = clip.offset[1] + height / 2;
    // Just inside the figure's full height: tight enough that a raised arm or a
    // jump crops at the edge — how the demo shot its dancers — without the head
    // leaving frame, which reads as a mistake rather than as a close shot.
    camDistance = (height * 0.92) / (2 * Math.tan(CAM_FOV / 2));
    // Aimed a touch above centre, so what goes first is the feet.
    camAimY = centreY + height * 0.05;
    // Clip planes follow the model's units: Mixamo exports centimetres, so a
    // figure is ~180 units tall and wants the camera ~370 back — well outside a
    // default far plane, which would clip it away entirely.
    camNear = Math.max(0.01, camDistance / 100);
    camFar = camDistance + height * 4;
  }

  // --- state ----------------------------------------------------------------

  const baseRate = opts.baseRate ?? 1;
  // A short lag keeps the trail tight against the figure — a long one reads as
  // several dancers rather than one in motion.
  const echoLag = opts.echoLag ?? 1;
  const refBpm = opts.refBpm ?? 125; // the Mixamo house dances sit around here
  const shrink = 0.007;
  const echoCount = Math.max(1, opts.echoes ?? 2) + 1;

  let colors: [number, number, number][] = [];
  function setPalette(index: number) {
    const [near, far] = PALETTES[wrap(index, PALETTES.length)];
    const a = rgb(opts.colorNear ?? near);
    const b = rgb(opts.colorFar ?? far);
    const last = Math.max(1, echoCount - 1);
    colors = Array.from({ length: echoCount }, (_, i) => {
      const t = i / last;
      return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)] as [
        number,
        number,
        number,
      ];
    });
  }
  setPalette(opts.palette ?? 0);

  // A full-screen high-contrast moiré that sweeps is a plausible trigger for
  // visual discomfort, so honour the OS setting: the pattern still draws, it just
  // holds still, and the dance keeps its beat-stepped motion without the sweep.
  const calm =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  let current = wrap(opts.clip ?? 0, Math.max(1, urls.length));
  let clock = 0;
  let elapsed = 0;
  let pulse = 0;
  let active = true;
  let disposed = false;

  // Theme colours, re-read each frame and only pushed on change — the app can
  // switch light/dark or accent at any time, and a string compare is far cheaper
  // than wiring a subscription in here.
  const cssVar = (name: string, fallback: string) => {
    if (typeof getComputedStyle !== "function") return fallback;
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  };
  let lastTheme = "";
  let paperCol: [number, number, number] = [0.1, 0.1, 0.1];
  let inkCol: [number, number, number] = [0.8, 0.8, 0.8];
  function syncTheme() {
    // Ground from the surface token, pattern from the text token — so the
    // relationship holds whichever way round the theme is.
    const paper = cssVar("--halo-bg-light", "#1c1c1c");
    const ink = cssVar("--halo-text-main", "#d6d6d6");
    const accent = cssVar("--accent", "#f78f08");
    const key = paper + ink + accent;
    if (key === lastTheme) return;
    lastTheme = key;
    const p = rgb(paper);
    const a = rgb(accent);
    // A touch of accent in the pattern, so the backdrop carries the app's hue
    // without becoming a block of it.
    const i = rgb(ink).map((c, k) => mix(c, a[k], 0.18)) as [number, number, number];
    // Then pull the pair toward each other. The theme's surface and text tokens
    // are picked for legible body copy — around a 7:1 luminance ratio — and a
    // dense fringe field at that contrast competes with the figure instead of
    // sitting behind it. Ink gives up more than paper does, so the backdrop
    // settles slightly darker overall and the accent-coloured dancer stays the
    // brightest thing in frame.
    const mid = p.map((c, k) => mix(c, i[k], 0.5));
    paperCol = p.map((c, k) => mix(c, mid[k], 0.22)) as [number, number, number];
    inkCol = i.map((c, k) => mix(c, mid[k], 0.34)) as [number, number, number];
  }

  // --- drawing --------------------------------------------------------------

  function render() {
    if (disposed) return;
    syncTheme();
    g.viewport(0, 0, canvas.width, canvas.height);
    g.disable(g.DEPTH_TEST);
    g.disable(g.BLEND);

    backdrop.use();
    g.uniform2f(backdrop.loc("uRes"), canvas.width, canvas.height);
    // Frozen backdrop clock under reduced motion — the interference is what
    // moves, so holding time still stops the sweep without losing the pattern.
    g.uniform1f(backdrop.loc("uTime"), calm ? 0 : elapsed);
    g.uniform1f(backdrop.loc("uPulse"), calm ? 0 : pulse);
    g.uniform3fv(backdrop.loc("uPaper"), paperCol);
    g.uniform3fv(backdrop.loc("uInk"), inkCol);
    drawFullscreen(g, tri);

    const clip = clips[current];
    if (!clip) return;

    const aspect = canvas.width / Math.max(1, canvas.height);
    const viewProj = multiply(
      perspective(CAM_FOV, aspect, camNear, camFar),
      lookAt([0, camAimY, camDistance], [0, camAimY, 0], [0, 1, 0]),
    );

    figure.use();
    g.uniformMatrix4fv(figure.loc("uViewProj"), false, viewProj);
    g.uniform3fv(figure.loc("uScale"), clip.scale);
    g.uniform3fv(figure.loc("uOffset"), clip.offset);
    g.enable(g.DEPTH_TEST);
    g.bindVertexArray(clip.vao);
    g.bindBuffer(g.ARRAY_BUFFER, clip.positions);
    g.enableVertexAttribArray(0);

    const stride = clip.vertexCount * 3 * 2; // bytes per pose
    // Oldest first, and the depth buffer cleared between passes: each figure has
    // to occlude itself correctly while newer ones paint over the top.
    for (let i = echoCount - 1; i >= 0; i--) {
      const frame = wrap(Math.floor(clock * clip.fps) - i * echoLag, clip.frames);
      // Normalised: the bake stores 0..65535 across the clip's bounding box, and
      // the shader maps that back through uScale/uOffset.
      g.vertexAttribPointer(0, 3, g.UNSIGNED_SHORT, true, 0, frame * stride);
      g.uniform3fv(figure.loc("uColor"), colors[i]);
      // The trail shrinks a little with age and the whole figure swells on the
      // bass — the only motion here that is not baked into the poses.
      g.uniformMatrix4fv(
        figure.loc("uModel"),
        false,
        compose([0, 0, 0], scaleOf(1 - i * shrink + pulse * 0.02)),
      );
      g.clear(g.DEPTH_BUFFER_BIT);
      g.drawElements(g.TRIANGLES, clip.indexCount, g.UNSIGNED_SHORT, 0);
    }
    g.bindVertexArray(null);
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round((host.clientWidth || 1) * dpr));
    const h = Math.max(1, Math.round((host.clientHeight || 1) * dpr));
    if (w === canvas.width && h === canvas.height) return;
    canvas.width = w;
    canvas.height = h;
    render();
  }

  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => resize()) : null;
  ro?.observe(host);
  resize();

  // The first dance is awaited so the caller knows whether there is a figure at
  // all; the rest are fetched only if someone cycles to them.
  if (urls.length) {
    try {
      await loadClip(current);
    } catch (e) {
      console.warn("dancer: could not load poses", e);
    }
  }
  render();

  return {
    advance(dt, bpm) {
      if (disposed || !active) return;
      // The backdrop runs on the same tempo scaling as the dance, so the fringes
      // and the figure breathe together instead of drifting against each other.
      const rate = danceRate(bpm, refBpm);
      elapsed += dt * rate;
      clock += dt * baseRate * rate;
      render();
    },
    setPulse(p) {
      pulse = Math.max(0, Math.min(1, p));
    },
    setActive(on) {
      active = on;
    },
    hasDancer: () => !!clips[current],
    clipCount: () => urls.length,
    setPalette,
    setClip(index) {
      const next = wrap(index, Math.max(1, urls.length));
      if (next === current) return;
      current = next;
      clock = 0;
      if (!clips[next]) void loadClip(next).catch(() => {});
      else frameCamera(clips[next]!);
    },
    resize,
    dispose() {
      disposed = true;
      ro?.disconnect();
      backdrop.destroy();
      figure.destroy();
      for (const c of clips) {
        if (!c) continue;
        g.deleteVertexArray(c.vao);
        g.deleteBuffer(c.positions);
        g.deleteBuffer(c.indices);
      }
      // Hand the context back at once: a browser allows only ~16, and flipping
      // between visualisers otherwise walks over the limit.
      g.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    },
  };
}

/** What a failed bring-up returns, so callers need no null check. */
function deadScene(canvas: HTMLCanvasElement): SotaScene {
  return {
    advance() {},
    setPulse() {},
    setActive() {},
    hasDancer: () => false,
    clipCount: () => 0,
    setClip() {},
    setPalette() {},
    resize() {},
    dispose() {
      canvas.remove();
    },
  };
}
