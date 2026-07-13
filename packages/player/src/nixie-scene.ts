// A 3D nixie clock: real bent-wire cathodes inside refractive glass tubes on a
// stand, orbiting. Ported from the glowbox svelte-gallery example (finetuned
// there) — everything nixie-specific comes from @glowbox/nixie: the full cathode
// stack (`nixieCathodes`, every numeral present, one lit), the wire thickness +
// squash (`nixieStyle`), the honeycomb anode grille (`nixieMesh`), the separator
// paths (`glyphPath`) and the wire colour (`NIXIE_WIRE_COLOR`). This file owns the
// 3D part: extruding those paths into geometry, the glass, and the bloom. The only
// scene-app addition is `setPulse` — the player feeds bass energy in to throb the
// glow + bloom with the music.
import {
  GLYPH_VIEWBOX,
  glyphPath,
  NIXIE_WIRE_COLOR,
  nixieCathodes,
  nixieMesh,
  nixieStyle,
} from "@glowbox/nixie";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { SVGLoader } from "three/addons/loaders/SVGLoader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

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
  /** Playing? Idle-throttles the (fill-rate-heavy) render loop to save battery. */
  setActive(active: boolean): void;
  resize(): void;
  dispose(): void;
}

// Tube dimensions (world units).
const DIGIT_TUBE_R = 0.62;
const COLON_TUBE_R = 0.34;
const TUBE_H = 2.05;
const CONTENT_H = 2.95; // full vertical extent (base → domed top) for camera framing
const GAP = 0.14;
// Fit a numeral comfortably inside the glass: cap width to the inner diameter and
// height to a fraction of the tube, so nothing overflows the glass.
const INNER_R = DIGIT_TUBE_R * 0.72;
const S = Math.min((INNER_R * 2) / GLYPH_VIEWBOX.width, (TUBE_H * 0.6) / GLYPH_VIEWBOX.height);
// Wire radius from the component's stroke width (classic gauge; squash conveys style live).
const WIRE_R = nixieStyle("classic").strokeWidth * S * 0.28;
const STACK_SPACING = 0.055; // z gap between adjacent cathodes (tight, like a real tube)
const FRONT_Z = 4.5 * STACK_SPACING; // z of the frontmost cathode (depth 0)

const GLOW_INTENSITY = 3.4; // base emissive of the lit numeral
const BLOOM_STRENGTH = 1.1;

const isColonSlot = (i: number) => i === 2 || i === 5;

// Map a glyph-viewBox point (y-down) into world space at depth z.
const toWorld = (px: number, py: number, z: number) =>
  new THREE.Vector3((px - GLYPH_VIEWBOX.width / 2) * S, -(py - GLYPH_VIEWBOX.height / 2) * S, z);

// Lazy SVGLoader shim (addons ship loose types across versions).
let _svg: SVGLoaderLike | null = null;
interface SVGLoaderLike {
  parse(text: string): {
    paths: { subPaths: { getPoints(divisions: number): THREE.Vector2[] }[] }[];
  };
}
function svgLoader(): SVGLoaderLike {
  if (!_svg) _svg = new SVGLoader() as unknown as SVGLoaderLike;
  return _svg;
}

// Extrude a glyph's SVG centreline into merged tube geometry (cached per symbol).
function tubeFromPath(d: string): THREE.BufferGeometry | null {
  const parsed = svgLoader().parse(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GLYPH_VIEWBOX.width} ${GLYPH_VIEWBOX.height}"><path d="${d}"/></svg>`,
  );
  const parts: THREE.BufferGeometry[] = [];
  for (const path of parsed.paths) {
    for (const sub of path.subPaths) {
      const pts = sub.getPoints(40);
      if (pts.length < 2) continue;
      const v3 = pts.map((p) => toWorld(p.x, p.y, 0));
      const curve = new THREE.CatmullRomCurve3(v3, false, "centripetal");
      parts.push(new THREE.TubeGeometry(curve, Math.max(20, v3.length), WIRE_R, 6, false));
    }
  }
  if (!parts.length) return null;
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

