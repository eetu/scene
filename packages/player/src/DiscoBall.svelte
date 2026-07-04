<script lang="ts">
  // Disco ball — a single fullscreen fragment shader (raw WebGL, no Three.js).
  // A faceted mirror sphere tumbles in a dark neon-grid room ("modern retro");
  // each facet reflects the light into a tight beam that lands as a coloured spot
  // on the walls/floor, so as the ball spins the spots sweep around the room and
  // the ball itself sparkles. Spin speed, spot brightness and colour react to the
  // music (beat kick, energy, bass/treble, drops). CSP-safe (GLSL on the GPU).
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
    uniform float uTime;
    uniform float uSpin;   // ball rotation angle (time + beat)
    uniform float uGlow;   // eased energy 0..1
    uniform float uPulse;  // beat flash 0..1
    uniform float uBass;   // eased bass 0..1
    uniform float uTreble; // eased treble 0..1
    uniform float uBurst;  // drop flash 0..1
    uniform vec3 uLight;   // key-light position — drifts (JS, reduced-motion aware)

    #define NF 32                  // spot-casting facets (Fibonacci, even beams)
    const float GA = 2.3999632;    // golden angle
    const float NLAT = 12.0;       // ball tile rows (latitude bands)
    const float NLON = 24.0;       // ball tile columns (longitude segments)
    const float PI = 3.14159265;
    const float TAU = 6.28318530;
    const vec3 C = vec3(0.0, 0.4, 6.0);  // ball centre
    const float BR = 1.7;                 // ball radius
    const vec3 BOXMIN = vec3(-7.0, -4.0, -1.5);
    const vec3 BOXMAX = vec3(7.0, 4.0, 15.0);

    mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c); }
    mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c); }

    // Modern-retro palette (synthwave magenta→cyan→violet).
    vec3 pal(float h) { return 0.5 + 0.5 * cos(6.2831 * (h + vec3(0.0, 0.33, 0.67)) + 3.6); }


    // Neon grid on a room surface, from the two coords tangent to its normal.
    float grid(vec3 p, vec3 n) {
      vec3 g = abs(fract(p * 0.5 + 0.5) - 0.5) / fwidth(p * 0.5); // crisp lines
      float line = min(min(g.x, g.y), g.z);
      // drop the axis along the surface normal so lines lie in the face
      if (abs(n.x) > 0.5) line = min(g.y, g.z);
      else if (abs(n.y) > 0.5) line = min(g.x, g.z);
      else line = min(g.x, g.y);
      return 1.0 - min(line, 1.0);
    }

    // Quantise a unit direction to the lat/long mirror-tile grid. Returns the
    // tile-centre normal; outputs the in-cell fraction (for grout) + the cell id.
    // The SAME grid shades the ball (from its surface normal) and casts the wall
    // spots (from the light's reflected normal), so tiles and spots always agree.
    vec3 tileQuant(vec3 d, out vec2 frac, out vec2 cell) {
      float lu = (asin(clamp(d.y, -1.0, 1.0)) + 0.5 * PI) / PI * NLAT;
      float ou = (atan(d.x, d.z) + PI) / TAU * NLON;
      cell = vec2(floor(lu), floor(ou));
      frac = vec2(fract(lu), fract(ou));
      float clat = (cell.x + 0.5) / NLAT * PI - 0.5 * PI;
      float clon = (cell.y + 0.5) / NLON * TAU - PI;
      return vec3(cos(clat) * sin(clon), sin(clat), cos(clat) * cos(clon));
    }

    // i-th mirror-facet direction on a Fibonacci sphere (unrotated) — an even
    // spread of beam directions, independent of the ball's visible tiling.
    vec3 facetDir(float fi) {
      float y = 1.0 - 2.0 * (fi + 0.5) / float(NF);
      float r = sqrt(max(0.0, 1.0 - y * y));
      float th = fi * GA;
      return vec3(r * cos(th), y, r * sin(th));
    }

    // Disco spots at a wall point P: each facet reflects the light into a round
    // beam that lands where the wall direction V aligns with the reflected ray.
    // Cast from an even Fibonacci set (not the visible tiles) — it reads better as
    // an effect: cleaner, rounder, sweeping beams as the ball spins.
    vec3 discoSpot(vec3 P, mat3 rot, vec3 toLight) {
      vec3 V = normalize(P - C);
      vec3 spot = vec3(0.0);
      for (int i = 0; i < NF; i++) {
        vec3 R = reflect(-toLight, rot * facetDir(float(i)));
        float d = max(dot(V, R), 0.0);
        vec3 tint = pal(fract(float(i) * 0.137 + 0.2));
        spot += tint * pow(d, 300.0);        // crisp beam (tighter → smaller blob)
        spot += tint * pow(d, 55.0) * 0.16;  // soft bounce halo
      }
      return spot;
    }

    // Shade the room the ray o+d*t sees: dark box + neon grid + the disco spots
    // cast by the ball's tiles + the light fixture itself. Used both for the walls
    // we look at directly AND for what each chrome tile reflects — so the ball is a
    // true mirror of the actual room, spots and all.
    vec3 shadeRoom(vec3 o, vec3 d, mat3 rot, vec3 toLight) {
      vec3 invd = 1.0 / d;
      vec3 t1 = (BOXMIN - o) * invd, t2 = (BOXMAX - o) * invd;
      vec3 tmax = max(t1, t2);
      float tB = min(min(tmax.x, tmax.y), tmax.z);
      vec3 P = o + d * max(tB, 0.0);
      vec3 n = -sign(d) * step(tmax, tmax.yzx) * step(tmax, tmax.zxy);
      vec3 gcol = mix(vec3(1.0, 0.15, 0.6), vec3(0.2, 0.8, 1.0), clamp(P.y * 0.12 + 0.5, 0.0, 1.0));
      vec3 spot = discoSpot(P, rot, toLight);
      vec3 c = vec3(0.015, 0.02, 0.03)
             + gcol * grid(P, n) * (0.12 + uPulse * 0.3)
             + spot * (1.4 + uGlow * 2.8 + uBass * 2.2);
      c *= exp(-tB * 0.06); // fog into depth
      // The light fixture, as a hot disk — seen directly and mirrored by the ball.
      vec3 toL = normalize(uLight - o);
      c += vec3(1.0, 0.95, 0.85) * pow(max(dot(d, toL), 0.0), 200.0) * 3.0;
      return c;
    }

    void main() {
      vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
      vec3 ro = vec3(0.0, 0.0, 0.0);
      vec3 rd = normalize(vec3(uv, 1.5));
      mat3 rot = rotY(uSpin) * rotX(uSpin * 0.5);
      mat3 rotInv = rotX(-uSpin * 0.5) * rotY(-uSpin); // world → ball-local
      vec3 toLight = normalize(uLight - C);

      // Ray → ball (sphere) intersection.
      vec3 oc = ro - C;
      float b = dot(oc, rd);
      float disc = b * b - (dot(oc, oc) - BR * BR);
      float tS = disc > 0.0 ? -b - sqrt(disc) : 1e9;

      // Ray → room (inside of the box): far slab exit = the wall we see.
      vec3 inv = 1.0 / rd;
      vec3 t1 = (BOXMIN - ro) * inv, t2 = (BOXMAX - ro) * inv;
      vec3 tmax = max(t1, t2);
      float tB = min(min(tmax.x, tmax.y), tmax.z);

      vec3 col = vec3(0.0);
      if (tS < tB && tS > 0.0) {
        // --- the chrome ball: uniform lat/long mirror tiles reflecting the room ---
        vec3 P = ro + rd * tS;
        vec3 N = normalize(P - C);
        // Quantise the surface normal into the tile grid (ball-local, spins with
        // it). Each flat tile mirrors the room in one reflected direction.
        vec2 frac, cell;
        vec3 fn = rot * tileQuant(rotInv * N, frac, cell);
        // Grout: darken tile borders for the classic mirrored-tile look.
        float grout = smoothstep(0.0, 0.09, min(frac.x, 1.0 - frac.x))
                    * smoothstep(0.0, 0.09, min(frac.y, 1.0 - frac.y));
        // True planar reflection: sample the room down the mirrored ray. Adjacent
        // tiles face differently → high contrast (some catch the light, most stay
        // dark) → the ball scintillates like real chrome.
        vec3 rdir = reflect(rd, fn);
        vec3 mir = shadeRoom(P, rdir, rot, toLight);
        // Chrome = high contrast: NO broad fill (that just fogs the ball into a flat
        // white sheen). Keep most tiles dark like a real mirror in a dark room and
        // punctuate with sharp bright glints — a tight hot spot of the key light + a
        // small softer falloff, plus a bright reflected horizon line that sweeps
        // across the tiles as the ball turns. Those crisp highlights read as polished
        // chrome, where a uniform sheen reads as matte/faded.
        float sdot = max(dot(rdir, toLight), 0.0);
        mir += vec3(1.0, 0.97, 0.9) * (pow(sdot, 400.0) * 4.0 + pow(sdot, 40.0) * 0.3);
        mir += vec3(0.8, 0.9, 1.0) * smoothstep(0.05, 0.0, abs(rdir.y)) * 0.5;
        float fres = pow(1.0 - max(dot(-rd, N), 0.0), 5.0);
        // Fake per-facet glow: each tile carries a faint colour of its own (keyed off
        // its cell id, so neighbours differ), so the darkest facets read as faintly
        // tinted mirror tiles rather than pure black. Lifts with energy.
        vec3 facetGlow = pal(fract(dot(cell, vec2(0.13, 0.071)) + 0.5)) * (0.06 + uGlow * 0.12);
        col = mir * (0.3 + 0.7 * grout)           // mirror sample, dark grout lines
            + facetGlow * grout                    // faint self-lit facet colour
            + vec3(0.7, 0.85, 1.0) * fres * 0.5;   // cool chrome rim
        col *= 0.9 + uGlow * 0.5;                  // whole ball brightens with energy
      } else {
        // --- room wall / floor: neon grid + the ball's swept disco spots ---
        col = shadeRoom(ro, rd, rot, toLight);
      }

      // --- small lens flare from the ball's specular highlight ---
      vec3 camDirC = normalize(C - ro);
      vec3 H = normalize(-camDirC + toLight);      // highlight-facing normal
      vec3 Hp = C + BR * H;                         // highlight point on the ball
      float faces = smoothstep(0.0, 0.5, dot(H, -camDirC)) * step(0.001, Hp.z);
      vec2 fuv = Hp.xy * 1.5 / Hp.z;                // its screen position
      // (moves on its own as the key light drifts — no arbitrary drift needed)
      vec2 dd = uv - fuv;
      float core = exp(-dot(dd, dd) * 90.0);
      float streak = exp(-dd.y * dd.y * 900.0) * exp(-abs(dd.x) * 4.0) * 0.6;
      float ghost = 0.0;
      for (int g = 1; g <= 3; g++) {
        vec2 gp = mix(fuv, -fuv, float(g) * 0.32);  // ghosts mirrored across centre
        ghost += exp(-dot(uv - gp, uv - gp) * 240.0) * (0.5 / float(g));
      }
      vec3 flare = vec3(1.0, 0.95, 0.85) * (core + streak) + pal(0.05) * ghost;
      col += flare * faces * (0.14 + uGlow * 0.4 + uPulse * 0.3);

      col += vec3(0.7, 0.85, 1.0) * uBurst * 0.4; // drop flash
      col *= 1.0 + uTreble * 0.3;                  // treble sheen
      col = 1.0 - exp(-col);                       // tonemap → bloom rolloff
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  $effect(() => {
    const cv = canvas;
    if (!cv) return;
    const el: HTMLCanvasElement = cv;
    const ctx = el.getContext("webgl", { antialias: true, alpha: false });
    if (!ctx) {
      console.warn("DiscoBall: WebGL unavailable");
      return;
    }
    const gl: WebGLRenderingContext = ctx;
    // fwidth() needs the derivatives extension on WebGL1.
    gl.getExtension("OES_standard_derivatives");

    function compile(type: number, src: string): WebGLShader | null {
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.warn("DiscoBall shader:", gl.getShaderInfoLog(sh));
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    }
    // GLSL_derivatives pragma must precede the precision line — inject it here so
    // fwidth() is available (crisp grid lines).
    const fs = compile(
      gl.FRAGMENT_SHADER,
      "#extension GL_OES_standard_derivatives : enable\n" + FRAG,
    );
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) return;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("DiscoBall link:", gl.getProgramInfoLog(prog));
      return;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const u = (n: string) => gl.getUniformLocation(prog, n);
    const uRes = u("uRes"),
      uTime = u("uTime"),
      uSpin = u("uSpin"),
      uGlow = u("uGlow"),
      uPulse = u("uPulse"),
      uBass = u("uBass"),
      uTreble = u("uTreble"),
      uBurst = u("uBurst"),
      uLight = u("uLight");

    // Cap the backing resolution at 1.5× rather than the full 2× retina: a
    // raymarched ball is all smooth gradients, so 1.5× is visually identical but
    // ~44% fewer fragment-shader invocations per frame (the main heat lever).
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      el.width = Math.max(1, Math.round(rect.width * dpr));
      el.height = Math.max(1, Math.round(rect.height * dpr));
      gl.viewport(0, 0, el.width, el.height);
    });
    ro.observe(el);

    // Accessibility: honour prefers-reduced-motion by damping the ball's spin
    // acceleration and the light's drift to a calm fraction. Read once at mount.
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0.35 : 1.0;

    let clock = 0;
    let spin = 0;
    let spinRate = 0.25; // eased angular velocity — smooths the per-beat spin kick
    let glow = 0;
    let pulse = 0;
    let bass = 0;
    let treble = 0;
    let burst = 0;
    let energyBase = 0;
    let prevEnergy = 0;
    let lastDrop = -1e9;
    let lastBeat = -1;
    // Render through the shared driver: caps at ~60fps (a 120Hz ProMotion iPad
    // won't raymarch twice as often for no visible gain) and pauses while the
    // tab is hidden. dt is real elapsed seconds, so motion speed is unchanged.
    const stop = driveFrames(
      (dt: number, now: number) => {
        clock += dt;

        const energy = active && playback.vu.length ? Math.max(...playback.vu) : 0;
        glow += (energy - glow) * 0.1;
        const bands = active ? sampleBands() : { bass: 0, treble: 0 };
        bass += (bands.bass - bass) * 0.2;
        treble += (bands.treble - treble) * 0.2;

        // Spin: a steady tumble that energy/beat speed up. Ease the angular
        // *velocity* toward its target rather than adding the beat spike straight
        // into the rate — so a beat ramps the spin up and back down smoothly
        // instead of lurching the ball forward on every hit.
        const targetSpin = 0.25 + (glow * 0.9 + pulse * 1.2) * motion;
        spinRate += (targetSpin - spinRate) * (1 - Math.exp(-dt / 0.18));
        spin += dt * spinRate;

        if (lastBeat < 0) lastBeat = playback.beat;
        else if (playback.beat !== lastBeat) {
          lastBeat = playback.beat;
          pulse = 1;
        }
        pulse *= Math.exp(-dt / 0.2);

        // Drop → burst flash.
        energyBase += (energy - energyBase) * 0.02;
        if (
          active &&
          energy > energyBase + 0.3 &&
          energy > prevEnergy + 0.18 &&
          now - lastDrop > 1200
        ) {
          lastDrop = now;
          burst = 1;
        }
        prevEnergy = energy;
        burst *= Math.exp(-dt / 0.45);

        gl.uniform2f(uRes, el.width, el.height);
        gl.uniform1f(uTime, clock);
        gl.uniform1f(uSpin, spin);
        gl.uniform1f(uGlow, glow);
        gl.uniform1f(uPulse, pulse);
        gl.uniform1f(uBass, bass);
        gl.uniform1f(uTreble, treble);
        gl.uniform1f(uBurst, burst);
        // Key light drifts on a slow Lissajous around its base (damped for reduced
        // motion) so the spots sweep with variety and the highlight/flare wander.
        gl.uniform3f(
          uLight,
          -3.0 + Math.sin(clock * 0.3) * 2.5 * motion,
          4.2 + Math.sin(clock * 0.21) * 0.7 * motion,
          2.0 + Math.cos(clock * 0.3) * 2.0 * motion,
        );
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
      // Idle down to 30fps while paused — the ball only drifts then, with no
      // music to react to, so full 60fps is wasted GPU.
      { fps: () => (active ? 60 : 30) },
    );

    return () => {
      stop();
      ro.disconnect();
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
