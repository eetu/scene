// A 3D nixie clock: bent-wire cathodes stacked in depth inside glass tubes on a
// stand, orbiting, one numeral lit per tube.
//
// The point of the viz is the *stack*: from an angle you look past the lit numeral
// at the nine unlit ones behind it, which is what a real nixie tube looks like and
// what no flat seven-segment fake can do. So the geometry and the depth spacing
// are exact, and the glass is deliberately cheap — a fresnel-weighted shell rather
// than the refractive transmission this scene used to pay three.js for.
//
// Everything nixie-specific still comes from @glowbox/nixie: the cathode stack
// (`nixieCathodes`), wire gauge + squash (`nixieStyle`), the honeycomb anode
// grille (`nixieMesh`), the separator (`glyphPath`) and the wire colour. Turning
// those into geometry is ./nixie-geometry; this file owns the rendering — a
// multisampled forward pass into an offscreen target, a threshold-and-blur bloom
// chain over it, and a damped orbit camera. `setPulse` feeds bass energy in to
// throb the glow with the music.
import {
  GLYPH_VIEWBOX,
  glyphPath,
  NIXIE_WIRE_COLOR,
  nixieCathodes,
  nixieMesh,
  nixieStyle,
} from "@glowbox/nixie";

import {
  bindTarget,
  compose,
  createContext,
  createFullscreenTriangle,
  createMsaaTarget,
  createProgram,
  createTarget,
  drawFullscreen,
  drawMesh,
  type GL,
  type GpuMesh,
  lookAt,
  type Mat4,
  multiply,
  normalMatrix,
  perspective,
  type Program,
  type Target,
  uploadLines,
  uploadMesh,
} from "./gl3";
import {
  box,
  cylinder,
  hexGrille,
  lathe,
  mergeMeshes,
  type Mesh,
  pathToPolylines,
  tubeFromPolyline,
} from "./nixie-geometry";
import { activeFps, idleFps, reportFrame } from "./perf.svelte";

export interface NixieSceneOptions {
  digits: string[];
  /** Glow / lit-numeral colour (CSS string). */
  color: string;
  /** Glass tint (CSS string). */
  glass: string;
  /** Scene backdrop (CSS string). */
  backdrop: string;
  /** Tube proportions, matching the 2D control. */
  style: "classic" | "slim" | "tall";
}

export interface NixieScene {
  setDigits(digits: string[]): void;
  setOptions(patch: Partial<Omit<NixieSceneOptions, "digits">>): void;
  /** Bass energy 0..1 — throbs the glow + bloom with the music. */
  setPulse(v: number): void;
  /** Playing? Idle-throttles the render loop to save battery. */
  setActive(active: boolean): void;
  resize(): void;
  dispose(): void;
}

// Tube dimensions (world units) — unchanged from the three.js scene, so the
// proportions and the camera framing carry over exactly.
const DIGIT_TUBE_R = 0.62;
const COLON_TUBE_R = 0.34;
const TUBE_H = 2.05;
const CONTENT_H = 2.95; // full vertical extent (base → domed top), for framing
const GAP = 0.14;
// Fit a numeral comfortably inside the glass: cap width to the inner diameter and
// height to a fraction of the tube, so nothing overflows the envelope.
const INNER_R = DIGIT_TUBE_R * 0.72;
const S = Math.min((INNER_R * 2) / GLYPH_VIEWBOX.width, (TUBE_H * 0.6) / GLYPH_VIEWBOX.height);
// Wire radius from the component's stroke width (classic gauge; the squash
// conveys style live).
const WIRE_R = nixieStyle("classic").strokeWidth * S * 0.28;
const STACK_SPACING = 0.055; // z gap between adjacent cathodes (tight, like a real tube)
const FRONT_Z = 4.5 * STACK_SPACING; // z of the frontmost cathode (depth 0)
const GRILLE_Z = FRONT_Z + 0.06; // the anode mesh sits in front of the whole stack

