<script lang="ts">
  // Tron-style 3D tunnel — a single fullscreen fragment shader (raw WebGL, no
  // Three.js). Instead of the straight 1/r "fake" tunnel, this raymarches the
  // interior of a *curved* tube: each pixel's ray steps forward until it hits
  // the wall, so where the tube bends the near inside wall occludes everything
  // beyond it — you watch the far end vanish behind the curve as you approach.
  //
  // The centreline meanders through hills + banked turns (a sum of sines, phase
  // seeded per track), evaluated per-depth inside the shader. Rings + rails form
  // the neon grid; walls flash/breathe on each musical beat; brightness + flight
  // speed track the music's energy. CSP-safe (GLSL compiles on the GPU, not eval).
  import { playback } from "./player.svelte";

  let { active = true }: { active?: boolean } = $props();

  let canvas: HTMLCanvasElement | null = $state(null);

  const VERT = `
    attribute vec2 a_pos;
    void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
  `;
  const FRAG = `
    precision highp float;
    uniform vec2 uRes;
    uniform float uCamZ;   // travel distance along the tube
    uniform float uSeed;   // per-track phase, varies the course
    uniform float uPulse;  // beat flash 0..1
    uniform float uGlow;   // eased energy 0..1
    uniform float uBend;   // eased energy → how hard the tube bends
    uniform float uTime;   // seconds, for wall-theme morph + animation
    uniform float uScan;   // 0/1 CRT scanline + vignette overlay ('s' toggles)

    const float R = 1.0;          // tube radius (world units)
    const float FOV = 1.35;       // larger = narrower field of view
    const float FAR = 62.0;       // max march distance (deep enough to hide the void)
    const float RING_FREQ = 1.15; // ring lines per world unit of travel
    const float RAIL_FREQ = 16.0; // rails around the tube
    const float LEAD = 14.0;      // how far ahead the chased beacon sits
    const float TAU = 6.2831853;  // angular terms use integer×TAU to wrap seamlessly

    // Course "terrain": a slow field along the tube that alternates long straights
    // (field → 0) with twisty stretches (field → 1). It's a function of absolute z,
    // so the layout exists ahead of the camera — you see the next bend or straight
    // coming (within fog range) before you reach it, instead of a uniform wobble.
    float bendField(float z) {
      float m = (0.5 + 0.5 * sin(z * 0.055 + uSeed * 1.3)) *
                (0.6 + 0.4 * sin(z * 0.021 + uSeed * 2.7));
      return smoothstep(0.12, 0.85, m); // dwell near straight, punch into bends
    }
    // Tube centreline at absolute distance z: sines per axis (X = turns, Y = hills),
    // their amplitude gated by the terrain field and scaled by uBend (music energy).
    // In a bendy stretch at high energy the amplitude exceeds R, so the axis swings
    // far enough to hide the far end; straights and quiet passages stay straight.
    vec2 tunnelPath(float z) {
      float amp = bendField(z) * uBend;
      float x = (sin(z * 0.20 + uSeed * 1.7) * 1.15 + sin(z * 0.37 + uSeed * 3.1) * 0.5) * amp;
      float y = (sin(z * 0.16 + uSeed * 2.3) * 1.05 + sin(z * 0.31 + uSeed * 4.7) * 0.5) * amp;
      return vec2(x, y);
    }
    // ...relative to the camera, so the near end stays centred.
    vec2 center(float z) { return tunnelPath(uCamZ + z) - tunnelPath(uCamZ); }

    // Soft neon line at each integer of t: thin core + wider dim halo.
    float neon(float t, float w) {
      float d = abs(fract(t + 0.5) - 0.5);
      return smoothstep(w, 0.0, d) + 0.3 * smoothstep(w * 4.0, 0.0, d);
    }

    vec3 hsv2rgb(vec3 c) {
      vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
      return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
    }

    // --- wall themes: z = distance along tube, a = angle 0..1 around, t = seconds.
    // Tron: cyan ring grid + orange edge rails on black.
    vec3 themeTron(float z, float a, float t) {
      float rings = neon(z * RING_FREQ, 0.05);
      float rails = neon(a * RAIL_FREQ, 0.04);
      return vec3(0.16, 0.88, 1.0) * rings + vec3(0.98, 0.57, 0.05) * rails;
    }
    // 2001 star-gate slit-scan: flowing saturated colour curtains, no dark gaps.
    vec3 themeWormhole(float z, float a, float t) {
      float hue = fract(a * 2.0 + z * 0.03 + t * 0.05); // a*integer → seamless wrap
      float striations = 0.55 + 0.45 * sin((z * 0.7 - t * 2.5) * TAU + a * TAU * 6.0);
      return hsv2rgb(vec3(hue, 0.9, 1.0)) * striations * 1.3;
    }
    // Dystopian sewer: grimy dark pipe, tile grid, wet green-brown streaks.
    vec3 themeSewer(float z, float a, float t) {
      float tiles = max(neon(z * RING_FREQ * 1.5, 0.13), neon(a * 20.0, 0.11));
      float grime = 0.5 + 0.5 * sin(z * 4.3 + a * TAU * 3.0) * sin(z * 1.7 - a * TAU * 2.0);
      vec3 base = mix(vec3(0.05, 0.08, 0.05), vec3(0.15, 0.14, 0.07), grime);
      float drips = smoothstep(0.92, 1.0, 0.5 + 0.5 * sin(a * TAU * 15.0)) * (0.5 + 0.5 * sin(z * 0.5 - t));
      return base + vec3(0.08, 0.12, 0.07) * tiles + vec3(0.06, 0.09, 0.08) * drips;
    }
    // Hyperspace: sparse bright star-streaks whipping past along the tube.
    vec3 themeHyper(float z, float a, float t) {
      float lane = floor(a * 48.0);
      float r = fract(sin(lane * 12.9898 + uSeed) * 43758.5453);
      float streak = smoothstep(0.97, 1.0, 0.5 + 0.5 * sin(z * 2.0 + t * (14.0 + r * 26.0) + r * 40.0));
      return mix(vec3(0.6, 0.75, 1.0), vec3(1.0), r) * streak * step(0.55, r) * 2.2;
    }
    // Biomech / Giger: dark ribbed organic-metal, cold violet-grey with wet sheen.
    vec3 themeGiger(float z, float a, float t) {
      float ribs = 0.5 + 0.5 * sin(z * 7.0 + sin(a * TAU * 3.0) * 1.6);
      float spine = 0.5 + 0.5 * sin(a * TAU * 4.0 + z * 0.6);
      vec3 col = mix(vec3(0.03, 0.03, 0.05), vec3(0.24, 0.22, 0.28), pow(ribs * spine, 1.5));
      return col + vec3(0.12, 0.1, 0.16) * pow(spine, 5.0);
    }
    // Vaporwave: magenta↔cyan neon grid over a purple gradient.
    vec3 themeVapor(float z, float a, float t) {
      float grid = max(neon(z * RING_FREQ, 0.04), neon(a * RAIL_FREQ, 0.035));
      float grad = 0.5 + 0.5 * sin(a * 6.2831);
      vec3 gridCol = mix(vec3(1.0, 0.2, 0.8), vec3(0.25, 0.9, 1.0), grad);
      return mix(vec3(0.16, 0.03, 0.22), vec3(0.35, 0.08, 0.3), grad) * 0.35 + gridCol * grid;
    }
    // Rust: weathered corroded metal — mottled orange-brown over dark steel, with
    // darker panel grooves. Multi-octave mottle, all angular terms integer×TAU.
    vec3 themeRust(float z, float a, float t) {
      float m = (0.5 + 0.5 * sin(z * 3.0 + a * TAU * 2.0)) +
                (0.5 + 0.5 * sin(z * 7.3 - a * TAU * 5.0)) +
                (0.5 + 0.5 * sin(z * 13.1 + a * TAU * 3.0));
      m /= 3.0;
      vec3 rust = mix(vec3(0.35, 0.14, 0.05), vec3(0.62, 0.33, 0.11), m);
      vec3 col = mix(vec3(0.1, 0.09, 0.08), rust, smoothstep(0.35, 0.8, m));
      float grooves = max(neon(z * 0.5, 0.06), neon(a * 8.0, 0.05));
      return col * (1.0 - 0.4 * grooves);
    }
    // Rainbow: full-spectrum hue flowing around + down the tube (hue is cyclic, so
    // a*1.0 = one seamless spectrum around), with a gentle ring shimmer along z.
    vec3 themeRainbow(float z, float a, float t) {
      float hue = fract(a * 1.0 + z * 0.08 - t * 0.1);
      float bands = 0.6 + 0.4 * sin(z * RING_FREQ * TAU + t * 2.0);
      return hsv2rgb(vec3(hue, 0.95, 1.0)) * bands;
    }
    // Black & white CRT: monochrome phosphor grid, white on black.
    vec3 themeBW(float z, float a, float t) {
      return vec3(max(neon(z * RING_FREQ, 0.05), neon(a * RAIL_FREQ, 0.04)));
    }
    vec3 themeById(float id, float z, float a, float t) {
      if (id < 0.5) return themeTron(z, a, t);
      if (id < 1.5) return themeWormhole(z, a, t);
      if (id < 2.5) return themeSewer(z, a, t);
      if (id < 3.5) return themeHyper(z, a, t);
      if (id < 4.5) return themeGiger(z, a, t);
      if (id < 5.5) return themeVapor(z, a, t);
      if (id < 6.5) return themeRust(z, a, t);
      if (id < 7.5) return themeRainbow(z, a, t);
      return themeBW(z, a, t);
    }
    // Deterministic random theme for cycle slot n (per-track via uSeed).
    float hash1(float n) { return fract(sin(n * 127.1 + uSeed * 311.7) * 43758.5453); }
    float themeSlot(float n) { return floor(hash1(n) * 9.0); }

    void main() {
      vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
      // Rollercoaster orientation: lean hard into turns, banking off the track's
      // lateral drift a little way ahead so the roll anticipates the bend.
      float roll = clamp(-center(3.0).x * 0.5, -0.8, 0.8);
      float cr = cos(roll), sr = sin(roll);
      uv = mat2(cr, -sr, sr, cr) * uv;

      // March the ray through the (curved) tube until it crosses the wall. The
      // cylinder slack (R - dist-to-axis) is a valid step, so open space is
      // covered fast and we creep as we near the wall.
      vec3 rd = normalize(vec3(uv, FOV));
      // ...and pitch over hills from the vertical drift ahead: climbing tilts the
      // view up, cresting tilts it down so the far side drops out of sight.
      float pitch = clamp(center(3.0).y * 0.34, -0.55, 0.55);
      float cp = cos(pitch), sp = sin(pitch);
      rd = vec3(rd.x, rd.y * cp + rd.z * sp, -rd.y * sp + rd.z * cp);
      float t = 0.0;
      bool hit = false;
      float hitZ = 0.0, hitAng = 0.0;
      for (int i = 0; i < 104; i++) {
        vec3 pos = rd * t;
        vec2 rel = pos.xy - center(pos.z);
        float slack = R - length(rel); // >0 inside, 0 at wall
        if (slack < 0.003) {
          hit = true;
          hitZ = pos.z;
          hitAng = atan(rel.y, rel.x);
          break;
        }
        t += max(slack * 0.85, 0.02);
        if (t > FAR) break;
      }

      // Near-axis rays down an open straight stretch may find no wall in range:
      // shade the deepest marched point as a far wall so the centre fades into
      // deep fogged tunnel, not a hard black void ("event horizon" crescent).
      if (!hit) {
        vec3 pos = rd * t;
        vec2 rel = pos.xy - center(pos.z);
        hitZ = pos.z;
        hitAng = atan(rel.y, rel.x);
        hit = true;
      }

      vec3 col = vec3(0.0);
      if (hit) {
        float z = uCamZ + hitZ;
        float a = hitAng * 0.15915494 + 0.5; // 0..1 around the tube
        // Hold a randomly-picked wall theme for ~22s, then crossfade to the next
        // (also random, but never the same one back-to-back). Seeded per track.
        float tp = uTime / 22.0;
        float n = floor(tp);
        float idA = themeSlot(n);
        float idB = themeSlot(n + 1.0);
        if (abs(idA - idB) < 0.5) idB = mod(idB + 1.0, 9.0);
        float k = smoothstep(0.82, 1.0, fract(tp));
        col = mix(themeById(idA, z, a, uTime), themeById(idB, z, a, uTime), k);
        float fog = exp(-hitZ * 0.055); // gentle: the tube recedes into depth, not a void
        col *= fog * (0.55 + uGlow * 0.9);
        col += col * uPulse * 0.9; // beat bloom kick (theme-agnostic)

        // Pulsing beacon we're chasing: on the axis a fixed lead ahead (just past
        // the next bend). Light the wall by proximity so the glow spills around the
        // corner while the source itself stays hidden behind the bend.
        vec2 hitXY = center(hitZ) + R * vec2(cos(hitAng), sin(hitAng));
        vec3 beacon = vec3(center(LEAD), LEAD);
        float dl = length(vec3(hitXY, hitZ) - beacon);
        vec3 lightCol = mix(vec3(0.5, 0.8, 1.0), vec3(1.0, 0.7, 0.35), 0.5 + 0.5 * sin(uTime * 0.4));
        col += lightCol * (0.5 + uPulse * 2.2) / (1.0 + dl * dl * 0.12);
      }
      // Vanishing-point core glow — fills the deep centre so it reads as a lit
      // tunnel receding, not a black hole.
      col += vec3(0.5, 0.7, 1.0) * 0.16 * smoothstep(0.4, 0.0, length(uv)) * (0.6 + uPulse);

      col = 1.0 - exp(-col); // exponential tonemap → soft neon bloom rolloff

      // Optional CRT overlay ('s'): horizontal scanlines + a soft vignette.
      if (uScan > 0.5) {
        float scan = 0.72 + 0.28 * sin(gl_FragCoord.y * 2.2);
        float vig = smoothstep(0.95, 0.35, length(gl_FragCoord.xy / uRes - 0.5));
        col *= scan * (0.8 + 0.3 * vig) * 1.25;
      }

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  $effect(() => {
    const cv = canvas;
    if (!cv) return;
    const el: HTMLCanvasElement = cv;
    const ctx = el.getContext("webgl", { antialias: true, alpha: false });
    if (!ctx) {
      console.warn("Tunnel: WebGL unavailable");
      return;
    }
    // Bind a non-null-typed handle so the nested frame/resize closures don't
    // re-widen it back to `| null` (TS doesn't carry the guard into closures).
    const gl: WebGLRenderingContext = ctx;

    function compile(type: number, src: string): WebGLShader | null {
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.warn("Tunnel shader:", gl.getShaderInfoLog(sh));
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
      console.warn("Tunnel link:", gl.getProgramInfoLog(prog));
      return;
    }
    gl.useProgram(prog);

    // One big triangle covering the viewport — no per-frame geometry.
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(prog, "uRes");
    const uCamZ = gl.getUniformLocation(prog, "uCamZ");
    const uSeed = gl.getUniformLocation(prog, "uSeed");
    const uPulse = gl.getUniformLocation(prog, "uPulse");
    const uGlow = gl.getUniformLocation(prog, "uGlow");
    const uBend = gl.getUniformLocation(prog, "uBend");
    const uTime = gl.getUniformLocation(prog, "uTime");
    const uScan = gl.getUniformLocation(prog, "uScan");

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      el.width = Math.max(1, Math.round(rect.width * dpr));
      el.height = Math.max(1, Math.round(rect.height * dpr));
      gl.viewport(0, 0, el.width, el.height);
    });
    ro.observe(el);

    // 's' toggles the CRT scanline overlay. Scoped to this component, so it only
    // acts while the tunnel viz is on screen; ignored while typing in a field.
    let scanOn = true; // CRT scanlines on by default; 's' toggles
    const onKey = (e: KeyboardEvent) => {
      const ae = document.activeElement;
      const typing = !!ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA");
      if (!typing && (e.key === "s" || e.key === "S")) scanOn = !scanOn;
    };
    window.addEventListener("keydown", onKey);

    // Per-track course seed from the filename (FNV-1a → a stable phase). Read
    // only inside frame() — reading playback.* in the effect body would make the
    // effect re-run (and tear down the GL context) on every beat.
    const seedFor = (name: string) => {
      let hsh = 0x811c9dc5;
      for (let i = 0; i < name.length; i++) hsh = (hsh ^ name.charCodeAt(i)) * 0x01000193;
      return (((hsh >>> 0) % 100000) / 100000) * 12.0;
    };

    let raf = 0;
    let clock = 0; // seconds elapsed, for theme morph + wall animation
    let camZ = 0;
    let speed = 0.4; // eased travel units/sec
    let glow = 0; // eased energy
    let bendEnv = 0; // slow energy envelope → bend amount
    let pulse = 0; // beat flash, decays
    let seedVal = 0;
    let pathKey = "";
    let lastBeat = -1;
    let prev = performance.now();

    function frame(now: number) {
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;
      clock += dt;

      const key = playback.current?.filename ?? "";
      if (key !== pathKey) {
        pathKey = key;
        seedVal = seedFor(key);
      }

      const energy = playback.vu.length ? Math.max(...playback.vu) : 0;
      glow += ((active ? energy : 0) - glow) * 0.1;
      // Slower envelope so the tube's bendiness breathes with the music rather
      // than twitching per frame; gentle baseline so it's never dead straight.
      bendEnv += ((active ? energy : 0) - bendEnv) * 0.03;
      const targetSpeed = active ? 3 + energy * 8 : 0.3;
      speed += (targetSpeed - speed) * 0.05;
      camZ += speed * dt;

      if (lastBeat < 0)
        lastBeat = playback.beat; // first frame: adopt, don't flash
      else if (playback.beat !== lastBeat) {
        lastBeat = playback.beat;
        pulse = 1;
      }
      pulse *= Math.exp(-dt / 0.18);

      gl.uniform2f(uRes, el.width, el.height);
      gl.uniform1f(uCamZ, camZ);
      gl.uniform1f(uSeed, seedVal);
      gl.uniform1f(uPulse, pulse);
      gl.uniform1f(uGlow, glow);
      gl.uniform1f(uBend, 0.6 + bendEnv * 0.9);
      gl.uniform1f(uTime, clock);
      gl.uniform1f(uScan, scanOn ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("keydown", onKey);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
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
