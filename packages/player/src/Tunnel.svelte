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
  import { beatPhase, playback, sampleBands } from "./player.svelte";

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
    uniform float uFov;    // field of view — punches in on the beat
    uniform float uWave;   // beat pulse-wave phase 0→1 (a ring rushing down the tube)
    uniform float uSpin;   // continuous barrel-roll angle (radians)
    uniform float uBass;   // eased bass level 0..1
    uniform float uTreble; // eased treble level 0..1

    const float R = 1.0;          // tube radius (world units)
    const float FAR = 62.0;       // max march distance (deep enough to hide the void)
    const float RING_FREQ = 1.15; // ring lines per world unit of travel
    const float RAIL_FREQ = 16.0; // rails around the tube
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
    // Circuit board: dark-green FR-4 with a copper trace grid + solder pads; a
    // random subset of nodes is "energized" and glows green, flowing along z like
    // data. Grid is 24 traces around (integer → seamless).
    vec3 themeCircuit(float z, float a, float t) {
      float gz = z * 3.0, ga = a * 24.0;
      float traces = max(neon(gz, 0.03), neon(ga, 0.025));
      vec2 cell = fract(vec2(gz, ga)) - 0.5;
      float pad = smoothstep(0.16, 0.1, length(cell)); // round pads at nodes
      float r = fract(sin(floor(gz) * 12.9 + floor(ga) * 78.2 + uSeed) * 43758.5);
      float flow = step(0.62, r) * (0.4 + 0.6 * (0.5 + 0.5 * sin(gz * 2.0 - t * 4.0 + r * 6.0)));
      vec3 board = vec3(0.02, 0.11, 0.05);
      vec3 copper = vec3(0.75, 0.5, 0.2);
      vec3 glow = vec3(0.3, 1.0, 0.6);
      return board + copper * (traces + pad) * 0.6 + glow * (traces + pad * 1.5) * flow;
    }
    // Rainbow: soft pastel spectrum spiralling around + down the tube (hue is
    // cyclic, so a*1.0 = one seamless spectrum around). Low saturation + a lift
    // toward white keeps it pastel; no brightness bands, so no dark spiral line.
    vec3 themeRainbow(float z, float a, float t) {
      float hue = fract(a * 1.0 + z * 0.06 - t * 0.08);
      return mix(hsv2rgb(vec3(hue, 0.5, 1.0)), vec3(1.0), 0.15);
    }
    // Black & white CRT: monochrome phosphor grid, white on black.
    vec3 themeBW(float z, float a, float t) {
      return vec3(max(neon(z * RING_FREQ, 0.05), neon(a * RAIL_FREQ, 0.04)));
    }
    // Star Wars hyperspace: deep blue field with dense blue-white streaks stretched
    // along the tube, whipping past fast — the jump-to-lightspeed look.
    vec3 themeStarwars(float z, float a, float t) {
      float lane = floor(a * 96.0);
      float r = fract(sin(lane * 78.233 + uSeed) * 43758.5453);
      float streak = smoothstep(0.9, 1.0, 0.5 + 0.5 * sin(z * 1.2 + t * (30.0 + r * 40.0) + r * 20.0));
      return vec3(0.06, 0.12, 0.4) + mix(vec3(0.3, 0.5, 1.0), vec3(1.0), r) * streak * 2.6;
    }
    // Purple voxel tunnel: blocky cells (per-cell purple shade) with dark grout
    // borders, so the wall reads as extruded voxels.
    vec3 themeVoxel(float z, float a, float t) {
      float cz = z * 2.0, ca = a * 24.0; // 24 cells around, integer → seamless
      float r = fract(sin(floor(cz) * 12.9 + floor(ca) * 78.2 + uSeed) * 43758.5);
      vec3 body = mix(vec3(0.18, 0.04, 0.3), vec3(0.65, 0.25, 0.95), r);
      vec2 f = abs(fract(vec2(cz, ca)) - 0.5) * 2.0; // 0 at cell centre → 1 at border
      float lit = 1.0 - smoothstep(0.7, 1.0, max(f.x, f.y)) * 0.85;
      return body * lit;
    }
    // Spaceship corridor: grey metal panels + rib rings, with cyan light strips
    // running the length of the hall.
    vec3 themeCorridor(float z, float a, float t) {
      float panels = max(neon(z * 1.0, 0.06), neon(a * 12.0, 0.05));
      vec3 col = vec3(0.16, 0.17, 0.2) * (1.0 - 0.5 * panels); // seams darker
      col += vec3(0.08, 0.09, 0.11) * neon(z * 0.5, 0.05);      // structural ribs
      float strip = neon(a * 2.0, 0.02);                        // two opposed rails
      return col + vec3(0.2, 0.7, 1.0) * strip * (0.7 + 0.3 * sin(z * 2.0 - t * 3.0));
    }
    vec3 themeById(float id, float z, float a, float t) {
      if (id < 0.5) return themeTron(z, a, t);
      if (id < 1.5) return themeWormhole(z, a, t);
      if (id < 2.5) return themeHyper(z, a, t);
      if (id < 3.5) return themeGiger(z, a, t);
      if (id < 4.5) return themeVapor(z, a, t);
      if (id < 5.5) return themeCircuit(z, a, t);
      if (id < 6.5) return themeRainbow(z, a, t);
      if (id < 7.5) return themeBW(z, a, t);
      if (id < 8.5) return themeStarwars(z, a, t);
      if (id < 9.5) return themeVoxel(z, a, t);
      return themeCorridor(z, a, t);
    }
    // Deterministic random theme for cycle slot n (per-track via uSeed).
    float hash1(float n) { return fract(sin(n * 127.1 + uSeed * 311.7) * 43758.5453); }
    float themeSlot(float n) { return floor(hash1(n) * 11.0); }

    void main() {
      vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
      // Rollercoaster orientation: lean hard into turns (lateral drift ahead) plus
      // a slow, energy-driven barrel roll (uSpin) for continuous motion.
      float roll = clamp(-center(3.0).x * 0.5, -0.8, 0.8) + uSpin;
      float cr = cos(roll), sr = sin(roll);
      uv = mat2(cr, -sr, sr, cr) * uv;

      // March the ray through the (curved) tube until it crosses the wall. The
      // cylinder slack (R - dist-to-axis) is a valid step, so open space is
      // covered fast and we creep as we near the wall. uFov punches in on beats.
      vec3 rd = normalize(vec3(uv, uFov));
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
        if (abs(idA - idB) < 0.5) idB = mod(idB + 1.0, 11.0);
        float k = smoothstep(0.82, 1.0, fract(tp));
        col = mix(themeById(idA, z, a, uTime), themeById(idB, z, a, uTime), k);
        float fog = exp(-hitZ * 0.055); // gentle: the tube recedes into depth, not a void
        col *= fog * (0.55 + uGlow * 0.9);
        col += col * uPulse * 0.5; // beat bloom kick (theme-agnostic)

        // Beat pulse-wave: a gentle brightness swell rolling down the tube on each
        // beat. It *modulates the wall's own colour* (multiplicative) rather than
        // adding a separate coloured band, so it supports the tunnel instead of
        // upstaging it.
        float wave = smoothstep(8.0, 0.0, abs(hitZ - uWave * 15.0)) * (1.0 - uWave);
        col *= 1.0 + wave * (0.12 + uBass * 0.3);
        // Treble → faint moving shimmer on the walls.
        col += vec3(1.0) * uTreble * 0.2 * neon(a * RAIL_FREQ * 3.0 + z * 5.0, 0.015);
        // Louder passages read a touch more vivid.
        col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, 1.0 + uGlow * 0.18);
      }
      // Vanishing-point core glow — fills the deep centre so it reads as a lit
      // tunnel receding, not a black hole.
      col += vec3(0.5, 0.7, 1.0) * 0.16 * smoothstep(0.4, 0.0, length(uv)) * (0.6 + uPulse * 0.6 + uTreble * 0.2);

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
    const uFov = gl.getUniformLocation(prog, "uFov");
    const uWave = gl.getUniformLocation(prog, "uWave");
    const uSpin = gl.getUniformLocation(prog, "uSpin");
    const uBass = gl.getUniformLocation(prog, "uBass");
    const uTreble = gl.getUniformLocation(prog, "uTreble");

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
    let punch = 0; // beat camera kick (FOV + speed burst), decays
    let spin = 0; // continuous barrel-roll angle (wrapped to TAU)
    let bass = 0; // eased bass level
    let treble = 0; // eased treble level
    let seedVal = 0;
    let pathKey = "";
    let lastBeat = -1;
    let prev = performance.now();
    const TAU = Math.PI * 2;

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
      // Per-band levels (bass drives the beat punch/pulse, treble the sparkle).
      const b = active ? sampleBands() : { bass: 0, treble: 0 };
      bass += (b.bass - bass) * 0.2;
      treble += (b.treble - treble) * 0.2;
      // Slower envelope so the tube's bendiness breathes with the music rather
      // than twitching per frame; gentle baseline so it's never dead straight.
      bendEnv += ((active ? energy : 0) - bendEnv) * 0.03;
      const targetSpeed = active ? 3 + energy * 8 : 0.3;
      speed += (targetSpeed - speed) * 0.05;
      // Beat punch nudges forward briefly; slow barrel roll drifts with energy.
      camZ += speed * (1 + punch * 0.4) * dt;
      spin = (spin + dt * (0.05 + glow * 0.15)) % TAU;

      if (lastBeat < 0)
        lastBeat = playback.beat; // first frame: adopt, don't flash/punch
      else if (playback.beat !== lastBeat) {
        lastBeat = playback.beat;
        pulse = 1;
        punch = 0.3 + bass * 0.3; // bassier beats kick a little harder
      }
      pulse *= Math.exp(-dt / 0.22);
      punch *= Math.exp(-dt / 0.4); // slow decay → smooth push, not a jolt

      gl.uniform2f(uRes, el.width, el.height);
      gl.uniform1f(uCamZ, camZ);
      gl.uniform1f(uSeed, seedVal);
      gl.uniform1f(uPulse, pulse);
      gl.uniform1f(uGlow, glow);
      gl.uniform1f(uBend, 0.6 + bendEnv * 0.9);
      gl.uniform1f(uTime, clock);
      gl.uniform1f(uScan, scanOn ? 1 : 0);
      gl.uniform1f(uFov, 1.35 + punch * 0.14); // gentle zoom-push on the beat
      gl.uniform1f(uWave, active ? beatPhase(now) : 1); // 1 = no wave when idle
      gl.uniform1f(uSpin, spin);
      gl.uniform1f(uBass, bass);
      gl.uniform1f(uTreble, treble);
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
