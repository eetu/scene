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
  //
  // Intentionally dark: this is a self-lit neon-on-black scene, not a themed panel,
  // so it does NOT follow the app's light/dark theme (its "themes" are internal wall
  // styles, unrelated to the app theme).
  import {
    beatBpm,
    beatPhase,
    playback,
    readSpectrum,
    sampleBands,
    SPECTRUM_SIZE,
    spectrumSampleRate,
  } from "./player.svelte";
  import { driveFrames } from "./raf";

  let { active = true }: { active?: boolean } = $props();

  let canvas: HTMLCanvasElement | null = $state(null);

  // Human-readable theme names (order matches the shader's themeById ids) — shown
  // briefly as a label when the wall theme changes (or on the 'n' key).
  const THEMES = [
    "Tron",
    "Wormhole",
    "Giger",
    "Vaporwave",
    "Circuit",
    "Rainbow",
    "B&W CRT",
    "Star Wars",
    "Voxel",
    "Corridor",
    "Death Star",
    "Ice Cave",
    "Metro",
    "Abyss",
  ];
  // Theme label — shown only on a manual "next theme" (the 'n' key or a tap on
  // the view), not on the automatic rotation. labelSeq re-keys the element so the
  // fade replays on every request, even if it lands on the same theme name.
  let themeName = $state<string | null>(null);
  let labelSeq = $state(0);

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
    uniform float uIdA;    // current wall theme id (chosen in JS)
    uniform float uIdB;    // next wall theme id
    uniform float uK;      // theme crossfade 0→1 (A→B)
    uniform float uSteps;  // adaptive raymarch step cap (perf)
    uniform float uBurst;  // drop flash 0..1 (big energy jump)
    uniform sampler2D uBands; // 24-bin output spectrum (Voxel theme → per-column bars)
    uniform float uLoop;   // front-to-back somersault: view pitch offset 0→TAU (a full loop)

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
    // Tron: a cold, sharp digital grid on pure black — thin cyan rings + orange
    // rails, with bright cyan data-pulses running the rails toward the camera
    // (lightcycle trails). Kept hard-edged and black-gapped to contrast with the
    // soft sunset Vaporwave.
    vec3 themeTron(float z, float a, float t) {
      float rings = neon(z * RING_FREQ, 0.03); // thinner + sharper than before
      float rails = neon(a * RAIL_FREQ, 0.028);
      float pulse = pow(0.5 + 0.5 * sin(z * 0.9 - t * 5.0 + a * TAU * 2.0), 6.0); // travelling packets
      vec3 col = vec3(0.15, 0.9, 1.0) * rings + vec3(1.0, 0.55, 0.05) * rails;
      col += vec3(0.4, 1.0, 1.0) * rails * pulse; // bright data-pulses ride the rails
      return col; // pure black gaps
    }
    // 2001 star-gate slit-scan: fast colour curtains rushing toward the camera,
    // the hue a single field drifting slowly over time — not a rainbow wrapped
    // around the ring (a*3 wraps seamlessly; hue has no angular term, so each ring
    // is one colour). White-hot cores ride the streak crests.
    vec3 themeWormhole(float z, float a, float t) {
      float streak = pow(0.5 + 0.5 * sin((z * 0.5 - t * 3.0) * TAU + a * TAU * 3.0), 2.0);
      float hue = fract(t * 0.05 + z * 0.008); // one flowing colour, drifts over time
      vec3 c = hsv2rgb(vec3(hue, 0.85, 1.0));
      return c * streak * 1.4 + vec3(1.0) * pow(streak, 4.0) * 0.5;
    }
    // Biomech / Giger: a dark ribbed metal tube — segmented rings along the tube
    // with a wet cold-steel sheen on the crests and near-black crevices between,
    // vertebrae segmentation around the circumference. Cold blue-grey, high
    // contrast (the ribbed biomech corridor look, not soft violet folds).
    vec3 themeGiger(float z, float a, float t) {
      // A dark biomechanical carapace — irregular, skeletal, wet. Deliberately
      // low-key + brooding (horror), NOT a flashy neon theme: near-black oily
      // shell, dim bone ribs, deep shadowed vertebrae grooves, only a faint wet
      // gleam and the slowest ominous "breathing".
      float warp = sin(a * TAU * 3.0 + z * 0.5) * 0.4 + sin(z * 0.9 + uSeed) * 0.3; // organic irregularity
      float ring = 0.5 + 0.5 * sin(z * 5.0 + warp + sin(a * TAU * 2.0) * 0.9);
      float rib = smoothstep(0.1, 0.9, ring); // rib body
      float spine = pow(0.5 + 0.5 * sin(a * TAU * 7.0 + z * 0.5 + warp), 3.0); // deep vertebrae grooves
      float sinew = 0.82 + 0.18 * sin(z * 22.0 + a * TAU * 11.0); // fine tendon detail
      // near-black shell → dim bone ribs; carve deep shadow between the vertebrae.
      vec3 col = mix(vec3(0.005, 0.006, 0.007), vec3(0.075, 0.08, 0.075), rib) * sinew;
      col *= 0.4 + 0.6 * spine;
      // faint, desaturated wet gleam on the crests (dim bone, not bright cyan).
      float wet = pow(smoothstep(0.86, 1.0, ring), 4.0);
      col += vec3(0.15, 0.16, 0.14) * wet * (0.4 + 0.6 * spine);
      col *= 0.88 + 0.12 * sin(t * 0.5 + z * 0.2); // slow, barely-there breathing
      return col;
    }
    // Vaporwave: an 80s sunset, not a grid — a pink→orange→indigo gradient
    // wrapping the tube (never black), with chunky, soft-glowing, receding rings
    // (a horizon feel; rails halved) and a magenta↔cyan neon that pulses over
    // time. Soft + warm to contrast with Tron's hard cold grid.
    vec3 themeVapor(float z, float a, float t) {
      float g = 0.5 + 0.5 * sin(a * TAU + 0.6);                            // 0..1 around the tube
      vec3 sky = mix(vec3(0.08, 0.02, 0.18), vec3(0.9, 0.25, 0.5), g);     // indigo → hot pink
      sky = mix(sky, vec3(1.0, 0.55, 0.28), pow(g, 3.0) * 0.7);            // orange sun-kiss at the peak
      float rings = neon(z * 0.7, 0.09);                                   // chunkier, fewer than Tron
      float rails = neon(a * 8.0, 0.05) * 0.5;                             // half the rails, dimmer
      float grid = max(rings, rails);
      vec3 neonCol = mix(vec3(1.0, 0.15, 0.9), vec3(0.2, 0.95, 1.0), 0.5 + 0.5 * sin(z * 0.15 - t * 1.2));
      return sky * 0.55 + neonCol * grid; // gradient always visible; soft neon on top
    }
    // Circuit board: a dark PCB with warm copper traces + solder pads, brought to
    // life by bright cyan-green current racing ALONG the traces toward the camera
    // (data packets) and hot pads that pulse. 24 traces around (integer → seamless).
    vec3 themeCircuit(float z, float a, float t) {
      float gz = z * 3.0, ga = a * 24.0;
      float traceZ = neon(gz, 0.025), traceA = neon(ga, 0.022);
      float traces = max(traceZ, traceA);
      vec2 cell = fract(vec2(gz, ga)) - 0.5;
      float r = fract(sin(floor(gz) * 12.9 + mod(floor(ga), 24.0) * 78.2 + uSeed) * 43758.5);
      float r2 = fract(sin(floor(gz) * 45.2 + mod(floor(ga), 24.0) * 13.7 + uSeed * 2.0) * 27182.8);
      float pad = smoothstep(0.18, 0.1, length(cell)) * step(0.45, r2); // pads at ~55% of nodes
      // bright packets flowing along the copper — sharp crest (pow 8) gated to a trace
      float packZ = pow(0.5 + 0.5 * sin(gz * 3.14159 - t * 6.0), 8.0) * traceZ;
      float packA = pow(0.5 + 0.5 * sin(ga * 3.14159 - t * 4.0 + r * 6.0), 8.0) * traceA;
      float current = max(packZ, packA);
      float hot = step(0.62, r) * (0.5 + 0.5 * sin(t * 3.0 + r * 20.0)); // hot pads pulse
      vec3 board = vec3(0.015, 0.06, 0.035) * (0.7 + 0.3 * sin(a * TAU + z * 0.1)); // subtle sheen
      vec3 col = board + vec3(0.8, 0.55, 0.25) * (traces + pad) * 0.5; // warm copper
      col += vec3(0.3, 1.0, 0.7) * current * 1.7; // flowing current glow
      col += vec3(0.6, 1.0, 0.9) * pad * hot * 1.3; // pulsing hot pads
      return col;
    }
    // Rainbow: soft pastel spectrum spiralling around + down the tube (hue is
    // cyclic, so a*1.0 = one seamless spectrum around). Low saturation + a lift
    // toward white keeps it pastel; no brightness bands, so no dark spiral line.
    vec3 themeRainbow(float z, float a, float t) {
      float hue = fract(a * 1.0 + z * 0.06 - t * 0.08);
      return mix(hsv2rgb(vec3(hue, 0.5, 1.0)), vec3(1.0), 0.15);
    }
    // Black & white CRT: monochrome phosphor grid over faded TV static — fine,
    // fast-flickering white noise in the background (dead-channel look) with the
    // bright phosphor grid on top.
    vec3 themeBW(float z, float a, float t) {
      float grid = max(neon(z * RING_FREQ, 0.05), neon(a * RAIL_FREQ, 0.04));
      float snow = fract(sin(dot(vec2(floor(z * 80.0), mod(floor(a * 200.0), 200.0)), vec2(12.9898, 78.233)) + floor(t * 24.0)) * 43758.5453);
      return vec3(grid + snow * 0.13); // grid over dim flickering static
    }
    // Star Wars lightspeed jump: a dense wall of blue-white star-streaks stretched
    // along the tube, rushing at the camera on deep blue-black — the "punch it,
    // Chewie" hyperspace run. 90 lanes → seamless around the ring.
    vec3 themeStarwars(float z, float a, float t) {
      float la = a * 90.0;
      float sub = abs(fract(la) - 0.5);                     // 0 at lane centre
      float lane = floor(la);
      float r = fract(sin(lane * 12.9898 + uSeed) * 43758.5453);
      float on = step(0.32, r);                             // most lanes lit → dense wall
      float line = exp(-sub * sub * (150.0 + 120.0 * r));   // very thin streak
      float d = z - uCamZ;                                  // depth ahead of the camera
      float head = mod(d * 0.14 + t * (3.2 + r * 3.5) + r * 20.0, 5.0); // fast heads
      float streak = exp(-head * 1.2);                      // long stretched tail (smear)
      float nearFade = smoothstep(1.0, 9.0, d);
      vec3 star = mix(vec3(0.65, 0.82, 1.0), vec3(1.0), r * r); // blue-white
      return vec3(0.01, 0.02, 0.06) + star * line * streak * on * nearFade * 2.3;
    }
    // Purple voxel tunnel: blocky cells (per-cell purple shade) with dark grout
    // borders, so the wall reads as extruded voxels. Each of the 24 columns around
    // the ring maps to one frequency band (uBands): loud bands glow hot magenta and
    // push their blocks inward (see the raymarch), so the tube reads as an equalizer.
    vec3 themeVoxel(float z, float a, float t) {
      float cz = z * 2.0, ca = a * 24.0; // 24 cells around, integer → seamless
      float r = fract(sin(floor(cz) * 12.9 + floor(ca) * 78.2 + uSeed) * 43758.5);
      vec3 body = mix(vec3(0.18, 0.04, 0.3), vec3(0.65, 0.25, 0.95), r);
      vec2 f = abs(fract(vec2(cz, ca)) - 0.5) * 2.0; // 0 at cell centre → 1 at border
      float lit = 1.0 - smoothstep(0.7, 1.0, max(f.x, f.y)) * 0.85;
      float band = texture2D(uBands, vec2((floor(ca) + 0.5) / 24.0, 0.5)).r; // column level
      return body * lit + vec3(0.95, 0.4, 1.0) * band * band * lit * 0.9; // hot glow on loud columns
    }
    // Spaceship corridor: brushed-metal panels with recessed seams and recurring
    // raised bulkhead frames, lit by twin cyan strips with power pulsing down the
    // hall (and glowing trim where the strips cross a bulkhead). Sleek + alive.
    vec3 themeCorridor(float z, float a, float t) {
      float seams = max(neon(z * 1.0, 0.05), neon(a * 12.0, 0.04)); // panel seams
      float bulk = neon(z * 0.25, 0.045);                           // bulkhead frame every ~4 units
      float sheen = 0.55 + 0.45 * sin(a * TAU * 2.0);               // brushed-metal sheen (seamless)
      vec3 metal = vec3(0.13, 0.145, 0.17) * sheen;
      metal *= 1.0 - 0.55 * seams;                                  // recessed seams
      metal = mix(metal, vec3(0.28, 0.3, 0.34), bulk * 0.8);        // raised, brighter bulkheads
      float strip = neon(a * 2.0, 0.016);                           // twin opposed light strips
      float flow = pow(0.5 + 0.5 * sin(z * 1.2 - t * 5.0), 2.0);    // power pulsing down the corridor
      vec3 col = metal + vec3(0.2, 0.75, 1.0) * strip * (0.35 + 0.9 * flow);
      col += vec3(0.35, 0.85, 1.0) * bulk * strip * 2.0;            // lit bulkhead trim at the strips
      return col;
    }
    // Death Star trench: greebled grey metal — fine panel seams + big structural
    // ribs down the trench, dense static per-cell tone variation (greebles), and a
    // sparse scatter of steady warm/cool running lights. Wears the square shape.
    vec3 themeDeathstar(float z, float a, float t) {
      float panels = max(neon(z * 2.5, 0.02), neon(a * 40.0, 0.02));
      float ribs = neon(z * 0.5, 0.05);
      float ga = floor(a * 64.0);
      float g = fract(sin(floor(z * 8.0) * 12.9 + ga * 78.2 + uSeed) * 43758.5);
      vec3 metal = mix(vec3(0.1, 0.11, 0.12), vec3(0.24, 0.25, 0.27), g * 0.7);
      vec3 col = metal * (1.0 - 0.45 * panels) + vec3(0.06) * ribs;
      float lit = step(0.94, g); // ~6% of cells are running lights
      return col + mix(vec3(1.0, 0.8, 0.5), vec3(0.6, 0.85, 1.0), fract(ga * 0.37)) * lit * 0.7;
    }
    // Ice cave: near-black cold-blue walls with turbulent glacial cracks + bright
    // white-blue caustics swirling around the tube — an icy whirlpool.
    vec3 themeIce(float z, float a, float t) {
      // Ridged, domain-warped turbulence: sharp glacial veins that flow + spiral.
      // Every angular term is an INTEGER multiple of the ring (a*TAU*n), so the
      // texture wraps seamlessly — no hard seam where a=0 meets a=1. Along z the
      // frequencies are non-harmonic (z isn't periodic) to avoid a tiled look.
      float ang = a * TAU;
      float warp = sin(ang * 2.0 + z * 0.5 + t * 0.05) * 0.5 + cos(z * 0.31 + uSeed) * 0.4;
      float zz = z + warp;
      float n = 0.0, amp = 0.55, af = 3.0, zf = 0.8;
      for (int i = 0; i < 4; i++) {
        n += amp * (1.0 - abs(sin(zz * zf + ang * af + uSeed * 1.3))); // ridged veins
        af *= 2.0; // 3,6,12,24 around — integer ⇒ seamless wrap
        zf *= 2.17; // non-harmonic along z
        amp *= 0.55;
        zz += 0.7;
      }
      float crack = pow(smoothstep(0.5, 0.95, n), 1.5); // bright icy veins
      vec3 col = mix(vec3(0.01, 0.03, 0.075), vec3(0.18, 0.38, 0.62), smoothstep(0.15, 0.9, n));
      col += vec3(0.75, 0.9, 1.0) * crack; // cold white-blue crack light
      return col;
    }
    // Metro / mine rail tunnel: warm rough rock walls with a proper track bed on
    // the horseshoe's flat FLOOR — gravel, wooden sleeper cross-ties, and two
    // bright steel rails. The floor sits at a≈0.25 (straight down) in the wall
    // coordinate — the shape + angle share the rolled frame, so the track stays
    // glued to the floor as the tube banks. Warm work-light ambience.
    //
    // Metro STOPS: periodically the running tunnel opens into a brightly lit
    // station — white glazed subway tiles clad the walls and a fluorescent strip
    // lights the platform ceiling. Stations are keyed on absolute z, so one
    // approaches through the fog and slides past rather than popping in; the
    // track bed runs straight through. (A decorative wall mural is on the shelf.)
    vec3 themeMetro(float z, float a, float t) {
      float cell = mod(floor(a * 40.0), 40.0); // wrap the grain cell → no seam at a=0/1
      float grain = fract(sin(floor(z * 4.0) * 12.9 + cell * 78.2 + uSeed) * 43758.5);
      vec3 rock = mix(vec3(0.10, 0.07, 0.04), vec3(0.30, 0.20, 0.11), grain);
      rock *= 0.82 + 0.18 * sin(z * 3.0 + a * TAU * 3.0); // uneven surface
      // Flat floor band of the arch (a≈0.25, ~0.13..0.37). Off it, floorBand→0 so
      // the walls stay bare rock.
      float floorBand = smoothstep(0.15, 0.10, abs(a - 0.25));
      vec3 col = mix(rock, vec3(0.05, 0.045, 0.035), floorBand * 0.75); // dark gravel bed
      float ties = floorBand * smoothstep(0.14, 0.02, abs(fract(z * 1.3) - 0.5));
      col += vec3(0.17, 0.09, 0.04) * ties; // warm wooden sleepers
      // two thin steel rails on the floor with a travelling glint
      float rails = smoothstep(0.012, 0.0, abs(a - 0.205)) + smoothstep(0.012, 0.0, abs(a - 0.295));
      col += vec3(0.9, 0.85, 0.7) * rails * (0.55 + 0.45 * sin(z * 10.0));
      col += vec3(0.24, 0.14, 0.05) * (0.4 + 0.3 * sin(z * 0.5 - t * 0.4)); // work-lights

      // --- metro stop -------------------------------------------------------
      float SPACING = 48.0;                                // world units between stops
      float sIdx = floor(z / SPACING + 0.5);               // nearest station index (per-stop variety)
      float dCenter = abs(z - sIdx * SPACING);             // distance to its centre
      float station = smoothstep(9.0, 6.5, dCenter);       // ~13-unit platform, feathered ends
      float wall = 1.0 - floorBand;                        // tile the walls, keep the track bed
      // White glazed subway tiles, running-bond (alternate rows offset half a tile).
      float NA = 44.0, NZ = 6.0;
      float ra = a * NA, row = floor(ra);
      float rz = z * NZ + 0.5 * mod(row, 2.0);
      vec2 e = abs(vec2(fract(rz), fract(ra)) - 0.5) * 2.0; // 0 centre → 1 tile border
      float grout = smoothstep(0.80, 0.96, max(e.x, e.y));
      float bevel = smoothstep(0.5, 0.95, max(e.x, e.y));
      float tvar = 0.92 + 0.08 * fract(sin(row * 12.9 + floor(rz) * 78.2) * 43758.5);
      vec3 tile = vec3(0.95, 0.94, 0.88) * tvar;           // cream glaze
      tile *= 1.0 - 0.45 * bevel;                          // bevel shading toward the edges
      tile = mix(tile, vec3(0.30, 0.30, 0.33), grout);     // grey grout lines
      // (A decorative mural frieze on the side walls is parked for now — the
      // stops read as clean tiled, lit platforms until it's ready.)
      vec3 wallCol = tile;
      // Even, cool-white platform light on the tiles; a fluorescent strip along the
      // ceiling (a≈0.75) and a gentle overall lift as you pull in.
      vec3 stationCol = wallCol * 0.9 + vec3(0.55, 0.62, 0.72) * 0.22;
      float ceilLight = smoothstep(0.03, 0.0, abs(a - 0.75)) * station;
      stationCol += vec3(1.0, 0.98, 0.9) * ceilLight * 1.3;
      col = mix(col, stationCol, station * wall);
      col += vec3(0.5, 0.55, 0.62) * station * 0.12;       // platform ambience (incl. the floor)
      return col;
    }
    // Abyss mothership: deep violet hull veined with bright cyan-white tech seams —
    // a flowing, pulsing grid, alien and luminous (purple + bright lines).
    vec3 themeAbyss(float z, float a, float t) {
      float lines = max(neon(z * 0.9 - t * 0.5, 0.02), neon(a * 12.0, 0.02));
      float weave = neon(z * 2.0 + a * 24.0 - t * 0.8, 0.015); // finer diagonal weave
      vec3 hull = mix(vec3(0.05, 0.01, 0.12), vec3(0.17, 0.04, 0.33), 0.5 + 0.5 * sin(a * TAU + z * 0.1));
      float pulse = 0.6 + 0.4 * sin(t * 2.0 + z * 0.3);
      vec3 glow = mix(vec3(0.55, 0.9, 1.0), vec3(0.8, 0.5, 1.0), 0.5 + 0.5 * sin(z * 0.2));
      return hull + glow * (lines * 1.4 + weave * 0.6) * pulse;
    }
    vec3 themeById(float id, float z, float a, float t) {
      if (id < 0.5) return themeTron(z, a, t);
      if (id < 1.5) return themeWormhole(z, a, t);
      if (id < 2.5) return themeGiger(z, a, t);
      if (id < 3.5) return themeVapor(z, a, t);
      if (id < 4.5) return themeCircuit(z, a, t);
      if (id < 5.5) return themeRainbow(z, a, t);
      if (id < 6.5) return themeBW(z, a, t);
      if (id < 7.5) return themeStarwars(z, a, t);
      if (id < 8.5) return themeVoxel(z, a, t);
      if (id < 9.5) return themeCorridor(z, a, t);
      if (id < 10.5) return themeDeathstar(z, a, t);
      if (id < 11.5) return themeIce(z, a, t);
      if (id < 12.5) return themeMetro(z, a, t);
      return themeAbyss(z, a, t);
    }
    // Crossfaded wall colour at (z, a) for the current two themes — used for the
    // inner wall and, multi-tapped, for the blurred parallax layer.
    vec3 wall2(float idA, float idB, float k, float z, float a) {
      return mix(themeById(idA, z, a, uTime), themeById(idB, z, a, uTime), k);
    }
    // Tube cross-section per theme: 0=circle, 1=square, 2=hexagon, 3=star,
    // 4=horseshoe (arch), 5=jagged cave. Returned as the "radius" the marcher
    // compares to R, so the tube's silhouette differs by theme; circle/square/hex
    // are exact perpendicular distances, star/jagged are radial modulations.
    float shapeRadius(vec2 p, float shape) {
      if (shape < 0.5) return length(p);               // circle
      if (shape < 1.5) return max(abs(p.x), abs(p.y)); // square
      if (shape < 2.5) {                                // flat-top hexagon
        vec2 q = abs(p);
        return max(q.x * 0.8660254 + q.y * 0.5, q.y);
      }
      if (shape < 3.5) return length(p) / (1.0 + 0.15 * cos(atan(p.y, p.x) * 5.0)); // 5-point star
      if (shape < 4.5) return max(length(p), -p.y / 0.62); // horseshoe: rounded roof + sides, flat floor
      if (shape < 5.5) {
        // jagged ice cave: radius modulated by integer-freq angular bumps
        // (seamless) + a seed → a rough, multi-faceted "snowball" silhouette.
        float ang = atan(p.y, p.x);
        float jag =
          1.0 + 0.14 * cos(ang * 7.0 + uSeed) + 0.09 * cos(ang * 13.0) + 0.06 * cos(ang * 23.0 + uSeed * 2.0);
        return length(p) / jag;
      }
      return length(p * vec2(0.72, 1.3)); // oval — sleek, wider than tall (Abyss ship)
    }
    // Which cross-section each theme wears (ids per themeById order). Specific ids
    // first, so the square catch-all below doesn't swallow the newer themes.
    float shapeOf(float id) {
      if (id > 12.5) return 6.0;            // abyss → oval (sleek)
      if (id > 11.5) return 4.0;            // metro → horseshoe arch
      if (id > 10.5) return 5.0;            // ice → jagged cave
      if (id > 8.5) return 1.0;             // corridor + death star → square
      if (id > 7.5) return 1.0;             // voxel → square
      if (id > 3.5 && id < 4.5) return 2.0; // circuit → hexagon
      if (id > 1.5 && id < 2.5) return 3.0; // giger → star
      return 0.0;                           // everything else → circle
    }

    // Small per-cell hash (used by the voxel wall displacement).
    float rnd1(float n) { return fract(sin(n * 45.233) * 43758.5453); }

    // --- Death Star trench run --------------------------------------------------
    // Where the trench wall opens to space (see main), paint a star sky + green
    // defence-turret tracers instead of the wall. Parameterized by (z along the
    // trench, a around 0..1) like the wall themes, so it streams past as you fly.
    // Star sky, keyed to VIEW DIRECTION (rolled screen dir) rather than position
    // along the trench — so it rotates as the ship banks but barely translates as
    // you fly, reading as deep space FAR beyond the ceiling (parallax vs the near
    // wall). A tiny camZ drift keeps it alive without pulling it "close".
    vec3 trenchSky(vec2 dir) {
      float neb = 0.5 + 0.5 * sin(dir.x * 6.0 + 1.3) * cos(dir.y * 5.0 - 0.7);
      vec3 c = mix(vec3(0.015, 0.02, 0.05), vec3(0.06, 0.03, 0.11), neb);
      // Three depth layers: nearer layers drift a touch faster (subtle parallax
      // among the stars themselves), all far slower than the wall.
      for (int L = 0; L < 3; L++) {
        float fl = float(L);
        float sc = 26.0 + fl * 26.0;
        vec2 g = dir * sc + vec2(uCamZ * 0.008 * (fl + 1.0), 0.0);
        vec2 cell = floor(g);
        float h = rnd1(cell.x * 13.3 + cell.y * 71.9 + fl * 5.0);
        // Crisp pinpoints: most tiny, a few brighter/bigger (magnitude by hash).
        float mag = rnd1(h * 3.3);
        float rad = mix(0.035, 0.1, mag * mag) * (1.0 - fl * 0.2);
        float pt = smoothstep(rad, 0.0, length(fract(g) - 0.5));
        float star = step(0.9 - fl * 0.015, h) * pt * (0.6 + mag);
        float tw = 0.6 + 0.4 * sin(h * 50.0 + uTime * 3.0); // twinkle
        vec3 tint = mix(vec3(1.0), vec3(0.7, 0.82, 1.0), rnd1(h * 9.0));
        c += tint * star * tw * (1.1 + (2.0 - fl) * 0.5);
      }
      return c;
    }
    // Green tracers streaking away down the trench — turret defence fire. Each
    // has a bright head + a trailing streak so it reads as a bolt, not a blob.
    vec3 trenchBolts(float z, float a) {
      vec3 c = vec3(0.0);
      for (int j = 1; j <= 5; j++) {
        float fj = float(j);
        float slot = floor(uTime * 1.1 + fj * 0.41);
        float life = fract(uTime * 1.1 + fj * 0.41);
        float ba = rnd1(slot * 7.3 + fj * 19.0);            // angular lane in the opening
        float bz = uCamZ + mix(0.0, 22.0, life);            // travels away down-trench
        float da2 = abs(fract(a - ba + 0.5) - 0.5);
        float head = smoothstep(0.014, 0.0, da2) * smoothstep(1.3, 0.0, abs(z - bz));
        float trail = smoothstep(0.03, 0.0, da2) * smoothstep(7.0, 0.0, max(0.0, bz - z));
        c += vec3(0.45, 1.0, 0.55) * (head * 2.8 + trail * 0.45) * (1.0 - life * 0.55);
      }
      return c;
    }

    void main() {
      vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
      // Rollercoaster orientation: lean hard into turns (lateral drift ahead) plus
      // a slow, energy-driven barrel roll (uSpin) for continuous motion.
      float roll = clamp(-center(3.0).x * 0.5, -0.8, 0.8) + uSpin;
      float cr = cos(roll), sr = sin(roll);
      uv = mat2(cr, -sr, sr, cr) * uv;

      // Which wall theme is showing (+ crossfade k) — chosen in JS (so the on-
      // screen theme label can't drift from what's drawn) and fed in as uniforms.
      float idA = uIdA, idB = uIdB, k = uK;
      float shapeA = shapeOf(idA), shapeB = shapeOf(idB);
      // Voxel theme (id 8): its crossfade weight → how much the per-column audio
      // displacement shows. Each of the 24 angular cells rides one frequency band
      // (uBands), so loud bands push that column of blocks inward toward the viewer —
      // the tube reads as a cylindrical equalizer (plus a little static jitter).
      float voxAmp = ((idA > 7.5 && idA < 8.5) ? (1.0 - k) : 0.0) +
                     ((idB > 7.5 && idB < 8.5) ? k : 0.0);
      voxAmp *= 0.22;

      // March the ray through the (curved) tube until it crosses the wall. The
      // cross-section radius (morphed A→B) as slack is a valid step, so open space
      // is covered fast and we creep as we near the wall. uFov punches in on beats.
      vec3 rd = normalize(vec3(uv, uFov));
      // ...and pitch over hills from the vertical drift ahead: climbing tilts the
      // view up, cresting tilts it down so the far side drops out of sight. uLoop
      // adds a full front-to-back somersault (0→TAU) — the tube exists behind the
      // camera too, so the ray keeps hitting the wall as the view tumbles over.
      float pitch = clamp(center(3.0).y * 0.34, -0.55, 0.55) + uLoop;
      float cp = cos(pitch), sp = sin(pitch);
      rd = vec3(rd.x, rd.y * cp + rd.z * sp, -rd.y * sp + rd.z * cp);
      float t = 0.0;
      bool hit = false;
      float hitZ = 0.0, hitAng = 0.0, hitDist = 0.0;
      for (int i = 0; i < 104; i++) {
        if (float(i) >= uSteps) break; // adaptive step cap (perf)
        vec3 pos = rd * t;
        vec2 rel = pos.xy - center(pos.z);
        float wallR = R;
        if (voxAmp > 0.0) {
          float a01 = atan(rel.y, rel.x) * 0.15915494 + 0.5;
          float cz = mod(floor((uCamZ + pos.z) * 2.0), 1024.0);
          float cellA = floor(a01 * 24.0);
          float h = rnd1(cz * 31.0 + cellA * 7.0) - 0.5; // −0.5..0.5 static per-cell jitter
          float band = texture2D(uBands, vec2((cellA + 0.5) / 24.0, 0.5)).r; // this column's level
          wallR -= voxAmp * (h * 0.7 + band * 1.5); // subtle static texture + audio bars, inward
        }
        float slack = wallR - mix(shapeRadius(rel, shapeA), shapeRadius(rel, shapeB), k); // >0 inside
        if (slack < 0.003) {
          hit = true;
          hitZ = pos.z;
          hitAng = atan(rel.y, rel.x);
          hitDist = t;
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
        hitDist = t;
        hit = true;
      }

      vec3 col = vec3(0.0);
      if (hit) {
        float z = uCamZ + hitZ;
        float a = hitAng * 0.15915494 + 0.5; // 0..1 around the tube
        // Zone transition: instead of crossfading the whole wall uniformly, the
        // theme boundary flies down the tube toward the camera as k advances. The
        // far end adopts the next theme first, and the seam rushes past — a switch
        // reads as flying into a new zone. bz sweeps FAR→0 over the crossfade; a
        // fragment beyond the boundary (deeper) shows the new theme.
        float bz = mix(FAR, 0.0, k);
        float kz = smoothstep(bz - 5.0, bz + 5.0, hitZ);
        // Wall colour crossfades between the two themes at the moving boundary.
        col = wall2(idA, idB, kz, z, a);
        // Parallax: a blurred, slower copy of the wall shows through the dark gaps
        // of the grid, reading as a second tube set farther out and out of focus
        // behind the inner one. Strongest on neon/grid themes (near-black gaps),
        // faint on solid ones. z*0.3 → slower scroll = a bigger depth gap; the
        // 3-tap z-average softens its grid so it reads as distant/defocused.
        // Star Wars walls are mostly black (all gap), so push this "outside tunnel"
        // harder and blur it across angle too — a soft second layer of streaks
        // beyond the tube, out of focus.
        float effId = mix(idA, idB, kz);
        float hyperAmt = 1.0 - clamp(abs(effId - 7.0), 0.0, 1.0); // Star Wars id
        float gap = smoothstep(0.5, 0.0, dot(col, vec3(0.4)));
        float oz = z * 0.3 + 9.0;
        float ab = 0.05 * hyperAmt; // angular blur for the streak outer layer
        vec3 outer = (wall2(idA, idB, kz, oz - 0.6, a - ab) + wall2(idA, idB, kz, oz, a) +
                      wall2(idA, idB, kz, oz + 0.6, a + ab)) / 3.0;
        col += outer * gap * mix(0.3, 1.0, hyperAmt);
        float fog = exp(-hitDist * 0.055); // by true ray distance (works looking backward mid-loop)
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

        // Trench run — ONLY on the "Death Star" theme (id 11). A fixed-world-angle
        // sector (the trench "top", a≈0.25) opens to space; because the view rolls
        // (uSpin), that sector sweeps around the screen as the ship banks — space
        // up/down/anywhere. Paint an un-fogged star sky + green turret tracers
        // there instead of the wall, fading in with the theme's own crossfade.
        float trench = (abs(idA - 10.0) < 0.5 ? 1.0 - kz : 0.0) + (abs(idB - 10.0) < 0.5 ? kz : 0.0);
        float da = abs(fract(a - 0.25 + 0.5) - 0.5); // angular distance to opening centre
        float sky = (1.0 - smoothstep(0.11, 0.16, da)) * trench; // feathered edge, gated to theme
        if (sky > 0.001) {
          vec3 skyc = trenchSky(uv) + trenchBolts(z, a);
          col = mix(col, skyc, sky);
        }
      }

      // Vanishing-point core glow — fills the deep centre so it reads as a lit
      // tunnel receding, not a black hole.
      col += vec3(0.5, 0.7, 1.0) * 0.16 * smoothstep(0.4, 0.0, length(uv)) * (0.6 + uPulse * 0.6 + uTreble * 0.2);

      // Speed vignette: energetic passages darken the edges for a tunnel-vision rush.
      col *= 1.0 - smoothstep(0.45, 1.0, length(uv)) * uGlow * 0.35;

      // Drop burst: a brief cool-white bloom flash on a big energy jump.
      col += vec3(0.7, 0.85, 1.0) * uBurst * 0.45;

      col = 1.0 - exp(-col); // exponential tonemap → soft neon bloom rolloff

      // Lens post: a radial chromatic fringe (single-pass approximation — channels
      // pushed apart toward the edges) plus a soft vignette. Both lean harder on
      // drops for a lens-punch. Cheap: no second pass / framebuffer.
      float r2 = dot(uv, uv);
      float ca = 0.05 + uBurst * 0.14 + uGlow * 0.04;
      col.r *= 1.0 + r2 * ca;
      col.g *= 1.0 - r2 * ca * 0.35;
      col.b *= 1.0 + r2 * ca * 0.55;
      col *= 1.0 - r2 * (0.09 + uBurst * 0.16); // vignette

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
    const uIdA = gl.getUniformLocation(prog, "uIdA");
    const uIdB = gl.getUniformLocation(prog, "uIdB");
    const uK = gl.getUniformLocation(prog, "uK");
    const uSteps = gl.getUniformLocation(prog, "uSteps");
    const uBurst = gl.getUniformLocation(prog, "uBurst");
    const uBands = gl.getUniformLocation(prog, "uBands");
    const uLoop = gl.getUniformLocation(prog, "uLoop");

    // Output spectrum → a 24×1 luminance texture, one texel per angular column. The
    // Voxel theme samples it so each column of blocks rides a frequency band (a
    // cylindrical equalizer). NPOT is fine here: NEAREST + CLAMP_TO_EDGE, no mipmap.
    const BANDS = 24;
    const F_MIN = 40;
    const F_MAX = 12000; // log-spaced band range (Hz)
    const bandTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bandTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.LUMINANCE,
      BANDS,
      1,
      0,
      gl.LUMINANCE,
      gl.UNSIGNED_BYTE,
      new Uint8Array(BANDS),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(uBands, 0);
    const specBuf = new Uint8Array(SPECTRUM_SIZE);
    const bandVals = new Float32Array(BANDS); // eased per-band levels 0..1
    const bandBytes = new Uint8Array(BANDS);

    // Cap the backing resolution at 1.5× rather than full 2× retina: the tunnel
    // is smooth gradients, so 1.5× looks identical for ~44% fewer fragment-shader
    // invocations per frame (paired with the 60fps cap below, the main heat lever).
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      el.width = Math.max(1, Math.round(rect.width * dpr));
      el.height = Math.max(1, Math.round(rect.height * dpr));
      gl.viewport(0, 0, el.width, el.height);
    });
    ro.observe(el);

    // Keys, scoped to this component (only while the tunnel viz is on screen;
    // ignored while typing): 's' toggles CRT scanlines, 'n' jumps to the next wall
    // theme, 'l' locks/unlocks the theme rotation.
    let clock = 0; // seconds elapsed, for wall animation (uTime)
    const SLOT = 24; // seconds a wall theme holds before crossfading to the next
    let themeTime = 0; // theme-selection clock (frozen while locked)
    let locked = false; // freezes the rotation ('l', or picking a theme with 'n'/tap)
    let scanOn = true; // CRT scanlines on by default
    // Advance to the next wall theme and flash its label. Bound to 'n' and to a
    // tap on the view (the touch equivalent for mobile, where there's no 'n' key).
    // Choosing a theme manually also LOCKS the rotation, so it stays on your pick
    // (no more surprise auto-switches) until you unlock it with 'l'.
    function nextTheme() {
      themeTime = (Math.floor(themeTime / SLOT) + 1) * SLOT;
      themeName = THEMES[themeSlot(Math.floor(themeTime / SLOT))];
      labelSeq++;
      locked = true;
    }
    const onKey = (e: KeyboardEvent) => {
      const ae = document.activeElement;
      const typing = !!ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA");
      if (typing) return;
      if (e.key === "s" || e.key === "S") scanOn = !scanOn;
      else if (e.key === "n" || e.key === "N") nextTheme();
      else if (e.key === "l" || e.key === "L") locked = !locked;
    };
    window.addEventListener("keydown", onKey);
    const onTap = () => nextTheme();
    el.addEventListener("click", onTap);

    // Per-track course seed from the filename (FNV-1a → a stable phase). Read
    // only inside frame() — reading playback.* in the effect body would make the
    // effect re-run (and tear down the GL context) on every beat.
    const seedFor = (name: string) => {
      let hsh = 0x811c9dc5;
      for (let i = 0; i < name.length; i++) hsh = (hsh ^ name.charCodeAt(i)) * 0x01000193;
      return (((hsh >>> 0) % 100000) / 100000) * 12.0;
    };

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
    const TAU = Math.PI * 2;

    // Accessibility: honour prefers-reduced-motion by damping the camera motion
    // (bend, barrel roll, beat punch) to a calm fraction. Read once at mount.
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0.35 : 1.0;

    // Adaptive quality: scale the raymarch step cap by measured frame rate so weak
    // clients (phones / the Pi-served build) stay smooth.
    let steps = 104;
    let fpsAcc = 0;
    let fpsN = 0;

    // JS-authoritative theme rotation (mirrored out of the shader): a seeded
    // per-slot random, held one SLOT then crossfaded to the next.
    // Drop detection state (drives only the burst flash — not a theme change).
    let energyBase = 0;
    let prevEnergy = 0;
    let lastDrop = -1e9;
    let burst = 0; // drop flash, decays
    // Front-to-back turns: each event flips the view a half-turn (180°) about the
    // pitch axis (uLoop), kicked off by a musical drop or, failing that, on a timer,
    // eased over LOOP_DUR. So the view alternates forward → backward (flying in
    // reverse, watching where you've been) → forward, and two turns add up to a full
    // somersault. Skipped under prefers-reduced-motion. loopBase is the resting angle
    // (0 or π), loopPhase −1 = idle, else 0..1 through the current turn.
    let loopPhase = -1;
    let loopBase = 0;
    let lastLoop = -1;
    const LOOP_DUR = 3.6; // seconds for one 180° turn
    const allowLoop = motion >= 1; // no turns under reduced-motion
    const smooth01 = (e0: number, e1: number, x: number) => {
      const s = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
      return s * s * (3 - 2 * s);
    };
    const themeSlot = (slot: number) => {
      // Ordered rotation (Tron → … → Abyss → Tron): 'n' and the auto-advance step
      // to the *next* theme, not a random one. The per-track seed only picks where
      // the cycle starts, so tracks don't all open on the same theme.
      const start = Math.floor((seedVal / 12.0) * THEMES.length); // seedVal ∈ [0,12)
      return (((start + slot) % THEMES.length) + THEMES.length) % THEMES.length;
    };

    // Render through the shared driver: ~60fps cap + hidden-tab pause. dt is real
    // elapsed seconds so travel/animation speed is unaffected by the cap.
    const stop = driveFrames(
      (dt: number, now: number) => {
        clock += dt;

        // Adaptive step cap from a 30-frame window: shed steps on a client that
        // can't hold the cap (weak phone / the Pi-served build). The raise arm only
        // fires below ~1/70s, which can't happen under the 60fps cap — so on capable
        // hardware the cap takes the headroom as fewer frames, not extra steps/heat.
        fpsAcc += dt;
        if (++fpsN >= 30) {
          const avg = fpsAcc / fpsN;
          if (avg > 1 / 48 && steps > 48) steps -= 12;
          else if (avg < 1 / 70 && steps < 104) steps += 12;
          fpsAcc = 0;
          fpsN = 0;
        }

        const key = playback.current?.filename ?? "";
        if (key !== pathKey) {
          pathKey = key;
          seedVal = seedFor(key);
        }

        const energy = playback.vu.length ? Math.max(...playback.vu) : 0;
        // Drop detection: a big jump above the slow energy floor fires a brief
        // burst (screen flash) synced to musical drops. It no longer switches the
        // wall theme — a theme changing on its own just read as confusing.
        energyBase += ((active ? energy : 0) - energyBase) * 0.02;
        let droppedNow = false;
        if (
          active &&
          energy > energyBase + 0.3 &&
          energy > prevEnergy + 0.18 &&
          now - lastDrop > 1200
        ) {
          lastDrop = now;
          burst = 1;
          droppedNow = true;
        }
        prevEnergy = energy;
        burst *= Math.exp(-dt / 0.45);

        // Pick the wall theme (+ crossfade) in JS. The on-screen label is not shown
        // on this automatic rotation — only on a manual advance (see nextTheme).
        if (!locked) themeTime += dt;
        const tp = themeTime / SLOT;
        const nSlot = Math.floor(tp);
        let idA = themeSlot(nSlot);
        let idB = themeSlot(nSlot + 1);
        if (idA === idB) idB = (idB + 1) % THEMES.length;
        const kk = smooth01(0.82, 1.0, tp - nSlot);

        glow += ((active ? energy : 0) - glow) * 0.1;
        // Per-band levels (bass drives the beat punch/pulse, treble the sparkle).
        const b = active ? sampleBands() : { bass: 0, treble: 0 };
        bass += (b.bass - bass) * 0.2;
        treble += (b.treble - treble) * 0.2;
        // Slower envelope so the tube's bendiness breathes with the music rather
        // than twitching per frame; gentle baseline so it's never dead straight.
        bendEnv += ((active ? energy : 0) - bendEnv) * 0.03;
        // Travel speed rides the tempo (fast tune → fast trench run), with energy
        // adding thrust on top. bpmF centres on ~120 BPM = 1×, clamped so extreme
        // tempos stay flyable.
        const bpm = active ? beatBpm() : 0;
        const bpmF = bpm ? Math.max(0.6, Math.min(2, bpm / 120)) : 1;
        const targetSpeed = active ? (2.5 + energy * 6) * bpmF : 0.3;
        speed += (targetSpeed - speed) * 0.05;
        // Beat punch nudges forward briefly; slow barrel roll drifts with energy.
        // Both damped by `motion` for prefers-reduced-motion.
        camZ += speed * (1 + punch * 0.4) * dt;
        spin = (spin + dt * (0.05 + glow * 0.15) * motion) % TAU;

        // Front-to-back turn, timed to the music: kick off a 180° flip on a drop (or
        // every ~25s as a fallback), at most one every 6s, then ease it over LOOP_DUR
        // with zero velocity at both ends so it starts/lands smooth.
        if (lastLoop < 0) lastLoop = now; // defer the first timer turn to +25s from open
        if (
          allowLoop &&
          loopPhase < 0 &&
          active &&
          now - lastLoop > 6000 &&
          (droppedNow || now - lastLoop > 25000)
        ) {
          loopPhase = 0;
          lastLoop = now;
        }
        if (loopPhase >= 0) {
          loopPhase += dt / LOOP_DUR;
          if (loopPhase >= 1) {
            loopBase = (loopBase + Math.PI) % TAU; // land on the new resting angle
            loopPhase = -1;
          }
        }
        // Ease the current half-turn: base + (p − sin(2πp)/2π)·π → +180° with zero
        // velocity at both ends. At rest (idle) it holds loopBase (0 = forward, π =
        // looking back). Each turn advances the same direction, so turns accumulate.
        const loopAngle =
          loopPhase < 0
            ? loopBase
            : loopBase + (loopPhase - Math.sin(loopPhase * TAU) / TAU) * Math.PI;

        if (lastBeat < 0)
          lastBeat = playback.beat; // first frame: adopt, don't flash/punch
        else if (playback.beat !== lastBeat) {
          lastBeat = playback.beat;
          pulse = 1;
          punch = (0.3 + bass * 0.3) * motion; // bassier beats kick a little harder
        }
        pulse *= Math.exp(-dt / 0.22);
        punch *= Math.exp(-dt / 0.4); // slow decay → smooth push, not a jolt

        // Voxel spectrum bars: while the Voxel theme is on screen, push the 24-bin
        // output spectrum into the wall-displacement texture — each column of blocks
        // rides one band (attack fast, release slow so bars pop then ease down).
        if (idA === 8 || idB === 8) {
          if (active && readSpectrum(specBuf)) {
            const hzPerBin = spectrumSampleRate() / 2 / SPECTRUM_SIZE;
            for (let bi = 0; bi < BANDS; bi++) {
              const f0 = F_MIN * Math.pow(F_MAX / F_MIN, bi / BANDS);
              const f1 = F_MIN * Math.pow(F_MAX / F_MIN, (bi + 1) / BANDS);
              const lo = Math.max(1, Math.floor(f0 / hzPerBin));
              const hi = Math.min(SPECTRUM_SIZE, Math.max(lo + 1, Math.ceil(f1 / hzPerBin)));
              let sum = 0;
              for (let i = lo; i < hi; i++) sum += specBuf[i];
              const v = Math.pow(sum / (hi - lo) / 255, 0.7); // lift quiet bins so bars read
              bandVals[bi] += (v - bandVals[bi]) * (v > bandVals[bi] ? 0.6 : 0.15);
              bandBytes[bi] = Math.min(255, Math.round(bandVals[bi] * 255));
            }
          } else {
            for (let bi = 0; bi < BANDS; bi++) {
              bandVals[bi] *= 0.9; // idle: let the bars settle
              bandBytes[bi] = Math.round(bandVals[bi] * 255);
            }
          }
          gl.bindTexture(gl.TEXTURE_2D, bandTex);
          gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            0,
            0,
            BANDS,
            1,
            gl.LUMINANCE,
            gl.UNSIGNED_BYTE,
            bandBytes,
          );
        }

        gl.uniform2f(uRes, el.width, el.height);
        gl.uniform1f(uCamZ, camZ);
        gl.uniform1f(uSeed, seedVal);
        gl.uniform1f(uPulse, pulse);
        gl.uniform1f(uGlow, glow);
        gl.uniform1f(uBend, (0.6 + bendEnv * 0.9) * motion); // straighter under reduced-motion
        gl.uniform1f(uTime, clock);
        gl.uniform1f(uScan, scanOn ? 1 : 0);
        gl.uniform1f(uFov, 1.35 + punch * 0.14); // gentle zoom-push on the beat
        gl.uniform1f(uWave, active ? beatPhase(now) : 1); // 1 = no wave when idle
        gl.uniform1f(uSpin, spin);
        gl.uniform1f(uBass, bass);
        gl.uniform1f(uTreble, treble);
        gl.uniform1f(uIdA, idA);
        gl.uniform1f(uIdB, idB);
        gl.uniform1f(uK, kk);
        gl.uniform1f(uSteps, steps);
        gl.uniform1f(uBurst, burst);
        gl.uniform1f(uLoop, loopAngle);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
      // Idle down to 30fps while paused — the tunnel only coasts then, with no
      // music to react to, so full 60fps is wasted GPU.
      { active: () => active },
    );

    return () => {
      stop();
      ro.disconnect();
      window.removeEventListener("keydown", onKey);
      el.removeEventListener("click", onTap);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
      gl.deleteTexture(bandTex);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  });
</script>

<div class="tunnel">
  <canvas bind:this={canvas}></canvas>
  {#if themeName}
    {#key labelSeq}
      <div class="label">{themeName}</div>
    {/key}
  {/if}
</div>

<style>
  .tunnel {
    position: relative;
    width: 100%;
    height: 100%;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
  /* Theme name, shown briefly on change (re-keyed → the fade replays each time). */
  .label {
    position: absolute;
    left: 12px;
    bottom: 10px;
    font-family: var(--font-retro, ui-monospace, monospace);
    font-size: 13px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #fff;
    text-shadow: 0 0 6px rgba(0, 0, 0, 0.85);
    pointer-events: none;
    animation: tunnel-label 2.6s forwards;
  }
  @keyframes tunnel-label {
    0%,
    55% {
      opacity: 0.92;
    }
    100% {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .label {
      animation: none;
      opacity: 0.6;
    }
  }
</style>
