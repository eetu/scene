// Paint on a speaker, as a fluid surface — a height-field wave sim (not particles).
// A disc of paint whose height evolves by a driven, damped wave equation, so it's a
// single connected sheet that ripples, sloshes and peaks like real liquid on a
// subwoofer (Faraday-wave cymatics). The audio drives it: each frequency band injects
// upward impulses at its own radius (bass → centre, treble → rim), and beats punch the
// middle, so the paint jumps in time. A restoring pull to flat + damping + a height
// clamp keep it a bounded pool (not a growing mountain). Rendered as a glossy wet
// MeshPhysicalMaterial with a warm-centre→cool-edge colour gradient, reflections +
// bloom; the rim fades to transparent so the pool floats with no hard edge, over a
// theme-coloured backdrop. Owns its own capped loop (like nixie-scene);
// SpeakerPaint.svelte feeds it the per-band levels + beats.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

import { activeFps, idleFps, reportFrame } from "./perf.svelte";

export interface PaintScene {
  /** Five band levels 0..1 (centre→ring = sub-bass→treble). */
  setLevels(levels: Float32Array | number[]): void;
  /** Punch the centre (call on a musical beat). */
  beat(): void;
  /** Playing? Idle-throttles the render loop to save battery. */
  setActive(active: boolean): void;
  /** Follow the app light/dark theme — pass the resolved background colour (CSS). */
  setTheme(bg: string): void;
  resize(): void;
  dispose(): void;
}

const NBAND = 5;
const G = 128; // grid resolution per side (the CPU cost knob: O(G²); finer = smoother disc edge)
const SIZE = 3.0; // world extent of the fluid plane
const DX = SIZE / (G - 1);
const HALF = (G - 1) / 2;
const R_PAINT = 1.28; // paint disc radius (alpha has faded to 0 by here)
const R_DRIVE = 1.05; // keep wave impulses inside this radius so the rim stays low
const C = 180; // wave stiffness (larger = faster ripples)
const GRAV = 20; // restoring pull to flat — bounds the surface, settles it to a pool
const DAMP = 0.985; // per-frame wave damping
const H_MAX = 1.2; // height clamp (world units) — higher = taller splashes

// Paint albedos per band — bold orange→purple, warm lows in the centre, cool highs
// on the rim (the reference's two-tone scheme).
const COLORS = [
  new THREE.Color(0xff2a00),
  new THREE.Color(0xff6a00),
  new THREE.Color(0xffab10),
  new THREE.Color(0x7a30ff),
  new THREE.Color(0x3626ff),
];

