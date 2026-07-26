// The WebGL half of the dancer viz: op-art backdrop + echo-trailed dancer,
// after Spaceballs' "State of the Art" (Amiga, 1992).
//
// Both live in one renderer and one canvas — a second WebGL context just to draw
// a background would be wasteful, and compositing two canvases costs a layer.
// The backdrop draws first through an orthographic camera, then the dancer over
// it through a perspective one.
//
// Three things carry the look, and all are deliberate:
//
//   * ECHO TRAIL. The figure is drawn several times, each a frame or two behind
//     the last and slightly smaller, tinted along a gradient. Because the poses
//     differ, the older copies peek out where the limbs *were* — motion blur
//     built from discrete steps, which is what the era's hardware could do.
//   * NO SHADING. Flat unlit colour. These are silhouettes with a tint, not lit
//     objects; any shading breaks it.
//   * STEPPED, NOT SMOOTH. Clip time is quantised to ~12fps so the figure snaps
//     between poses like traced film. Smooth playback reads as "3D model".
//
// three.js is heavy, so this module is lazy-imported by DancerScene.svelte and
// stays out of the main bundle (same arrangement as ./nixie-scene).
import type {
  AnimationClip,
  AnimationMixer,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  WebGLRenderer,
} from "three";

import { BACKDROP_FRAGMENT, BACKDROP_VERTEX } from "./backdrop-shader";

export type SotaOptions = {
  /** Rigged `.fbx`/`.glb` holding one or more dance clips. Null = backdrop only. */
  url: string | null;
  /** Which clip to dance, by index — wrapped, so any number is safe. */
  clip?: number;
  /** Pose steps per second — the rotoscope stutter. 0 = smooth. */
  stepFps?: number;
  /** Number of trailing copies behind the leading figure. */
  echoes?: number;
  /** Seconds each echo lags the one in front. */
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
  /** True once a dancer model is loaded and drawing. */
  hasDancer(): boolean;
  /** How many dances the model carries. */
  clipCount(): number;
  /** Switch dance, by index — wrapped. Cheap: the rig is already loaded. */
  setClip(index: number): void;
  /** Recolour the trail from PALETTES, by index — wrapped. */
  setPalette(index: number): void;
  resize(): void;
  dispose(): void;
};

/** Clip playback rate for a tune at `bpm`, against the dances' natural tempo.
 *
 *  The tempo comes from onset detection, which counts events rather than beats —
 *  a busy pattern in a slow tune reports double or quadruple time, and the dancer
 *  then looks manic under music that's crawling. Anything implausibly fast for a
 *  dance is folded in half before use. Only downwards: a genuinely slow tune
 *  should get a slow dance, which is the whole point.
 *
 *  Unknown tempo (before the first beat) runs at reference speed. */
export function danceRate(bpm: number, refBpm = 125): number {
  if (bpm <= 0) return 1;
  let musical = bpm;
  while (musical > 165) musical /= 2;
  return Math.min(1.5, Math.max(0.3, musical / refBpm));
}