// The honeycomb anode grille (from the component's mesh layout), as line segments.
function grilleGeometry(): THREE.BufferGeometry {
  const { radius, cells } = nixieMesh(GLYPH_VIEWBOX.width, GLYPH_VIEWBOX.height);
  const pos: number[] = [];
  for (const c of cells) {
    const verts: THREE.Vector3[] = [];
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 6 + (i * Math.PI) / 3;
      verts.push(toWorld(c.x + radius * Math.cos(a), c.y + radius * Math.sin(a), 0));
    }
    for (let i = 0; i < 6; i++) {
      const p0 = verts[i];
      const p1 = verts[(i + 1) % 6];
      pos.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  return geo;
}

// Glass envelope as a revolved profile: straight wall with a convex domed top,
// open at the bottom where the metal base sits. One surface → clean refraction.
function domedTubeGeometry(r: number, radial: number): THREE.LatheGeometry {
  const domeRise = r * 0.62;
  const pts: THREE.Vector2[] = [
    new THREE.Vector2(r, -TUBE_H / 2),
    new THREE.Vector2(r, TUBE_H / 2),
  ];
  const steps = 9;
  for (let i = 1; i <= steps; i++) {
    const t = (i / steps) * (Math.PI / 2);
    pts.push(new THREE.Vector2(r * Math.cos(t), TUBE_H / 2 + domeRise * Math.sin(t)));
  }
  return new THREE.LatheGeometry(pts, radial);
}

interface DigitTube {
  kind: "digit";
  cathodes: Map<string, THREE.Mesh>;
  lit: string | null;
}
type Tube = DigitTube | { kind: "colon" };

// The scene background: the chosen backdrop, capped dark (max channel ≤ 0.14, hue
// preserved) so a bright page can't wash the transmissive tubes out.
function darkBackdrop(hex: string): THREE.Color {
  const c = new THREE.Color(hex);
  const m = Math.max(c.r, c.g, c.b);
  if (m > 0.14) c.multiplyScalar(0.14 / m);
  return c;
}

export function createNixieScene(container: HTMLElement, opts: NixieSceneOptions): NixieScene {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.transmissionResolutionScale = 0.5;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";

  const scene = new THREE.Scene();
  scene.background = darkBackdrop(opts.backdrop);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(0, 0.9, 10.5);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  // No full auto-rotate — the clock is unreadable from behind. Instead the whole
  // set sways gently side to side (see the loop), keeping the faces toward the
  // camera; the user can still drag to look around.
  controls.autoRotate = false;
  controls.enablePan = false;
  controls.minDistance = 6;
  controls.maxDistance = 40;
  controls.target.set(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.28));
  const key = new THREE.DirectionalLight(0xffffff, 0.34);
  key.position.set(4, 6, 5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8fb4ff, 0.18);
  rim.position.set(-5, 2, -4);
  scene.add(rim);

  const glowMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(opts.color).multiplyScalar(0.2),
    emissive: new THREE.Color(opts.color),
    emissiveIntensity: GLOW_INTENSITY,
    roughness: 0.45,
    metalness: 0,
  });
  const wireMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(...NIXIE_WIRE_COLOR).multiplyScalar(0.11),
    roughness: 0.82,
    metalness: 0.2,
    envMapIntensity: 0.14,
  });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xeef2f7,
    metalness: 0,
    roughness: 0.06,
    transmission: 1,
    thickness: 0.3,
    ior: 1.22,
    opacity: 1,
    transparent: true,
    attenuationColor: new THREE.Color(opts.glass),
    attenuationDistance: 1.4,
    envMapIntensity: 0.12,
    specularIntensity: 0.3,
  });
  const metalMat = new THREE.MeshStandardMaterial({
    color: 0x24262d,
    roughness: 0.5,
    metalness: 0.6,
  });
  const grilleMat = new THREE.LineBasicMaterial({ color: 0x4a4e58 });
  const standMat = new THREE.MeshStandardMaterial({
    color: 0x17181d,
    roughness: 0.6,
    metalness: 0.4,
  });

  const wireGeo = new Map<string, THREE.BufferGeometry | null>();
  const geomFor = (symbol: string, d: string): THREE.BufferGeometry | null => {
    if (!wireGeo.has(symbol)) wireGeo.set(symbol, d ? tubeFromPath(d) : null);
    return wireGeo.get(symbol) ?? null;
  };
  const grilleGeo = grilleGeometry();
  const glassGeoDigit = domedTubeGeometry(DIGIT_TUBE_R, 32);
  const glassGeoColon = domedTubeGeometry(COLON_TUBE_R, 24);
  const baseGeoDigit = new THREE.CylinderGeometry(
    DIGIT_TUBE_R * 1.05,
    DIGIT_TUBE_R * 1.15,
    0.24,
    24,
  );
  const baseGeoColon = new THREE.CylinderGeometry(COLON_TUBE_R * 1.1, COLON_TUBE_R * 1.2, 0.24, 20);

  const root = new THREE.Group();
  scene.add(root);
  let tubes: Tube[] = [];
  let contentW = 12;

  function tubeShell(group: THREE.Group, colon: boolean) {
    const glass = new THREE.Mesh(colon ? glassGeoColon : glassGeoDigit, glassMat);
    glass.renderOrder = 3;
    group.add(glass);
    const base = new THREE.Mesh(colon ? baseGeoColon : baseGeoDigit, metalMat);
    base.position.y = -TUBE_H / 2 - 0.06;
    group.add(base);
  }

  function layout(n: number) {
    for (const c of [...root.children]) root.remove(c);
    tubes = [];
    const [sx, sy] = nixieStyle(opts.style).squash;
    const cathodeSpec = nixieCathodes();

    const widths = Array.from({ length: n }, (_, i) =>
      isColonSlot(i) ? COLON_TUBE_R * 2 : DIGIT_TUBE_R * 2,
    );
    const total = widths.reduce((a, w) => a + w + GAP, -GAP);
    contentW = total + 0.4;
    let x = -total / 2;

    for (let i = 0; i < n; i++) {
      const colon = isColonSlot(i);
      const cx = x + widths[i] / 2;
      x += widths[i] + GAP;

      const group = new THREE.Group();
      group.position.x = cx;
      root.add(group);
      tubeShell(group, colon);

      if (colon) {
        const d = glyphPath(":");
        if (d) {
          const g = geomFor(":", d);
          if (g) group.add(new THREE.Mesh(g, glowMat));
        }
        tubes.push({ kind: "colon" });
        continue;
      }

      const stack = new THREE.Group();
      stack.scale.set(sx, sy, 1);
      group.add(stack);
      const cathodes = new Map<string, THREE.Mesh>();
      for (const c of cathodeSpec) {
        const g = geomFor(c.symbol, c.path);
        if (!g) continue;
        const m = new THREE.Mesh(g, wireMat);
        m.position.set(c.offset[0] * S, -c.offset[1] * S, FRONT_Z - c.depth * STACK_SPACING);
        stack.add(m);
        cathodes.set(c.symbol, m);
      }
      const grille = new THREE.LineSegments(grilleGeo, grilleMat);
      grille.renderOrder = 2;
      group.add(grille);

      tubes.push({ kind: "digit", cathodes, lit: null });
    }

    const stand = new THREE.Mesh(new THREE.BoxGeometry(total + 1.0, 0.34, 1.5), standMat);
    stand.position.y = -TUBE_H / 2 - 0.24;
    root.add(stand);
  }

  function setDigits(digits: string[]) {
    if (tubes.length !== digits.length) layout(digits.length);
    for (let i = 0; i < digits.length; i++) {
      const t = tubes[i];
      if (t.kind !== "digit") continue;
      const sym = digits[i];
      if (sym === t.lit) continue;
      if (t.lit) {
        const prev = t.cathodes.get(t.lit);
        if (prev) prev.material = wireMat;
      }
      const next = t.cathodes.get(sym);
      if (next) next.material = glowMat;
      t.lit = next ? sym : null;
    }
  }

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), BLOOM_STRENGTH, 0.5, 0.55);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  let pulse = 0;
  let sceneActive = true;
  let raf = 0;
  let lastRender = 0;
  // Fill-rate heavy (transmission + bloom), so cap tightly: ~36fps playing, and
  // idle right down when paused/stopped to spare the battery on an always-on tab.
  function loop(t: number) {
    raf = requestAnimationFrame(loop);
    if (typeof document !== "undefined" && document.hidden) return;
    // Follow the shared policy, but cap this fill-rate-heavy scene lower (≤40
    // playing, ≤12 idle) than the light 2D viz.
    const cap = sceneActive ? Math.min(activeFps(), 40) : Math.min(idleFps(), 12);
    const elapsed = t - lastRender;
    if (elapsed < 1000 / cap - 1) return;
    lastRender = t;
    // Sway (±~40°, faces toward the camera) only while playing — at the idle fps
    // cap the motion judders, and a still clock reads better paused anyway.
    if (sceneActive) {
      root.rotation.y = Math.sin(t * 0.00042) * 0.72;
      reportFrame(elapsed, 1000 / cap); // feed the adaptive controller
    }
    // Subtle beat response (the disco ball owns "flashy"): a gentle lift of the
    // glow + bloom on the bass, and a faint accent bloom in the glass tint so the
    // tubes breathe with the music without strobing.
    glowMat.emissiveIntensity = GLOW_INTENSITY * (1 + pulse * 0.3);
    bloom.strength = BLOOM_STRENGTH + pulse * 0.4;
    glassMat.emissive.copy(glowMat.emissive).multiplyScalar(pulse * 0.08);
    const moved = controls.update();
    // Idle + settled + not being dragged → nothing changed, so skip the heavy
    // transmission + bloom render entirely (big battery saving on an always-on tab).
    if (sceneActive || pulse >= 0.005 || moved) composer.render();
  }

  function frameContent() {
    const vfov = (camera.fov * Math.PI) / 180;
    const halfTan = Math.tan(vfov / 2);
    const fitH = CONTENT_H / 2 / halfTan;
    const fitW = contentW / 2 / (halfTan * camera.aspect);
    const dist = THREE.MathUtils.clamp(
      Math.max(fitH, fitW) * 1.1,
      controls.minDistance,
      controls.maxDistance,
    );
    const dir = camera.position.clone().sub(controls.target).normalize();
    camera.position.copy(controls.target).addScaledVector(dir, dist);
    controls.update();
  }

  function resize() {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    bloom.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    frameContent();
  }
  const ro = new ResizeObserver(() => resize());
  ro.observe(container);

  setDigits(opts.digits);
  resize();
  raf = requestAnimationFrame(loop);

  return {
    setDigits,
    setOptions(patch) {
      if (patch.color) {
        glowMat.emissive.set(patch.color);
        glowMat.color.set(patch.color).multiplyScalar(0.2);
        opts.color = patch.color;
      }
      if (patch.glass) {
        glassMat.attenuationColor.set(patch.glass);
        opts.glass = patch.glass;
      }
      if (patch.backdrop) {
        scene.background = darkBackdrop(patch.backdrop);
        opts.backdrop = patch.backdrop;
      }
      if (patch.style && patch.style !== opts.style) {
        opts.style = patch.style;
        const [sx, sy] = nixieStyle(opts.style).squash;
        for (const g of root.children) {
          const stack = g.children?.find((c) => c instanceof THREE.Group) as
            THREE.Group | undefined;
          stack?.scale.set(sx, sy, 1);
        }
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
      ro.disconnect();
      controls.dispose();
      wireGeo.forEach((g) => g?.dispose());
      [grilleGeo, glassGeoDigit, glassGeoColon, baseGeoDigit, baseGeoColon].forEach((g) =>
        g.dispose(),
      );
      [glowMat, wireMat, glassMat, metalMat, grilleMat, standMat].forEach((m) => m.dispose());
      envTex.dispose();
      pmrem.dispose();
      composer.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
