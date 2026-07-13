<script lang="ts">
  // A 3D nixie-tube scene visualiser: glass tubes standing on a table showing play
  // time as a live MM:SS:CC stopwatch (the centisecond pair are smaller sub-tubes),
  // the whole set gently swaying. Built on three.js (lazy-loaded — a big dep kept
  // out of the main bundle via the dynamic import below). Each digit is a real
  // @glowbox/nixie numeral rendered to an off-screen canvas and textured
  // (additively, so only the glow shows) onto a plane inside its glass cylinder.
  // The glass is partially transparent, so you see through the front tubes to the
  // ones behind; it flushes toward the theme accent on the bass. The time runs off
  // a smooth local clock (advanced by frame dt, re-synced to playback.position on a
  // seek) so the ms stay fluid despite the decoder's coarser updates.
  import { createNixieTube, type NixieTube } from "@glowbox/nixie";
  import type * as THREE from "three";
  import { onMount } from "svelte";

  import { playback, sampleBands } from "./player.svelte";
  import { driveFrames } from "./raf";

  let { active = true }: { active?: boolean } = $props();

  let host: HTMLDivElement;
  let canvasEl: HTMLCanvasElement;
  let sink: HTMLDivElement; // holds the (off-screen) nixie source canvases

  // MM:SS:CC → eight slots; the two `:` are slimmer, and the trailing CC pair are
  // smaller "sub-counter" tubes.
  type Kind = { colon?: boolean; ms?: boolean };
  const LAYOUT: Kind[] = [
    {},
    {},
    { colon: true },
    {},
    {},
    { colon: true, ms: true },
    { ms: true },
    { ms: true },
  ];
  const radiusOf = (k: Kind) => (k.colon ? (k.ms ? 0.17 : 0.28) : k.ms ? 0.33 : 0.52);
  const heightOf = (k: Kind) => (k.ms ? 1.12 : 1.75);

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
      camera.position.set(0, 1.3, 7);
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

      // (the metal base plate is built below, once the row width is known)

      // Clearcoat glass — a glossy specular layer over faint transparent glass,
      // for the bright dome highlights. Pulsed toward the accent via .emissive.
      const glass = new T.MeshPhysicalMaterial({
        color: 0x2b3a4d,
        roughness: 0.08,
        metalness: 0,
        transparent: true,
        opacity: 0.15,
        depthWrite: false,
        clearcoat: 1,
        clearcoatRoughness: 0.12,
        ior: 1.5,
      });
      const capMat = new T.MeshStandardMaterial({
        color: 0x23262e,
        roughness: 0.35,
        metalness: 0.8,
      });
      const baseMat = new T.MeshStandardMaterial({
        color: 0x3a3d44,
        roughness: 0.35,
        metalness: 0.85,
      });

      // Lay the row out left→right accounting for each tube's radius, then centre.
      const GAP = 0.16;
      const H = 1.75; // main tube height; tubes are bottom-aligned on the table
      const rs = LAYOUT.map(radiusOf);
      const totalW = rs.reduce((a, r) => a + 2 * r, 0) + GAP * (LAYOUT.length - 1);
      const maxR = Math.max(...rs);
      let cursor = -totalW / 2;

      // Rectangular brushed-metal base plate the tubes stand on.
      const baseGeo = new T.BoxGeometry(totalW + 0.7, 0.3, 2 * maxR + 0.7);
      const base = new T.Mesh(baseGeo, baseMat);
      base.position.y = -H / 2 - 0.15;
      group.add(base);

      type Slot = { tube: NixieTube; tex: THREE.CanvasTexture; last: string };
      const slots: Slot[] = [];
      const geoms: THREE.BufferGeometry[] = [baseGeo];

      LAYOUT.forEach((L, i) => {
        const r = rs[i];
        const h = heightOf(L);
        const x = cursor + r;
        cursor += 2 * r + GAP;
        const yBottom = -H / 2; // all tubes sit on the same table top
        const yc = yBottom + h / 2;

        const cylGeo = new T.CylinderGeometry(r, r, h, 40, 1, true);
        geoms.push(cylGeo);
        const cyl = new T.Mesh(cylGeo, glass);
        cyl.position.set(x, yc, 0);
        group.add(cyl);

        // Metal socket where the tube meets the base plate.
        const socketGeo = new T.CylinderGeometry(r * 1.15, r * 1.28, 0.2, 28);
        geoms.push(socketGeo);
        const socket = new T.Mesh(socketGeo, capMat);
        socket.position.set(x, yBottom + 0.04, 0);
        group.add(socket);

        // Rounded glass dome on top (a real nixie's domed envelope), same glass.
        const domeGeo = new T.SphereGeometry(r, 32, 20, 0, Math.PI * 2, 0, Math.PI / 2);
        geoms.push(domeGeo);
        const dome = new T.Mesh(domeGeo, glass);
        dome.position.set(x, yBottom + h, 0);
        group.add(dome);

        const c = document.createElement("canvas");
        c.style.cssText = `display:block;width:${Math.round(r * 250)}px;height:${Math.round(h * 120)}px`;
        sink.appendChild(c);
        const tube = createNixieTube(c, {
          value: L.colon ? ":" : "0",
          style: "tall",
          glow: 0.95,
          mesh: false,
          ghost: false,
          background: [0.008, 0.008, 0.012],
        })!;
        tube.resize();

        const tex = new T.CanvasTexture(c);
        tex.colorSpace = T.SRGBColorSpace;
        const planeGeo = new T.PlaneGeometry(r * 1.6, h * 0.76);
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
        plane.position.set(x, yc, 0.001);
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
      let shown = 0; // smooth elapsed seconds
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

          // Smooth clock: advance by real dt while playing, snap to the true
          // position on a seek / track change / pause (fluid ms, stays honest).
          const pos = playback.position || 0;
          if (active) {
            shown += dt;
            if (Math.abs(shown - pos) > 0.3) shown = pos;
          } else {
            shown = pos;
          }
          const total = Math.max(0, shown);
          const mm = Math.min(99, Math.floor(total / 60))
            .toString()
            .padStart(2, "0");
          const ss = Math.floor(total % 60)
            .toString()
            .padStart(2, "0");
          const cc = Math.floor((total * 100) % 100)
            .toString()
            .padStart(2, "0");
          const s = `${mm}:${ss}:${cc}`; // 8 chars → 8 slots
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
        baseMat.dispose();
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