const GLOW_LEVEL = 0.95; // emissive of the lit numeral, before the pulse
const BLOOM_STRENGTH = 1.15;
const BLOOM_THRESHOLD = 0.4;
/** Bloom levels, each half the previous one's size. Three reaches across a tube
 *  without the steps between levels showing as rings. */
const BLOOM_LEVELS = 3;

const CAM_FOV = (40 * Math.PI) / 180;
const CAM_MIN_DIST = 6;
const CAM_MAX_DIST = 40;
/** The old camera's (0, 0.9, 10.5) elevation, as a polar angle. */
const CAM_POLAR = Math.PI / 2 - 0.086;
/** Sway amplitude, radians — how far either side of the front the camera drifts. */
const SWAY_RAD = 0.72;

const isColonSlot = (i: number) => i === 2 || i === 5;

/** Map a glyph-viewBox point (y-down) into world space at depth z. */
const toWorld = (px: number, py: number, z: number): [number, number, number] => [
  (px - GLYPH_VIEWBOX.width / 2) * S,
  -(py - GLYPH_VIEWBOX.height / 2) * S,
  z,
];

/** `#rgb`/`#rrggbb` → 0..1 triple. Hex is all this scene is ever given. */
function rgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [1, 1, 1];
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

/** The backdrop, capped dark (max channel ≤ 0.14, hue preserved): glowing tubes
 *  only read against the dark, so a bright page must not wash them out. */
function darkBackdrop(hex: string): [number, number, number] {
  const c = rgb(hex);
  const m = Math.max(c[0], c[1], c[2]);
  return m > 0.14 ? [c[0] * (0.14 / m), c[1] * (0.14 / m), c[2] * (0.14 / m)] : c;
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const SOLID_VERT = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
uniform mat4 uModel, uViewProj;
uniform mat3 uNormalMat;
out vec3 vNormal;
out vec3 vWorld;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorld = world.xyz;
  vNormal = uNormalMat * aNormal;
  gl_Position = uViewProj * world;
}`;

// Two directional lights, an ambient term and a fresnel rim. Not PBR and not
// image-based: the only genuinely reflective things here are the metal base and
// the glass, and at this size both read fine off a rim term — which is the whole
// reason the PMREM room environment could go.
const SOLID_FRAG = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
uniform vec3 uAlbedo, uEmissive, uEye;
uniform float uShine, uRim;
out vec4 frag;

const vec3 KEY_DIR = normalize(vec3(0.55, 0.72, 0.62));
const vec3 RIM_DIR = normalize(vec3(-0.7, 0.28, -0.55));
const vec3 RIM_TINT = vec3(0.56, 0.70, 1.0);

void main() {
  vec3 n = normalize(vNormal);
  vec3 view = normalize(uEye - vWorld);
  // Two-sided: the wires are open tubes and the stand is seen from above, so a
  // back-facing fragment must light as though its normal pointed at the camera.
  if (dot(n, view) < 0.0) n = -n;

  float key = max(dot(n, KEY_DIR), 0.0);
  float rim = max(dot(n, RIM_DIR), 0.0);
  vec3 lit = uAlbedo * (0.30 + 0.62 * key) + RIM_TINT * (0.20 * rim);

  vec3 h = normalize(KEY_DIR + view);
  lit += vec3(pow(max(dot(n, h), 0.0), 48.0) * uShine);
  lit += uAlbedo * pow(1.0 - max(dot(n, view), 0.0), 3.0) * uRim;

  frag = vec4(lit + uEmissive, 1.0);
}`;

// The glass envelope. Face-on it is nearly clear, so the cathode stack reads
// through it; towards grazing angles fresnel takes over and it becomes a bright
// tinted rim, which is what makes it a glass cylinder rather than cellophane.
const GLASS_FRAG = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
uniform vec3 uTint, uEye, uGlow;
out vec4 frag;

const vec3 KEY_DIR = normalize(vec3(0.55, 0.72, 0.62));