export function createPaintScene(container: HTMLElement): PaintScene {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.6;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x040406);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);

  scene.add(new THREE.AmbientLight(0xffffff, 0.25));
  const key = new THREE.DirectionalLight(0xffffff, 0.7);
  key.position.set(-3, 6, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x88aaff, 0.25);
  rim.position.set(4, 2, -5);
  scene.add(rim);

  // The fluid: a flat grid in XZ; we displace each vertex's Y by the wave height and
  // recompute analytic normals each frame for the wet shading.
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, G - 1, G - 1);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const posArr = pos.array as Float32Array;
  const normArr = (geo.attributes.normal as THREE.BufferAttribute).array as Float32Array;
  // Static per-vertex colour by radius (warm centre → cool rim), blended between the
  // band colours; the wave moves the surface, this tints it.
  const colArr = new Float32Array(G * G * 4); // RGBA — the A fades the rim to transparent
  const tmp = new THREE.Color();
  for (let k = 0; k < G * G; k++) {
    const x = posArr[k * 3];
    const z = posArr[k * 3 + 2];
    const rr = Math.hypot(x, z);
    const ang = Math.atan2(z, x);
    // Radius drives the band, with an angular wobble so the colours intermix into
    // organic zones rather than reading as perfect concentric rings.
    const rn = (rr / R_PAINT) * (1 + 0.16 * Math.sin(ang * 3.0) + 0.09 * Math.sin(ang * 7.0 + 1.0));
    const t = Math.min(1, Math.max(0, rn)) * (NBAND - 1);
    const i0 = Math.min(NBAND - 2, Math.floor(t));
    tmp.copy(COLORS[i0]).lerp(COLORS[i0 + 1], t - i0);
    colArr[k * 4] = tmp.r;
    colArr[k * 4 + 1] = tmp.g;
    colArr[k * 4 + 2] = tmp.b;
    // Fade alpha to 0 over the outer rim so the paint dissolves softly into the
    // background — hiding the grid-stepped disc edge with no hard silhouette.
    colArr[k * 4 + 3] = Math.max(0, Math.min(1, (R_PAINT - rr) / 0.28));
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colArr, 4));
  // Render only the triangles inside the paint disc (the sim still runs on the full
  // square grid), so there's no flat square corner — just a clean paint disc.
  const idx: number[] = [];
  for (let j = 0; j < G - 1; j++) {
    for (let i = 0; i < G - 1; i++) {
      if (Math.hypot((i + 0.5 - HALF) * DX, (j + 0.5 - HALF) * DX) > R_PAINT) continue;
      const a = j * G + i;
      const b = a + 1;
      const c = a + G;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  geo.setIndex(idx);
  const paintMat = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    transparent: true, // vertex alpha feathers the rim to nothing (hides the disc edge)
    metalness: 0,
    roughness: 0.28,
    clearcoat: 0.7,
    clearcoatRoughness: 0.14,
    envMapIntensity: 0.4,
    side: THREE.DoubleSide,
  });
  const fluid = new THREE.Mesh(geo, paintMat);
  scene.add(fluid);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.16, 0.4, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // Wave state: height + vertical velocity per grid cell (row-major, k = j·G + i).
  const h = new Float32Array(G * G);
  const v = new Float32Array(G * G);
  // Rim mask: 1 well inside the disc, feathering to 0 at the rim + border, so waves
  // are absorbed at the edge (no reflection) and nothing lives outside the disc.
  const rimMask = new Float32Array(G * G);
  for (let j = 0; j < G; j++) {
    for (let i = 0; i < G; i++) {
      const k = j * G + i;
      if (i === 0 || j === 0 || i === G - 1 || j === G - 1) continue;
      const rr = Math.hypot((i - HALF) * DX, (j - HALF) * DX);
      rimMask[k] = Math.max(0, Math.min(1, (R_PAINT - rr) / 0.36)); // wide feather → the paint thins to nothing at the rim
    }
  }

  // Add an upward velocity impulse in a small disc around a world point (a splash
  // source). cx,cz in world; rad in cells.
  function impulse(cx: number, cz: number, amp: number, rad: number) {
    const ci = Math.round(cx / DX + HALF);
    const cj = Math.round(cz / DX + HALF);
    const r2 = rad * rad;
    for (let dj = -rad; dj <= rad; dj++) {
      const j = cj + dj;
      if (j < 1 || j >= G - 1) continue;
      for (let di = -rad; di <= rad; di++) {
        const i = ci + di;
        if (i < 1 || i >= G - 1) continue;
        const d2 = di * di + dj * dj;
        if (d2 > r2) continue;
        v[j * G + i] += amp * (1 - d2 / r2);
      }
    }
  }

  const motion = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0.5 : 1.0;

  // Drag to look around (like the nixie scene); it auto-orbits slowly when idle.
  camera.position.set(0, 2.0, 5.4);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 3;
  controls.maxDistance = 9;
  controls.maxPolarAngle = Math.PI * 0.49; // stay above the pool
  controls.target.set(0, 0.6, 0); // a bit higher so the tall central spike is framed
  controls.autoRotate = motion >= 1;
  controls.autoRotateSpeed = 0.6;
  controls.update();

  const levels = new Float32Array(NBAND);
  let beatPulse = 0;
  let pendingKick = false;
  let sceneActive = true;
  let raf = 0;
  let lastRender = 0;
  let lastT = 0;
  let idleSince = 0;
  let bloomBase = 0.16; // lower on a light theme (bloom washes out on white)
  const SETTLE_MS = 1500;
  const TAU = Math.PI * 2;

  function step(dt: number) {
    beatPulse *= Math.exp(-dt / 0.2);
    const kick = pendingKick;
    pendingKick = false;

    // Drive: inject impulses per band at its own radius ring; a beat punches the
    // centre. Only while playing (paused → the wave just damps out to flat).
    if (sceneActive) {
      const f = dt * 60; // normalise impulse magnitude to a 60fps step
      // Sustained central push from the sub-bass → a tall central column that rises
      // with the low end (the height clamp caps it), plus a sharp punch on each beat.
      if (levels[0] > 0.08) {
        // A small jittered cluster (not one dead-centre point) so the central column
        // erupts rough + churning rather than as a smooth symmetric "lipstick".
        const amp = levels[0] * levels[0] * 2.3 * motion * f;
        for (let n = 0; n < 3; n++) {
          const jr = Math.random() * 0.16;
          const ja = Math.random() * TAU;
          impulse(Math.cos(ja) * jr, Math.sin(ja) * jr, amp, 2);
        }
      }
      if (kick)
        impulse((Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.12, 3.8 * motion * f, 3);
      for (let bnd = 0; bnd < NBAND; bnd++) {
        const lvl = levels[bnd] * motion;
        if (lvl < 0.03) continue;
        const nImp = 1 + Math.floor(lvl * lvl * 3);
        const r0 = (bnd / NBAND) * R_DRIVE;
        const r1 = ((bnd + 1) / NBAND) * R_DRIVE;
        for (let n = 0; n < nImp; n++) {
          const rr = r0 + Math.random() * (r1 - r0);
          const a = Math.random() * TAU;
          impulse(Math.cos(a) * rr, Math.sin(a) * rr, (0.3 + 1.6 * lvl) * f, 2);
        }
      }
    }

    // Driven damped wave: v += (c²·∇²h − GRAV·h)·dt, damped; the −GRAV·h restoring
    // term is what keeps it a bounded pool instead of inflating off screen.
    const sdt = Math.min(dt, 0.02);
    for (let j = 1; j < G - 1; j++) {
      for (let i = 1; i < G - 1; i++) {
        const k = j * G + i;
        const lap = h[k - 1] + h[k + 1] + h[k - G] + h[k + G] - 4 * h[k];
        v[k] = (v[k] + (lap * C - h[k] * GRAV) * sdt) * DAMP;
      }
    }
    for (let k = 0; k < G * G; k++) {
      let nh = (h[k] + v[k] * sdt) * rimMask[k]; // absorb at the rim; zero outside the disc
      // Soft (tanh) saturation instead of a hard cap → tall peaks taper to a point
      // rather than clipping to a flat plateau; bleed velocity near the top so energy
      // doesn't pile up under the ceiling.
      nh = nh > 0 ? H_MAX * Math.tanh(nh / H_MAX) : -0.7 * H_MAX * Math.tanh(-nh / (0.7 * H_MAX));
      if (Math.abs(nh) > 0.8 * H_MAX) v[k] *= 0.9;
      h[k] = nh;
    }

    // Push heights to the mesh + analytic normals from the height gradient.
    const inv2dx = 1 / (2 * DX);
    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) {
        const k = j * G + i;
        posArr[k * 3 + 1] = h[k];
        const hl = i > 0 ? h[k - 1] : h[k];
        const hr = i < G - 1 ? h[k + 1] : h[k];
        const hd = j > 0 ? h[k - G] : h[k];
        const hu = j < G - 1 ? h[k + G] : h[k];
        let nx = (hl - hr) * inv2dx;
        let nz = (hd - hu) * inv2dx;
        const nl = Math.hypot(nx, 1, nz) || 1;
        nx /= nl;
        nz /= nl;
        normArr[k * 3] = nx;
        normArr[k * 3 + 1] = 1 / nl;
        normArr[k * 3 + 2] = nz;
      }
    }
    pos.needsUpdate = true;
    (geo.attributes.normal as THREE.BufferAttribute).needsUpdate = true;
    bloom.strength = bloomBase + beatPulse * 0.2;
  }

  function loop(t: number) {
    raf = requestAnimationFrame(loop);
    if (typeof document !== "undefined" && document.hidden) return;
    // Keep the active cap for a settle window after pause so the wave damps out
    // smoothly before we throttle to the idle cap.
    let settling = false;
    if (!sceneActive) {
      if (!idleSince) idleSince = t;
      if (t - idleSince <= SETTLE_MS) settling = true;
    } else {
      idleSince = 0;
    }
    const cap = sceneActive || settling ? Math.min(activeFps(), 45) : Math.min(idleFps(), 12);
    const elapsed = t - lastRender;
    if (elapsed < 1000 / cap - 1) return;
    const dt = Math.min((t - lastT) / 1000, 0.05);
    lastT = t;
    lastRender = t;

    controls.update(); // damping + slow auto-orbit + any user drag
    step(dt);

    // Bass punch-in + a quick beat shake, applied ONLY for this frame's render (then
    // restored) so the OrbitControls state isn't disturbed. The dolly nudges toward
    // the target on heavy low end; the shake is a short jolt on each beat.
    const bx = camera.position.x;
    const by = camera.position.y;
    const bz = camera.position.z;
    const zoom = levels[0] * 0.09 * motion;
    camera.position.x += (controls.target.x - bx) * zoom;
    camera.position.y += (controls.target.y - by) * zoom;
    camera.position.z += (controls.target.z - bz) * zoom;
    const sh = beatPulse * beatPulse * 0.055 * motion;
    camera.position.x += (Math.random() - 0.5) * sh;
    camera.position.y += (Math.random() - 0.5) * sh;
    composer.render();
    camera.position.set(bx, by, bz);
    if (sceneActive) reportFrame(elapsed, 1000 / cap);
  }

  function resize() {
    const w = Math.max(1, container.clientWidth);
    const hgt = Math.max(1, container.clientHeight);
    renderer.setSize(w, hgt, false);
    composer.setSize(w, hgt);
    bloom.setSize(w, hgt);
    camera.aspect = w / hgt;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(() => resize());
  ro.observe(container);
  resize();
  lastT = performance.now();
  raf = requestAnimationFrame(loop);

  const onVis = () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else if (!raf) {
      lastRender = 0;
      lastT = performance.now();
      raf = requestAnimationFrame(loop);
    }
  };
  document.addEventListener("visibilitychange", onVis);

  return {
    setLevels(l) {
      for (let i = 0; i < NBAND; i++) levels[i] = l[i] ?? 0;
    },
    beat() {
      beatPulse = 1;
      pendingKick = true;
    },
    setActive(a) {
      sceneActive = a;
    },
    setTheme(bg) {
      const c = new THREE.Color(bg);
      scene.background = c;
      const light = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b > 0.5;
      // Less bloom + more exposure on light (an additive glow washes out over white),
      // and less reflection so the paint colours stay rich rather than pastel.
      paintMat.envMapIntensity = light ? 0.2 : 0.4;
      bloomBase = light ? 0.04 : 0.16;
      renderer.toneMappingExposure = light ? 0.5 : 0.6;
    },
    resize,
    dispose() {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVis);
      ro.disconnect();
      controls.dispose();
      geo.dispose();
      paintMat.dispose();
      envTex.dispose();
      pmrem.dispose();
      composer.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
