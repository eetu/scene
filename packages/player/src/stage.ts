// The shared three.js stage under the object visualisers (nixies, speaker
// paint, the dancer): a WebGL renderer appended to the host, optionally
// tone-mapped and lit by the PMREM room environment, resized via a
// ResizeObserver, and torn down in a way that hands its context back at once.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

export type StageOptions = {
  /** Cap for setPixelRatio at creation; omit when the scene manages its own ratio. */
  pixelRatioMax?: number;
  /** ACESFilmic tone-mapping exposure; omit to keep the renderer's default mapping. */
  toneMappingExposure?: number;
  /** Build the PMREM RoomEnvironment texture, for scenes lit by `scene.environment`. */
  environment?: boolean;
};

export type Stage = {
  renderer: THREE.WebGLRenderer;
  /** The room-environment texture; null unless `environment` was requested. */
  envTex: THREE.Texture | null;
  /** Watch the container and call `resize` on changes (plus once, immediately). */
  observe(resize: () => void): void;
  /** Dispose the stage-owned GL objects and release the context. */
  destroy(): void;
};

export function createStage(container: HTMLElement, opts: StageOptions = {}): Stage {
  // preserveDrawingBuffer: the CRT screen samples this canvas as a texture from its own
  // rAF, and Safari discards a drawing buffer as soon as it has composited it — so
  // without this the screen reads an empty buffer and the tube goes black there (Chrome
  // happens to keep it around, which is why it only showed up on Safari). Costs the
  // driver some freedom to discard, which is the price of being compositable.
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  if (opts.pixelRatioMax !== undefined) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.pixelRatioMax));
  }
  if (opts.toneMappingExposure !== undefined) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = opts.toneMappingExposure;
  }
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";

  let pmrem: THREE.PMREMGenerator | null = null;
  let envTex: THREE.Texture | null = null;
  if (opts.environment) {
    pmrem = new THREE.PMREMGenerator(renderer);
    envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  }

  let ro: ResizeObserver | null = null;
  return {
    renderer,
    envTex,
    observe(resize) {
      ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => resize()) : null;
      ro?.observe(container);
      resize();
    },
    destroy() {
      ro?.disconnect();
      envTex?.dispose();
      pmrem?.dispose();
      renderer.dispose();
      // Hand the WebGL context back NOW. dispose() releases three's own resources but
      // leaves the context itself alive until GC, and a browser allows only ~16 at a
      // time — flipping between visualisers then walks over the limit ("too many
      // active WebGL contexts, the oldest will be lost") and silently kills whichever
      // one is on screen. That looks exactly like a broken visualiser.
      //
      // Guarded: the context may ALREADY be lost, either because the browser dropped
      // it under that limit or because it was torn down once before. Asking again logs
      // "INVALID_OPERATION: loseContext: context already lost".
      if (!renderer.getContext().isContextLost()) renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