void main() {
  vec3 n = normalize(vNormal);
  vec3 view = normalize(uEye - vWorld);
  if (dot(n, view) < 0.0) n = -n;
  float f = pow(1.0 - max(dot(n, view), 0.0), 2.6);

  vec3 h = normalize(KEY_DIR + view);
  float spec = pow(max(dot(n, h), 0.0), 96.0);

  // A little body even face-on (0.11): a wall that only exists at its silhouette
  // reads as a hole with a rim round it rather than as glass.
  frag = vec4(uTint * (0.4 + 0.7 * f) + vec3(0.10 + spec * 0.85) + uGlow,
              clamp(0.11 + f * 0.62 + spec * 0.5, 0.0, 1.0));
}`;

const LINE_VERT = `#version 300 es
layout(location = 0) in vec3 aPos;
uniform mat4 uModel, uViewProj;
void main() { gl_Position = uViewProj * uModel * vec4(aPos, 1.0); }`;

const LINE_FRAG = `#version 300 es
precision highp float;
uniform vec3 uColor;
out vec4 frag;
void main() { frag = vec4(uColor, 1.0); }`;

const POST_VERT = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const BRIGHT_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uThreshold;
out vec4 frag;
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // Soft knee: a hard cut makes the halo's edge crawl as the tubes sway.
  frag = vec4(c * smoothstep(uThreshold, uThreshold + 0.25, l), 1.0);
}`;

const BLUR_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDirection; // texel step, one axis at a time; (0,0) is a plain copy
out vec4 frag;
// Five taps at linear-filtered midpoints — a 17-wide gaussian for nine samples.
const float O[3] = float[3](0.0, 1.3846153846, 3.2307692308);
const float W[3] = float[3](0.2270270270, 0.3162162162, 0.0702702703);
void main() {
  vec3 sum = texture(uTex, vUv).rgb * W[0];
  for (int i = 1; i < 3; i++) {
    sum += texture(uTex, vUv + uDirection * O[i]).rgb * W[i];
    sum += texture(uTex, vUv - uDirection * O[i]).rgb * W[i];
  }
  frag = vec4(sum, 1.0);
}`;

const COMPOSITE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene, uBloom0, uBloom1, uBloom2;
uniform float uStrength;
out vec4 frag;

// ACES filmic (Narkowicz's fit) — the tone curve the three.js renderer applied,
// so the glow still rolls off into white instead of clipping flat.
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec3 bloom = texture(uBloom0, vUv).rgb
             + texture(uBloom1, vUv).rgb * 0.72
             + texture(uBloom2, vUv).rgb * 0.48;
  frag = vec4(aces(texture(uScene, vUv).rgb + bloom * uStrength), 1.0);
}`;

// ---------------------------------------------------------------------------

/** One tube's place in the row, and which cathode (if any) is lit. */
type Tube = { kind: "digit"; x: number; lit: string | null } | { kind: "colon"; x: number };

