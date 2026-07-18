<script lang="ts">
  // Demoscene plasma, GPU edition: a domain-warped, multi-octave sine field
  // palette-cycled through an accent-tinted 256-colour ramp, rendered as a single
  // fullscreen fragment shader (raw WebGL, no Three.js). The warp folds the field
  // like liquid rather than reading as flat sine bands, and it reacts to the music
  // — bass churns the warp, treble adds a fine shimmer, beats bloom the ridges, and
  // energy drives the palette-cycle speed. Smooth + aspect-correct (no stretch).
  // The palette (built in JS from the --accent hue, tuned so the dominant mid band
  // doesn't overexpose) is uploaded as a 256×1 texture; brightness lifts are gated
  // to the bright crests so loud passages sparkle instead of washing out. Fills the
  // whole area, so the panel colour is irrelevant — same in both themes. CSP-safe.
  import { playback, sampleBands } from "./player.svelte";
  import { driveFrames } from "./raf";

  let { active = true }: { active?: boolean } = $props();

  let canvas: HTMLCanvasElement | null = $state(null);

  const VERT = `
    attribute vec2 a_pos;
    void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
  `;
  const FRAG = `
    precision highp float;
    uniform vec2 uRes;
    uniform float uT;       // field time (accumulates)
    uniform float uRot;     // palette-cycle offset, 0..256 (wraps)
    uniform float uWarp;    // bass → extra domain-warp depth
    uniform float uShimmer; // treble → fine detail octave
    uniform float uGlow;    // eased energy → crest bloom
    uniform float uPulse;   // beat flash 0..1
    uniform sampler2D uPal; // 256×1 accent palette (REPEAT so the cycle wraps)
    void main() {
      // Aspect-correct, centred coords (normalised by height → no stretch).
      vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
      float t = uT;
      vec2 p = uv * 3.4;

      // Domain warp: offset the sampling coords by a slow sine field, twice, so the
      // plasma flows and folds like liquid instead of flat sine bands. Bass deepens
      // the warp so the field churns harder on heavy low end.
      vec2 w1 = vec2(sin(p.y * 1.7 + t * 0.5), sin(p.x * 1.5 - t * 0.6));
      vec2 w2 = vec2(sin((p.y + w1.y) * 2.3 - t * 0.7), sin((p.x + w1.x) * 2.1 + t * 0.8));
      vec2 q = p + w1 * (0.7 + uWarp) + w2 * (0.35 + uWarp * 0.5);

      // Two drifting radial centres + linear layers over the warped domain.
      vec2 c1 = vec2(sin(t * 0.6), cos(t * 0.5)) * 1.3;
      vec2 c2 = vec2(sin(t * 0.37 + 2.0), cos(t * 0.43 + 1.0)) * 1.3;
      float v = sin(q.x * 2.0 + t)
              + sin(q.y * 2.4 - t * 0.8)
              + sin(length(q - c1) * 3.0 - t * 1.3)
              + sin(length(q - c2) * 3.6 + t * 0.9);
      // Fine shimmer octave on the treble.
      v += (sin(q.x * 6.0 - t * 2.2) + sin(q.y * 7.0 + t * 1.9)) * 0.3 * uShimmer;

      // ~0..1 (palette is cyclic — dark at both ends — so any spill wraps seamlessly).
      float vn = v * 0.11 + 0.5;
      vec3 col = texture2D(uPal, vec2(fract((vn * 255.0 + uRot) / 256.0), 0.5)).rgb;

      // Bloom the ridges: where the palette colour is already hot, add a gated glow
      // that swells on beats + energy — a bright filigree on the crests, kept off the
      // dark troughs so the whole field never washes out.
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      float crest = smoothstep(0.32, 0.55, lum);
      col += col * crest * (0.25 + uPulse * 0.7 + uGlow * 0.4);
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  $effect(() => {
    const cv = canvas;
    if (!cv) return;
    const el: HTMLCanvasElement = cv;
    const ctx = el.getContext("webgl", { antialias: false, alpha: false });
    if (!ctx) {
      console.warn("Plasma: WebGL unavailable");
      return;
    }
    const gl: WebGLRenderingContext = ctx;

    function compile(type: number, src: string): WebGLShader | null {
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.warn("Plasma shader:", gl.getShaderInfoLog(sh));
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    }
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) return;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("Plasma link:", gl.getProgramInfoLog(prog));
      return;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(prog, "uRes");
    const uT = gl.getUniformLocation(prog, "uT");
    const uRot = gl.getUniformLocation(prog, "uRot");
    const uWarp = gl.getUniformLocation(prog, "uWarp");
    const uShimmer = gl.getUniformLocation(prog, "uShimmer");
    const uGlow = gl.getUniformLocation(prog, "uGlow");
    const uPulse = gl.getUniformLocation(prog, "uPulse");
    const uPal = gl.getUniformLocation(prog, "uPal");

    // Accent-tinted 256-entry palette (HSL sweep around the accent hue), uploaded
    // as a 256×1 texture. REPEAT wrap (256 is a power of two) so the rotation
    // cycles seamlessly; NEAREST keeps the discrete palette steps.
    const palette = new Uint8Array(256 * 3);
    const palTex = gl.createTexture();
    let cachedMode: string | null = null;
    const node: HTMLCanvasElement = el;
    function hslToRgb(hh: number, ss: number, ll: number): [number, number, number] {
      const s = ss / 100;
      const l = ll / 100;
      const c = (1 - Math.abs(2 * l - 1)) * s;
      const xx = c * (1 - Math.abs(((hh / 60) % 2) - 1));
      const m = l - c / 2;
      let r = 0;
      let g = 0;
      let b = 0;
      if (hh < 60) [r, g, b] = [c, xx, 0];
      else if (hh < 120) [r, g, b] = [xx, c, 0];
      else if (hh < 180) [r, g, b] = [0, c, xx];
      else if (hh < 240) [r, g, b] = [0, xx, c];
      else if (hh < 300) [r, g, b] = [xx, 0, c];
      else [r, g, b] = [c, 0, xx];
      return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
    }
    function buildPalette() {
      const acc = getComputedStyle(node).getPropertyValue("--accent").trim() || "#f78f08";
      // Derive a base hue from the accent (hex); fall back to amber.
      const m = /^#?([0-9a-f]{6})$/i.exec(acc);
      let baseHue = 35;
      if (m) {
        const n = parseInt(m[1], 16);
        const r = (n >> 16) & 255;
        const gg = (n >> 8) & 255;
        const b = n & 255;
        const mx = Math.max(r, gg, b);
        const mn = Math.min(r, gg, b);
        const d = mx - mn;
        if (d) {
          let hh;
          if (mx === r) hh = ((gg - b) / d) % 6;
          else if (mx === gg) hh = (b - r) / d + 2;
          else hh = (r - gg) / d + 4;
          baseHue = (((hh * 60) % 360) + 360) % 360;
        }
      }
      for (let i = 0; i < 256; i++) {
        // Triangle 0→1→0 over the cycle. Sweep the accent (orange) hue toward
        // purple via the magenta side (never green) — on-style dark orange ↔ purple.
        const tri = (1 - Math.cos((i / 256) * Math.PI * 2)) / 2;
        const hue = (((baseHue - 110 * tri) % 360) + 360) % 360;
        // Land the dominant mid band at a rich ~45% L with only a faint hot specular
        // at the very centre, desaturated a touch so it reads rich, not neon; the
        // rare dark blobs (tri→0) stay fully saturated and near-black. (Crest bloom
        // in the shader adds the highlights, so the palette itself stays restrained.)
        const l = 12 + 30 * tri + 3 * Math.pow(tri, 6);
        const s = 82 - 12 * tri;
        const [r, g, b] = hslToRgb(hue, s, l);
        palette[i * 3] = r;
        palette[i * 3 + 1] = g;
        palette[i * 3 + 2] = b;
      }
    }
    function uploadPalette() {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, palTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 256, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, palette);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    buildPalette();
    uploadPalette();
    gl.uniform1i(uPal, 0);

    // Smooth gradients → the backing resolution barely matters; cap at 1.5× retina.
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      el.width = Math.max(1, Math.round(rect.width * dpr));
      el.height = Math.max(1, Math.round(rect.height * dpr));
      gl.viewport(0, 0, el.width, el.height);
    });
    ro.observe(el);

    // Accessibility: honour prefers-reduced-motion by slowing the swirl/cycle and
    // damping the reactive warp/shimmer/flash to a calm fraction (never freezing —
    // a slow plasma is fine). Read once at mount.
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0.35 : 1.0;

    let t = 0;
    let rot = 0; // palette-cycle phase (index units, wrapped to 256)
    let glow = 0; // eased energy
    let bass = 0;
    let treble = 0;
    let pulse = 0; // beat flash, decays
    let lastBeat = -1;
    const stop = driveFrames(
      (dt: number) => {
        // Rebuild the palette on either theme OR accent change (both alter --accent).
        const mode = `${document.documentElement.dataset.theme ?? ""}/${document.documentElement.dataset.accent ?? ""}`;
        if (mode !== cachedMode) {
          buildPalette();
          uploadPalette();
          cachedMode = mode;
        }
        const energy = active && playback.vu.length ? Math.max(...playback.vu) : 0;
        glow += (energy - glow) * 0.1;
        const bands = active ? sampleBands() : { bass: 0, treble: 0 };
        bass += (bands.bass - bass) * 0.2;
        treble += (bands.treble - treble) * 0.2;
        if (lastBeat < 0) lastBeat = playback.beat;
        else if (playback.beat !== lastBeat) {
          lastBeat = playback.beat;
          pulse = 1;
        }
        pulse *= Math.exp(-dt / 0.2);

        // Per-frame increments (frame-locked like the original; driveFrames caps at
        // 60fps). Speed rides the music energy; wrap rot to keep float precision.
        t += (0.02 + (active ? energy * 0.06 : 0.003)) * motion;
        rot = (rot + (0.5 + (active ? energy * 1.5 : 0.1)) * motion) % 256;

        gl.uniform2f(uRes, el.width, el.height);
        gl.uniform1f(uT, t);
        gl.uniform1f(uRot, rot);
        gl.uniform1f(uWarp, bass * 0.8 * motion);
        gl.uniform1f(uShimmer, treble * motion);
        gl.uniform1f(uGlow, glow);
        gl.uniform1f(uPulse, pulse * motion);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
      { active: () => active },
    );

    return () => {
      stop();
      ro.disconnect();
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
      gl.deleteTexture(palTex);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  });
</script>

<canvas bind:this={canvas}></canvas>

<style>
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