export async function createSotaScene(host: HTMLElement, opts: SotaOptions): Promise<SotaScene> {
  const THREE = await import("three");

  const renderer: WebGLRenderer = new THREE.WebGLRenderer({ antialias: true });
  // Both passes are drawn by hand, so clearing is managed here.
  renderer.autoClear = false;
  host.appendChild(renderer.domElement);
  renderer.domElement.style.cssText = "width:100%;height:100%;display:block";

  // --- backdrop: one full-screen triangle, no camera transform ---------------
  const bgScene: Scene = new THREE.Scene();
  const bgCamera: OrthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const bgMaterial: ShaderMaterial = new THREE.ShaderMaterial({
    vertexShader: BACKDROP_VERTEX,
    fragmentShader: BACKDROP_FRAGMENT,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uRes: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uPulse: { value: 0 },
      uInk: { value: new THREE.Color("#d6d6d6") },
      uPaper: { value: new THREE.Color("#1c1c1c") },
    },
  });
  bgScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMaterial));

  // --- dancer ----------------------------------------------------------------
  const figScene: Scene = new THREE.Scene();
  const camera: PerspectiveCamera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);

  type Echo = {
    root: Object3D;
    mixer: AnimationMixer;
    material: MeshBasicMaterial;
    /** The hip bone, if found, and its world position on the first posed frame —
     *  see the root-motion note in render(). Null until that frame is drawn. */
    hips: Object3D | null;
    anchor: { x: number; z: number } | null;
  };
  const echoes: Echo[] = [];
  let allClips: AnimationClip[] = [];
  let clip: AnimationClip | null = null;
  const wrap = (i: number, n: number) => (n ? ((i % n) + n) % n : 0);
  const hipsWorld = new THREE.Vector3();

  const loadModel = async (url: string): Promise<{ root: Group; clips: AnimationClip[] }> => {
    if (/\.glb$|\.gltf$/i.test(url)) {
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      const gltf = await new GLTFLoader().loadAsync(url);
      return { root: gltf.scene, clips: gltf.animations };
    }
    const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
    const group = await new FBXLoader().loadAsync(url);
    return { root: group, clips: group.animations };
  };

  if (opts.url) {
    // Named export, not a `SkeletonUtils` namespace object.
    const { clone: cloneRig } = await import("three/examples/jsm/utils/SkeletonUtils.js");
    const { root, clips } = await loadModel(opts.url);
    allClips = clips;
    clip = clips[wrap(opts.clip ?? 0, clips.length)] ?? null;
    if (!clip) throw new Error("dancer model has no animation clip");

    const count = Math.max(1, opts.echoes ?? 2) + 1;
    const pal = PALETTES[wrap(opts.palette ?? 0, PALETTES.length)];
    const near = new THREE.Color(opts.colorNear ?? pal[0]);
    const far = new THREE.Color(opts.colorFar ?? pal[1]);

    for (let i = 0; i < count; i++) {
      // Each copy needs its OWN skeleton — a shared one can only hold one pose,
      // so cloning by reference would give every echo the same frame.
      const copy = i === 0 ? root : (cloneRig(root) as Object3D);
      const material = new THREE.MeshBasicMaterial({
        // Oldest (highest i) sits at the far end of the gradient.
        color: near.clone().lerp(far, count === 1 ? 0 : i / (count - 1)),
        side: THREE.DoubleSide,
      });
      copy.traverse((o) => {
        const mesh = o as Mesh & { isMesh?: boolean };
        if (mesh.isMesh) mesh.material = material;
        // A skinned mesh's bounds come from the bind pose, so a reaching
        // animation can get the whole figure culled mid-dance.
        o.frustumCulled = false;
      });
      figScene.add(copy);
      // Mixamo clips usually carry root motion in the hips, which walks the
      // figure out of a fixed camera's frame. Hold onto the bone and its starting
      // position so render() can cancel the horizontal part of that travel.
      let hips: Object3D | null = null;
      copy.traverse((o) => {
        if (!hips && /hips?$/i.test(o.name)) hips = o;
      });
      const start = hips as Object3D | null;
      echoes.push({
        root: copy,
        mixer: new THREE.AnimationMixer(copy),
        material,
        hips: start,
        anchor: null,
      });
      echoes[i].mixer.clipAction(clip).play();
    }

    // Frame on the leading figure. Tight, so it crops at the edges rather than
    // standing small in the middle — how the demo shot its dancers. Height only:
    // the bind pose is a T-pose, and fitting those arms would push the camera
    // miles back for a span the dance never uses.
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const extent = Math.max(size.y, 0.001);
    const dist = (extent * 0.74) / (2 * Math.tan((camera.fov * Math.PI) / 360));
    // Aimed a little above the box centre, so what falls outside the frame is
    // the feet rather than the head — a cropped head reads as a mistake, cropped
    // feet as a close shot.
    const aimY = centre.y + size.y * 0.14;
    camera.position.set(centre.x, aimY, centre.z + dist);
    camera.lookAt(centre.x, aimY, centre.z);
    // Clip planes must follow the model's units: Mixamo exports centimetres, so a
    // figure is ~180 units tall and wants the camera ~370 back — well outside a
    // default far plane, which would clip it away entirely.
    camera.near = Math.max(0.01, dist / 100);
    camera.far = dist + extent * 4;
    camera.updateProjectionMatrix();
  }

  // A full-screen high-contrast moiré that sweeps is a plausible trigger for
  // visual discomfort, so honour the OS setting: the pattern still draws, it just
  // holds still, and the dance keeps its beat-stepped motion without the sweep.
  const calm =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const stepFps = opts.stepFps ?? 12;
  const baseRate = opts.baseRate ?? 1;
  // A short lag keeps the trail tight against the figure — a long one reads as
  // several dancers rather than one in motion.
  const echoLag = opts.echoLag ?? 1 / 55;
  const refBpm = opts.refBpm ?? 125; // the Mixamo house dances sit around here
  const shrink = 0.007;

  let clock = 0;
  let elapsed = 0;
  let pulse = 0;
  let active = true;
  let disposed = false;

  // Theme colours, re-read each frame and only pushed on change — the app can
  // switch light/dark or accent at any time, and a string compare is far cheaper
  // than the alternative of wiring a subscription in here.
  const cssVar = (name: string, fallback: string) => {
    if (typeof getComputedStyle !== "function") return fallback;
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  };
  let lastTheme = "";
  const syncTheme = () => {
    // Ground from the surface token, pattern from the text token — so the
    // relationship holds whichever way round the theme is.
    const paper = cssVar("--halo-bg-light", "#1c1c1c");
    const ink = cssVar("--halo-text-main", "#d6d6d6");
    const accent = cssVar("--accent", "#f78f08");
    const key = paper + ink + accent;
    if (key === lastTheme) return;
    lastTheme = key;
    const paperCol = new THREE.Color(paper);
    // A touch of accent in the pattern, so the backdrop carries the app's hue
    // without becoming a block of it.
    const inkCol = new THREE.Color(ink).lerp(new THREE.Color(accent), 0.18);
    // Then pull the pair toward each other. The theme's surface and text tokens
    // are picked for legible body copy — around a 7:1 luminance ratio — and a
    // dense fringe field at that contrast competes with the figure instead of
    // sitting behind it. Ink gives up more than paper does, so the backdrop settles
    // slightly darker overall and the accent-coloured dancer stays the brightest
    // thing in frame.
    const mid = paperCol.clone().lerp(inkCol, 0.5);
    bgMaterial.uniforms.uPaper.value.copy(paperCol.lerp(mid, 0.22));
    bgMaterial.uniforms.uInk.value.copy(inkCol.lerp(mid, 0.34));
  };

  const render = () => {
    renderer.clear();
    syncTheme();
    // Frozen backdrop clock under reduced motion — the interference is what moves,
    // so holding time still stops the sweep without losing the pattern.
    bgMaterial.uniforms.uTime.value = calm ? 0 : elapsed;
    bgMaterial.uniforms.uPulse.value = calm ? 0 : pulse;
    renderer.render(bgScene, bgCamera);

    if (!echoes.length || !clip) return;

    // Pose every copy first: the leading figure at the quantised time, each echo
    // a fixed lag further back, wrapped into the clip.
    const base = stepFps > 0 ? Math.floor(clock * stepFps) / stepFps : clock;
    for (let i = 0; i < echoes.length; i++) {
      const e = echoes[i];
      const at = (((base - i * echoLag) % clip.duration) + clip.duration) % clip.duration;
      e.mixer.setTime(at);
      // Cancel the clip's horizontal root motion, so the dancer performs on the
      // spot instead of travelling out of a fixed camera's frame. Vertical travel
      // is left alone — that's jumps and weight shifts, which should show.
      //
      // Measured in WORLD space, not the bone's own: a glTF export can leave the
      // armature rotated 90° about X, which makes bone-local Z the vertical axis
      // — cancelling it then launches the figure out of shot. The anchor is the
      // first *posed* frame rather than the bind pose, since a T-pose's hips can
      // sit far from where the dance starts.
      if (e.hips) {
        e.root.position.set(0, 0, 0);
        e.root.updateWorldMatrix(true, true);
        e.hips.getWorldPosition(hipsWorld);
        e.anchor ??= { x: hipsWorld.x, z: hipsWorld.z };
        e.root.position.set(-(hipsWorld.x - e.anchor.x), 0, -(hipsWorld.z - e.anchor.z));
      }
      e.root.scale.setScalar(1 - i * shrink + pulse * 0.02);
      e.root.rotation.z = pulse * 0.05;
    }

    // One pass per copy, oldest first. Depth is cleared between passes so each
    // figure occludes itself correctly while newer ones paint over the top —
    // and only the figure being drawn is visible, or every pass would draw all
    // of them.
    for (let i = echoes.length - 1; i >= 0; i--) {
      for (let j = 0; j < echoes.length; j++) echoes[j].root.visible = j === i;
      renderer.clearDepth();
      renderer.render(figScene, camera);
    }
    for (const e of echoes) e.root.visible = true;
  };

  const resize = () => {
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    const dpr = renderer.getPixelRatio();
    bgMaterial.uniforms.uRes.value.set(w * dpr, h * dpr);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  };

  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => resize()) : null;
  ro?.observe(host);
  resize();

  return {
    advance(dt, bpm) {
      if (disposed || !active) return;
      // The backdrop runs on the same tempo scaling as the dance, so the fringes
      // and the figure breathe together instead of drifting against each other.
      elapsed += dt * danceRate(bpm, refBpm);
      clock += dt * baseRate * danceRate(bpm, refBpm);
      // The backdrop drifts continuously, so there's a frame to draw regardless;
      // the figure's own pose is what's quantised, inside render().
      render();
    },
    setPulse(p) {
      pulse = Math.max(0, Math.min(1, p));
    },
    setActive(on) {
      active = on;
    },
    hasDancer: () => echoes.length > 0,
    clipCount: () => allClips.length,
    setPalette(index) {
      const [n, f] = PALETTES[wrap(index, PALETTES.length)];
      const near = new THREE.Color(n);
      const far = new THREE.Color(f);
      const last = Math.max(1, echoes.length - 1);
      echoes.forEach((e, i) => e.material.color.copy(near).lerp(far, i / last));
    },
    setClip(index) {
      const next = allClips[wrap(index, allClips.length)];
      if (!next || next === clip) return;
      clip = next;
      // Re-point every echo at the new dance; the rig and its clones stay put.
      for (const e of echoes) {
        e.mixer.stopAllAction();
        e.mixer.clipAction(clip).play();
        e.anchor = null; // a different dance starts from a different spot
      }
      clock = 0;
    },
    resize,
    dispose() {
      disposed = true;
      ro?.disconnect();
      for (const e of echoes) {
        e.mixer.stopAllAction();
        e.material.dispose();
        e.root.traverse((o) => {
          (o as Mesh & { geometry?: { dispose(): void } }).geometry?.dispose();
        });
      }
      bgMaterial.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