export function createNixieScene(container: HTMLElement, opts: NixieSceneOptions): NixieScene {
  const canvas = document.createElement("canvas");
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.touchAction = "none";
  canvas.style.cursor = "grab";
  container.appendChild(canvas);

  const ctx = createContext(canvas);
  if (!ctx) return deadScene(canvas);
  const g: GL = ctx;

  // Compiled together so one failure (an old driver, a lost context during
  // bring-up) tears the others down instead of leaking them. Destructured after
  // the check so the rest of the file has non-null programs.
  const built = [
    createProgram(g, SOLID_VERT, SOLID_FRAG, "nixie solid"),
    createProgram(g, SOLID_VERT, GLASS_FRAG, "nixie glass"),
    createProgram(g, LINE_VERT, LINE_FRAG, "nixie line"),
    createProgram(g, POST_VERT, BRIGHT_FRAG, "nixie bright"),
    createProgram(g, POST_VERT, BLUR_FRAG, "nixie blur"),
    createProgram(g, POST_VERT, COMPOSITE_FRAG, "nixie composite"),
  ];
  if (built.some((p) => !p)) {
    built.forEach((p) => p?.destroy());
    return deadScene(canvas);
  }
  const [solid, glass, line, bright, blur, composite] = built as Program[];

  // --- geometry -------------------------------------------------------------

  /** A glyph's centreline extruded into wire, built once per symbol. */
  const wireCache = new Map<string, GpuMesh | null>();
  function wireFor(symbol: string, d: string): GpuMesh | null {
    if (!wireCache.has(symbol)) {
      const parts = pathToPolylines(d)
        .map((poly) =>
          tubeFromPolyline(
            poly.map(([x, y]) => toWorld(x, y, 0)),
            WIRE_R,
          ),
        )
        .filter((m): m is Mesh => !!m);
      const merged = mergeMeshes(parts);
      wireCache.set(symbol, merged ? uploadMesh(g, merged) : null);
    }
    return wireCache.get(symbol) ?? null;
  }

  /** Glass envelope: straight wall into a convex domed top, open at the bottom
   *  where the metal base sits — one skin, so there is no seam to catch light. */
  function domedProfile(r: number): [number, number][] {
    const domeRise = r * 0.62;
    const pts: [number, number][] = [
      [r, -TUBE_H / 2],
      [r, TUBE_H / 2],
    ];
    const steps = 9;
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * (Math.PI / 2);
      pts.push([r * Math.cos(t), TUBE_H / 2 + domeRise * Math.sin(t)]);
    }
    return pts;
  }

  const glassDigit = uploadMesh(g, lathe(domedProfile(DIGIT_TUBE_R), 32));
  const glassColon = uploadMesh(g, lathe(domedProfile(COLON_TUBE_R), 24));
  const baseDigit = uploadMesh(g, cylinder(DIGIT_TUBE_R * 1.05, DIGIT_TUBE_R * 1.15, 0.24, 24));
  const baseColon = uploadMesh(g, cylinder(COLON_TUBE_R * 1.1, COLON_TUBE_R * 1.2, 0.24, 20));
  const anode = nixieMesh(GLYPH_VIEWBOX.width, GLYPH_VIEWBOX.height);
  const grille = uploadLines(
    g,
    hexGrille(anode.cells, anode.radius, (x, y) => toWorld(x, y, 0)),
  );
  const tri = createFullscreenTriangle(g);
  const cathodeSpec = nixieCathodes();
  let stand: GpuMesh | null = null;
  let standWidth = -1;

  // --- layout ---------------------------------------------------------------

  let tubes: Tube[] = [];
  let contentW = 12;

  function layout(n: number) {
    const widths = Array.from({ length: n }, (_, i) =>
      isColonSlot(i) ? COLON_TUBE_R * 2 : DIGIT_TUBE_R * 2,
    );
    const total = widths.reduce((a, w) => a + w + GAP, -GAP);
    contentW = total + 0.4;
    let x = -total / 2;
    tubes = [];
    for (let i = 0; i < n; i++) {
      const cx = x + widths[i] / 2;
      x += widths[i] + GAP;
      tubes.push(isColonSlot(i) ? { kind: "colon", x: cx } : { kind: "digit", x: cx, lit: null });
    }
    if (standWidth !== total) {
      standWidth = total;
      stand = uploadMesh(g, box(total + 1.0, 0.34, 1.5));
    }
    frameContent();
  }

  function setDigits(digits: string[]) {
    if (tubes.length !== digits.length) layout(digits.length);
    for (let i = 0; i < digits.length; i++) {
      const t = tubes[i];
      if (t.kind !== "digit") continue;
      t.lit = cathodeSpec.some((c) => c.symbol === digits[i]) ? digits[i] : null;
    }
  }

  // --- camera ---------------------------------------------------------------

  // A damped spherical orbit, by hand rather than through OrbitControls: this
  // needs damping, a zoom clamp and an ease back to the front, and nothing else
  // that class offers.
  let azimuth = 0;
  let polar = CAM_POLAR;
  let distance = 10.5;
  let azimuthVel = 0;
  let polarVel = 0;
  let interacting = false;
  let interactEnd = -Infinity;
  let pointerId: number | null = null;
  let lastX = 0;
  let lastY = 0;

  const onPointerDown = (e: PointerEvent) => {
    if (pointerId !== null) return;
    pointerId = e.pointerId;
    interacting = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    azimuthVel -= (e.clientX - lastX) * 0.004;
    polarVel -= (e.clientY - lastY) * 0.004;
    lastX = e.clientX;
    lastY = e.clientY;
  };
  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    interacting = false;
    interactEnd = performance.now();
    canvas.releasePointerCapture?.(e.pointerId);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    distance = clamp(distance * (1 + Math.sign(e.deltaY) * 0.08), CAM_MIN_DIST, CAM_MAX_DIST);
  };
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  /**
   * Pull the camera back far enough that the whole row stays in frame — at every
   * angle the sway reaches, not just head-on.
   *
   * Fitting the head-on width is what a single `max(fitH, fitW)` does, and it is
   * not enough for a subject this wide: turned 40° the near end of the row is a
   * couple of units closer to the lens, and perspective magnifies it straight out
   * of frame while the far end shrinks towards the vanishing point. So the fit
   * runs over the corners of the content box at the extremes of the sway and
   * takes the distance that satisfies the worst of them.
   */
  function frameContent() {
    const tanV = Math.tan(CAM_FOV / 2);
    const tanH = tanV * Math.max(0.0001, canvas.width / Math.max(1, canvas.height));
    const hx = contentW / 2;
    const hy = CONTENT_H / 2;
    const hz = 0.75; // the stand is the deepest thing in the set
    let need = CAM_MIN_DIST;
    for (const theta of [-SWAY_RAD, 0, SWAY_RAD]) {
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          // The corner in view space: the camera orbits, so the set turns by -θ.
          const x = sx * hx * c - sz * hz * s;
          const z = sx * hx * s + sz * hz * c;
          // A corner at (x, z) needs d ≥ z + |x| / tan for its side of the frame.
          need = Math.max(need, z + Math.abs(x) / tanH, z + hy / tanV);
        }
      }
    }
    distance = clamp(need * 1.06, CAM_MIN_DIST, CAM_MAX_DIST);
  }

  // --- targets --------------------------------------------------------------

  const msaa = createMsaaTarget(g, 1, 1);
  const scene = createTarget(g, 1, 1);
  const bloomA: Target[] = [];
  const bloomB: Target[] = [];
  for (let i = 0; i < BLOOM_LEVELS; i++) {
    bloomA.push(createTarget(g, 1, 1));
    bloomB.push(createTarget(g, 1, 1));
  }

  // Retina capped at 1.5×: the frame is drawn once and then post-processed four
  // more times over, so this is the main heat lever, and 1.5× is visually
  // identical to 2× at these sizes.
  const dpr = () => Math.min(window.devicePixelRatio || 1, 1.5);

  function resize() {
    const w = Math.max(1, Math.round(container.clientWidth * dpr()));
    const h = Math.max(1, Math.round(container.clientHeight * dpr()));
    if (w === canvas.width && h === canvas.height) return;
    canvas.width = w;
    canvas.height = h;
    msaa.resize(w, h);
    scene.resize(w, h);
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      bloomA[i].resize(Math.max(1, w >> (i + 1)), Math.max(1, h >> (i + 1)));
      bloomB[i].resize(Math.max(1, w >> (i + 1)), Math.max(1, h >> (i + 1)));
    }
    frameContent();
  }

  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => resize()) : null;
  ro?.observe(container);

  // --- state ----------------------------------------------------------------

  let glowColor = rgb(opts.color);
  let glassTint = rgb(opts.glass);
  let background = darkBackdrop(opts.backdrop);
  let squash = nixieStyle(opts.style).squash;
  let pulse = 0;
  let sceneActive = true;
  let raf = 0;
  let lastRender = 0;
  let sway = 0;

  // The unlit cathodes are meant to be *there*, not readable: nine legible
  // numerals stacked in one tube is illegible, and the real thing is dark nickel
  // that only catches an edge of light.
  const wireColor: [number, number, number] = [
    NIXIE_WIRE_COLOR[0] * 0.17,
    NIXIE_WIRE_COLOR[1] * 0.17,
    NIXIE_WIRE_COLOR[2] * 0.17,
  ];

  setDigits(opts.digits);
  resize();

  // --- drawing --------------------------------------------------------------

  function material(p: Program, albedo: number[], emissive: number[], shine: number, rim: number) {
    g.uniform3fv(p.loc("uAlbedo"), albedo);
    g.uniform3fv(p.loc("uEmissive"), emissive);
    g.uniform1f(p.loc("uShine"), shine);
    g.uniform1f(p.loc("uRim"), rim);
  }

  function drawObject(p: Program, m: GpuMesh, model: Mat4) {
    g.uniformMatrix4fv(p.loc("uModel"), false, model);
    g.uniformMatrix3fv(p.loc("uNormalMat"), false, normalMatrix(model));
    drawMesh(g, m);
  }

  function renderScene(viewProj: Mat4, eye: number[]) {
    msaa.bind();
    g.clearColor(background[0], background[1], background[2], 1);
    g.enable(g.DEPTH_TEST);
    g.depthMask(true);
    g.disable(g.BLEND);
    g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT);

    const level = GLOW_LEVEL * (1 + pulse * 0.45);
    const emissive = [glowColor[0] * level, glowColor[1] * level, glowColor[2] * level];
    const litAlbedo = [glowColor[0] * 0.2, glowColor[1] * 0.2, glowColor[2] * 0.2];
    const [sx, sy] = squash;

    solid.use();
    g.uniformMatrix4fv(solid.loc("uViewProj"), false, viewProj);
    g.uniform3fv(solid.loc("uEye"), eye);

    for (const t of tubes) {
      if (t.kind === "colon") {
        const d = glyphPath(":");
        const m = d ? wireFor(":", d) : null;
        if (m) {
          material(solid, litAlbedo, emissive, 0.1, 0.2);
          drawObject(solid, m, compose([t.x, 0, 0]));
        }
      } else {
        for (const c of cathodeSpec) {
          const m = wireFor(c.symbol, c.path);
          if (!m) continue;
          const isLit = c.symbol === t.lit;
          material(
            solid,
            isLit ? litAlbedo : wireColor,
            isLit ? emissive : [0, 0, 0],
            isLit ? 0.1 : 0.22,
            isLit ? 0.25 : 0.07,
          );
          // Each cathode sits at its own offset inside the squashed stack, one
          // STACK_SPACING deeper than the one in front of it. That depth is the
          // whole point of the viz, so it is exact rather than eyeballed.
          drawObject(
            solid,
            m,
            compose(
              [
                t.x + c.offset[0] * S * sx,
                -c.offset[1] * S * sy,
                FRONT_Z - c.depth * STACK_SPACING,
              ],
              [sx, sy, 1],
            ),
          );
        }
      }
      material(solid, [0.14, 0.15, 0.18], [0, 0, 0], 0.5, 0.3);
      drawObject(
        solid,
        t.kind === "colon" ? baseColon : baseDigit,
        compose([t.x, -TUBE_H / 2 - 0.06, 0]),
      );
    }

    if (stand) {
      material(solid, [0.09, 0.09, 0.11], [0, 0, 0], 0.35, 0.25);
      drawObject(solid, stand, compose([0, -TUBE_H / 2 - 0.24, 0]));
    }

    // The anode grille, in front of the stack — where a real tube's mesh is, so
    // it needs no draw-order trick to stay visible.
    line.use();
    g.uniformMatrix4fv(line.loc("uViewProj"), false, viewProj);
    // Dim: a hairline grid over the whole numeral reads far brighter than its
    // colour suggests, because every one of those lines is a full-intensity pixel.
    g.uniform3fv(line.loc("uColor"), [0.13, 0.14, 0.16]);
    for (const t of tubes) {
      if (t.kind !== "digit") continue;
      g.uniformMatrix4fv(line.loc("uModel"), false, compose([t.x, 0, GRILLE_Z]));
      drawMesh(g, grille);
    }

    // Glass last: blended, and not writing depth, so a tube's shell does not cull
    // the tubes behind it.
    glass.use();
    g.uniformMatrix4fv(glass.loc("uViewProj"), false, viewProj);
    g.uniform3fv(glass.loc("uEye"), eye);
    g.uniform3fv(glass.loc("uTint"), glassTint);
    g.uniform3fv(glass.loc("uGlow"), [emissive[0] * 0.05, emissive[1] * 0.05, emissive[2] * 0.05]);
    g.enable(g.BLEND);
    g.blendFunc(g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA);
    g.depthMask(false);
    for (const t of tubes) {
      drawObject(glass, t.kind === "colon" ? glassColon : glassDigit, compose([t.x, 0, 0]));
    }
    g.depthMask(true);
    g.disable(g.BLEND);

    msaa.resolveTo(scene);
  }

  function renderBloom() {
    g.disable(g.DEPTH_TEST);
    g.disable(g.BLEND);
    g.activeTexture(g.TEXTURE0);

    bright.use();
    bindTarget(g, bloomA[0]);
    g.bindTexture(g.TEXTURE_2D, scene.texture);
    g.uniform1i(bright.loc("uTex"), 0);
    g.uniform1f(bright.loc("uThreshold"), BLOOM_THRESHOLD);
    drawFullscreen(g, tri);

    blur.use();
    g.uniform1i(blur.loc("uTex"), 0);
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      // Every level below the first starts as a downsample of the one above,
      // which the linear filter does for free on the way in.
      if (i > 0) {
        bindTarget(g, bloomA[i]);
        g.bindTexture(g.TEXTURE_2D, bloomA[i - 1].texture);
        g.uniform2f(blur.loc("uDirection"), 0, 0);
        drawFullscreen(g, tri);
      }
      bindTarget(g, bloomB[i]);
      g.bindTexture(g.TEXTURE_2D, bloomA[i].texture);
      g.uniform2f(blur.loc("uDirection"), 1 / bloomA[i].width, 0);
      drawFullscreen(g, tri);

      bindTarget(g, bloomA[i]);
      g.bindTexture(g.TEXTURE_2D, bloomB[i].texture);
      g.uniform2f(blur.loc("uDirection"), 0, 1 / bloomA[i].height);
      drawFullscreen(g, tri);
    }
  }

  function renderComposite() {
    bindTarget(g, null, canvas.width, canvas.height);
    composite.use();
    const textures = [scene.texture, bloomA[0].texture, bloomA[1].texture, bloomA[2].texture];
    const names = ["uScene", "uBloom0", "uBloom1", "uBloom2"];
    textures.forEach((tex, i) => {
      g.activeTexture(g.TEXTURE0 + i);
      g.bindTexture(g.TEXTURE_2D, tex);
      g.uniform1i(composite.loc(names[i]), i);
    });
    g.uniform1f(composite.loc("uStrength"), BLOOM_STRENGTH + pulse * 0.35);
    drawFullscreen(g, tri);
    g.activeTexture(g.TEXTURE0);
  }

  function loop(t: number) {
    raf = requestAnimationFrame(loop);
    if (typeof document !== "undefined" && document.hidden) return;

    const offView = Math.abs(azimuth) > 1e-3 || Math.abs(polar - CAM_POLAR) > 1e-3;
    const returning = !interacting && t - interactEnd > 600 && offView;
    // Fill-rate heavy (bloom runs the frame four more times over), so capped
    // lower than the 2D viz: the active rate while playing, dragged or easing
    // back; idle low otherwise.
    const busy = sceneActive || interacting || returning;
    const cap = busy ? Math.min(activeFps(), 40) : Math.min(idleFps(), 12);
    const elapsed = t - lastRender;
    if (elapsed < 1000 / cap - 1) return;
    lastRender = t;

    azimuth += azimuthVel;
    polar = clamp(polar + polarVel, 0.25, Math.PI - 0.25);
    azimuthVel *= 0.9;
    polarVel *= 0.9;
    if (returning) {
      // A beat after a drag ends, ease back to the front view — the clock is
      // unreadable from behind.
      const k = Math.min(1, (elapsed / 1000) * 0.7);
      azimuth += -azimuth * k;
      polar += (CAM_POLAR - polar) * k;
    }

    // Sway (±~40°) only while playing — at the idle cap the motion judders, and a
    // still clock reads better paused anyway.
    //
    // The CAMERA sways, not the set. Turning the row about its own centre swings
    // the near end towards the lens, where perspective magnifies it: the clock
    // then slides out of the left of the frame and back, and the fit has to be
    // loosened until there is dead space at every other phase. Orbiting the camera
    // shows the same angles with the subject nailed to the middle of the frame.
    if (sceneActive) {
      sway = Math.sin(t * 0.00042) * SWAY_RAD;
      reportFrame(elapsed, 1000 / cap);
    }

    const sinP = Math.sin(polar);
    const view = azimuth + sway;
    const eye = [
      sinP * Math.sin(view) * distance,
      Math.cos(polar) * distance,
      sinP * Math.cos(view) * distance,
    ];
    const viewProj = multiply(
      perspective(CAM_FOV, canvas.width / Math.max(1, canvas.height), 0.1, 100),
      lookAt(eye, [0, 0, 0], [0, 1, 0]),
    );

    renderScene(viewProj, eye);
    renderBloom();
    renderComposite();
  }

  raf = requestAnimationFrame(loop);

  // Tab hidden → tear the loop down rather than early-returning each tick, so the
  // scene burns nothing in the background; resume on return.
  const onVis = () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else if (!raf) {
      lastRender = 0;
      raf = requestAnimationFrame(loop);
    }
  };
  document.addEventListener("visibilitychange", onVis);

  return {
    setDigits,
    setOptions(patch) {
      if (patch.color) {
        glowColor = rgb(patch.color);
        opts.color = patch.color;
      }
      if (patch.glass) {
        glassTint = rgb(patch.glass);
        opts.glass = patch.glass;
      }
      if (patch.backdrop) {
        background = darkBackdrop(patch.backdrop);
        opts.backdrop = patch.backdrop;
      }
      if (patch.style && patch.style !== opts.style) {
        opts.style = patch.style;
        squash = nixieStyle(patch.style).squash;
      }
    },
    setPulse(v) {
      pulse = v;
    },
    setActive(v) {
      sceneActive = v;
    },
    resize,
    dispose() {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVis);
      ro?.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      [solid, glass, line, bright, blur, composite].forEach((p) => p.destroy());
      [scene, ...bloomA, ...bloomB].forEach((t) => t.destroy());
      msaa.destroy();
      // Hand the context back NOW: a browser allows only ~16 at a time, and
      // flipping between visualisers otherwise walks over the limit and silently
      // kills whichever one is on screen.
      g.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    },
  };
}

/** What a failed bring-up returns, so callers need no null check. */
function deadScene(canvas: HTMLCanvasElement): NixieScene {
  return {
    setDigits() {},
    setOptions() {},
    setPulse() {},
    setActive() {},
    resize() {},
    dispose() {
      canvas.remove();
    },
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
