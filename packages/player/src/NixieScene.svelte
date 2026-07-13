<script lang="ts">
  // A 3D nixie-tube scene visualiser: five glass tubes standing on a table,
  // MM:SS of play time glowing inside them, the whole set gently rotating. Built
  // on three.js (lazy-loaded — it's a big dep kept out of the main bundle via the
  // dynamic import below). Each digit is a real @glowbox/nixie numeral rendered to
  // an off-screen canvas and textured (additively, so only the glow shows) onto a
  // plane inside its glass cylinder. The glass is partially transparent, so you
  // see through the front tubes to the ones behind; it flushes toward the theme
  // accent on the bass. Idle settles to dark glass and the time holds.
  import { createNixieTube, type NixieTube } from "@glowbox/nixie";
  import type * as THREE from "three";
  import { onMount } from "svelte";

  import { playback, sampleBands } from "./player.svelte";
  import { driveFrames } from "./raf";

  let { active = true }: { active?: boolean } = $props();

  let host: HTMLDivElement;
  let canvasEl: HTMLCanvasElement;
  let sink: HTMLDivElement; // holds the (off-screen) nixie source canvases

  // MM:SS → five slots; the middle one is the (slimmer) colon tube.
  const LAYOUT = [
    { colon: false },
    { colon: false },
    { colon: true },
    { colon: false },
    { colon: false },
  ];

  onMount(() => {
    let stopped = false;
    let cleanup: (() => void) | null = null;

    void (async () => {
      const T = await import("three");
      if (stopped) return;

      const renderer = new T.WebGLRenderer({ canvas: canvasEl, antialias: true });
      renderer.setClearColor(0x05060a, 1);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

      const scene = new T.Scene();
      const camera = new T.PerspectiveCamera(42, 1, 0.1, 100);
      camera.position.set(0, 1.3, 6.6);
      camera.lookAt(0, 0.05, 0);

      scene.add(new T.AmbientLight(0x8895b8, 0.7));
      const key = new T.DirectionalLight(0xffffff, 0.85);
      key.position.set(2.5, 5, 3);
      scene.add(key);
      const accentLight = new T.PointLight(0xff9a2e, 0, 24);
      accentLight.position.set(0, 0.6, 2.4);
      scene.add(accentLight);

      const group = new T.Group();
      scene.add(group);

      // Table the tubes stand on.
      const table = new T.Mesh(
        new T.CylinderGeometry(3.2, 3.5, 0.32, 48),
        new T.MeshStandardMaterial({ color: 0x0b0d13, roughness: 0.55, metalness: 0.35 }),
      );
      table.position.y = -1.06;
      group.add(table);

      // Shared, partially-transparent glass (pulsed via .emissive). depthWrite off
      // so the tubes behind show through the front ones.
      const glass = new T.MeshStandardMaterial({
        color: 0x2b3a4d,
        roughness: 0.12,
        metalness: 0,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
      });
      const capMat = new T.MeshStandardMaterial({
        color: 0x1a1e26,
        roughness: 0.4,
        metalness: 0.6,
      });

      const H = 1.75;
      const gap = 1.16;
      const x0 = -((LAYOUT.length - 1) * gap) / 2;
      type Slot = { tube: NixieTube; tex: THREE.CanvasTexture; last: string };
      const slots: Slot[] = [];
      const geoms: THREE.BufferGeometry[] = [];

      LAYOUT.forEach((L, i) => {
        const r = L.colon ? 0.28 : 0.52;
        const x = x0 + i * gap;

        const cylGeo = new T.CylinderGeometry(r, r, H, 40, 1, true);
        geoms.push(cylGeo);
        const cyl = new T.Mesh(cylGeo, glass);
        cyl.position.x = x;
        group.add(cyl);

        for (const [yy, rt, rb, hh] of [
          [-H / 2, r * 1.15, r * 1.25, 0.18],
          [H / 2, r * 1.05, r * 1.12, 0.12],
        ] as const) {
          const g = new T.CylinderGeometry(rt, rb, hh, 28);
          geoms.push(g);
          const cap = new T.Mesh(g, capMat);
          cap.position.set(x, yy, 0);
          group.add(cap);
        }

        // Off-screen nixie canvas → additive glow texture on a plane inside the tube.
        const c = document.createElement("canvas");
        c.style.cssText = `display:block;width:${L.colon ? 72 : 132}px;height:210px`;
        sink.appendChild(c);
        const tube = createNixieTube(c, {
          value: L.colon ? ":" : "0",
          style: "tall",
          glow: 0.95,
          mesh: false,
          ghost: false,
          background: [0.008, 0.008, 0.012],
        })!;
        tube.resize(); // force an initial draw at the canvas box size

        const tex = new T.CanvasTexture(c);
        tex.colorSpace = T.SRGBColorSpace;
        const planeGeo = new T.PlaneGeometry(L.colon ? 0.5 : 0.84, 1.34);
        geoms.push(planeGeo);
        const plane = new T.Mesh(
          planeGeo,
          new T.MeshBasicMaterial({
            map: tex,
            transparent: true,
            blending: T.AdditiveBlending,
            depthWrite: false,
          }),
        );
        plane.position.set(x, 0, 0.001);
        group.add(plane);

        slots.push({ tube, tex, last: "" });
      });

      function resize() {
        const w = host.clientWidth || 1;
        const h = host.clientHeight || 1;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(host);

      const accent = new T.Color(0xff9a2e);
      const tmp = new T.Color();
      const readAccent = () => {
        const raw = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
        if (raw) {
          try {
            accent.set(raw);
          } catch {
            /* keep last */
          }
        }
      };
      readAccent();

      let pulse = 0;
      let t = 0;
      const stopFrames = driveFrames(
        (dt) => {
          readAccent();
          pulse = Math.max(active ? sampleBands().bass : 0, pulse - dt * 1.6);
          t += dt;
          group.rotation.y = Math.sin(t * 0.25) * 0.85; // gentle sway — always readable

          glass.emissive.copy(tmp.copy(accent).multiplyScalar(0.55 * pulse));
          glass.opacity = 0.16 + 0.12 * pulse;
          accentLight.color.copy(accent);
          accentLight.intensity = 0.35 + 1.7 * pulse;

          const total = Math.max(0, Math.floor(playback.position || 0));
          const mm = Math.min(99, Math.floor(total / 60))
            .toString()
            .padStart(2, "0");
          const s = `${mm}:${(total % 60).toString().padStart(2, "0")}`;
          for (let i = 0; i < slots.length; i++) {
            const ch = s[i] ?? "";
            if (ch !== slots[i].last) {
              slots[i].tube.setValue(ch);
              slots[i].last = ch;
            }
            slots[i].tex.needsUpdate = true;
          }
          renderer.render(scene, camera);
        },
        { fps: () => (active ? 60 : 30) },
      );

      cleanup = () => {
        stopFrames();
        ro.disconnect();
        slots.forEach((sl) => {
          sl.tube.dispose();
          sl.tex.dispose();
        });
        geoms.forEach((g) => g.dispose());
        glass.dispose();
        capMat.dispose();
        renderer.dispose();
        sink.replaceChildren();
      };
    })();

    return () => {
      stopped = true;
      cleanup?.();
    };
  });
</script>

<div class="nixie-scene" bind:this={host} data-testid="nixie-scene">
  <canvas bind:this={canvasEl}></canvas>
  <div class="sink" bind:this={sink} aria-hidden="true"></div>
</div>

<style>
  .nixie-scene {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #05060a;
  }
  .nixie-scene canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
  /* Off-screen source canvases for the nixie digit textures. */
  .sink {
    position: absolute;
    left: -99999px;
    top: 0;
    width: 1px;
    height: 1px;
    overflow: hidden;
  }
</style>
