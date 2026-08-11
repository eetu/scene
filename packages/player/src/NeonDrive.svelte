<script lang="ts">
  // A night drive through a neon city, seen from the side: the car holds its
  // place a third of the way in and the world streams past it in layers, each
  // at its own rate — the flat, cheap depth cue a hardware scroller had, and the
  // reason a 2D scene reads as distance at all.
  //
  // Drawn at 144 lines into an offscreen buffer and magnified with nearest-
  // neighbour, so the picture has real pixels: a hard edge stays hard however
  // large the pane gets, and a frame costs the same on a phone and on a 4K
  // panel. Gradients are allowed *inside* the buffer — at this size one spans a
  // handful of pixels and quantises itself.
  //
  // The car, the street furniture, the roof furniture and the signs are sprites
  // off one baked atlas (drive-sprites.ts); the sky, the road, the weather and
  // the lighting are drawn. That split is the old one: art for the things that
  // have a shape, code for the things that have a state.
  //
  // Intentionally dark, and intentionally magenta/cyan — a self-lit scene, not a
  // themed panel, so it does NOT follow the app's light/dark theme or its accent
  // (Tunnel and Starfield take the same line).
  //
  // The music drives the speed, the skyline's windows and the storm; the weather
  // drives everything else, and it is deliberately slow — moods hold for the
  // best part of two minutes and cross-fade over six seconds, so the sky never
  // changes *because someone is watching*.
  import { fitCanvas2d } from "./canvas2d";
  import {
    BRIDGE_TOWER_GAP,
    buildProps,
    buildRoute,
    buildSkyline,
    clamp01,
    dwellFor,
    FADE,
    hashSeed,
    type Layer,
    MARIA,
    mix,
    mixSky,
    type Mood,
    MOODS,
    moonLit,
    moonPhaseAt,
    nextMood,
    noise,
    type Prop,
    rgb,
    rng,
    ROUTE_SPAN,
    routeAt,
    type Segment,
    SKY,
    type Sky,
  } from "./drive-scene";
  import {
    type Atlas,
    bakeAtlas,
    CAR_H,
    CAR_W,
    CAR_WHEELS,
    CROWN_NAMES,
    drawSprite,
    SIGN_NAMES,
    SIGN_SIZES,
  } from "./drive-sprites";
  import { playback, sampleBands } from "./player.svelte";
  import { driveFrames } from "./raf";

  let { active = true }: { active?: boolean } = $props();

  let canvas: HTMLCanvasElement | null = $state(null);

  // The picture's real size. Height is fixed so a pixel stays the same size
  // relative to the scene however the pane is shaped; width follows the aspect,
  // clamped so an extreme pane neither squeezes the city into a strip nor pays
  // for pixels nobody can see.
  const BUF_H = 144;
  const BUF_W_MIN = 192;
  // Wide enough to cover a 3.5:1 pane without cropping. A letterbox pane that has
  // to be cropped loses sky, which hands the road a bigger share of the picture
  // and its lane furniture starts reading as clutter; paying for the extra
  // columns instead keeps the composition the scene was drawn for.
  const BUF_W_MAX = 512;

  const HORIZON = 92; // where the sky stops and the ground starts
  const FAR_BASE = HORIZON - 1;
  const MID_BASE = HORIZON + 4;
  const RAIL_Y = HORIZON + 9; // the guardrail on the far side of the road
  const GROUND_Y = 128; // the car's contact line

  const FAR_SPAN = 420;
  const MID_SPAN = 520;

  // Mostly the scene's two colours; a minority of windows are the old sodium
  // yellow, which is what keeps the other two reading as neon.
  const WINDOW_HUES = ["#7de8ff", "#ff5fd0", "#ffd070"];

  $effect(() => {
    const el = canvas;
    if (!el) return;

    let w = 0;
    let h = 0;
    const fit = fitCanvas2d(el, (fw, fh) => {
      w = fw;
      h = fh;
    });
    if (!fit) return;
    const g2 = fit.ctx;

    // The buffer everything is drawn into — the only place with pixels in it.
    const buf = document.createElement("canvas");
    const p = buf.getContext("2d");
    if (!p) {
      fit.stop();
      return;
    }
    let bw = 0;
    const bh = BUF_H;

    const atlas: Atlas = bakeAtlas();
    const SPOKE_FRAMES = atlas.frames("spoke");
    const PALM_FRAMES = atlas.frames("palm");

    // The moon is the one sprite that cannot be authored: it has to be redrawn
    // whenever its phase moves, so it is baked here and re-baked only when the
    // terminator has actually shifted a pixel's worth.
    const moonCnv = document.createElement("canvas");
    const moonCtx = moonCnv.getContext("2d");
    const MOON_R = 11;
    // An EVEN number of pixels across, sampled at pixel centres. With an odd
    // width there is a middle column sitting exactly on the terminator at a
    // quarter, and whichever way that column falls the half moon comes out 47%
    // or 52% lit instead of 50%. Half-pixel sampling splits the disc down the
    // join, so every phase renders the exact illuminated fraction.
    moonCnv.width = MOON_R * 2;
    moonCnv.height = MOON_R * 2;
    let moonBaked = -1;

    // Reduced motion damps the travel, not the frame rate — a slow drive is
    // still a drive. Lightning is capped separately: a full-frame white flash is
    // the one thing here that is genuinely a problem to see.
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0.35 : 1;

    // ---- the world, reseeded per track ----
    let worldKey = " "; // no track hashes to this, so the first frame builds
    let far: Layer = { span: FAR_SPAN, towers: [] };
    let midCity: Layer = { span: MID_SPAN, towers: [] };
    let route: Segment[] = [{ start: 0, len: ROUTE_SPAN, kind: "street" }];
    let props: Prop[] = [];
    let stars: { x: number; y: number; b: number }[] = [];

    function buildWorld(key: string) {
      const rnd = rng(hashSeed(key || "drive"));
      far = buildSkyline(rnd, {
        span: FAR_SPAN,
        minW: 5,
        maxW: 13,
        minH: 12,
        maxH: 38,
        windows: false,
        crowns: CROWN_NAMES.length,
      });
      midCity = buildSkyline(rnd, {
        span: MID_SPAN,
        minW: 9,
        maxW: 22,
        minH: 22,
        maxH: 74,
        windows: true,
        channels: 8,
        signs: 0.55,
        signSprites: SIGN_NAMES.length,
        signSizes: SIGN_SIZES,
        crowns: CROWN_NAMES.length,
      });
      route = buildRoute(rnd);
      props = buildProps(rnd, route);
      stars = Array.from({ length: 90 }, () => ({
        x: rnd(),
        y: 3 + rnd() * (HORIZON - 26),
        b: rnd(),
      }));
    }

    // Weather and moon belong to the session, not the tune: a track change is a
    // cut in the music, not in the sky, and a moon that jumped phase every three
    // minutes would be the most obvious thing on screen.
    const wrnd = rng(hashSeed("weather") ^ 0x9e3779b9);
    const moonOffset = wrnd() * Math.PI * 2;

    // Weather override, for LOOKING at the scene rather than for the app: the
    // real weather holds a mood for the best part of two minutes and picks the
    // next one at random, which is right for a visualiser and useless for
    // inspecting one. `?weather=snow` pins a mood, `?weather=cycle` walks the
    // whole table on a short dwell. Without the parameter nothing here changes.
    const forced = new URLSearchParams(window.location.search).get("weather");
    const pinned = (MOODS as readonly string[]).includes(forced ?? "") ? (forced as Mood) : null;
    const cycling = forced === "cycle";
    const CYCLE_DWELL = 10;

    let mood: Mood = pinned ?? "clear";
    let prevMood: Mood = mood;
    let fade = 1; // 0 mid-change, 1 settled
    let dwell = pinned ? Infinity : cycling ? CYCLE_DWELL : dwellFor(wrnd);
    // Set once the weather has been driven by hand, which is the signal that
    // somebody is looking AT it: the road then reaches its state in seconds
    // instead of over the half minute the weather itself takes.
    let inspecting = forced !== null;

    /** `n` steps the weather on. Same guard as the pane's fullscreen shortcut:
     *  stay out of the way of anything being typed into. */
    function onWeatherKey(e: KeyboardEvent) {
      if (e.key !== "n" && e.key !== "N") return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return;
      }
      inspecting = true;
      prevMood = mood;
      mood = nextMood(mood, wrnd);
      dwell = pinned ? Infinity : cycling ? CYCLE_DWELL : dwellFor(wrnd);
      fade = 0;
    }
    window.addEventListener("keydown", onWeatherKey);

    // ---- frame state ----
    let clock = 0; // seconds of playback: weather, moon and every wobble
    let scroll = 0; // the near layer's travel, in buffer pixels
    let speed = 0; // eased, px/s
    let wheel = 0; // spoke frame accumulator
    let pulse = 0; // beat kick, decays
    let level = 0; // eased overall energy
    let lastBeat = -1;
    let flash = 0; // lightning, decays
    let snowPack = 0; // 0..1 snow settled on the road, slow to arrive and to go
    let boltAt = -99;
    let bolt: { x: number; y: number }[] = [];
    // One at a time, and only ever in a clear sky. Null when there isn't one.
    let meteor: {
      x: number;
      y: number;
      dir: 1 | -1;
      speed: number;
      life: number;
      bright: number;
      t: number;
    } | null = null;
    let meteorAt = -99;

    const RAIN = 300;
    const rainD = Array.from({ length: RAIN }, () => ({
      x: Math.random(),
      y: Math.random(),
      z: Math.random(),
    }));
    const SNOW = 130;
    const snowD = Array.from({ length: SNOW }, () => ({
      x: Math.random(),
      y: Math.random(),
      z: Math.random(),
      ph: Math.random() * Math.PI * 2,
    }));

    // ---------- painters ----------

    /** Sky in bands rather than one gradient: a hard step between colours is
     *  what a low-colour machine could put on screen, and it gives the lightning
     *  something to bite on. */
    function paintSky(g: CanvasRenderingContext2D, sky: Sky) {
      const BANDS = 16;
      for (let i = 0; i < BANDS; i++) {
        const t = i / (BANDS - 1);
        const y = Math.round(HORIZON * (1 - t));
        const nextY = i === BANDS - 1 ? 0 : Math.round(HORIZON * (1 - (i + 1) / (BANDS - 1)));
        // Squared falloff: the city's glow is a horizon effect — thin and
        // bright, not half the sky.
        const k = t * t;
        g.fillStyle = rgb([
          mix(sky.horizon[0], sky.top[0], k),
          mix(sky.horizon[1], sky.top[1], k),
          mix(sky.horizon[2], sky.top[2], k),
        ]);
        g.fillRect(0, nextY, bw, y - nextY + 1);
      }
    }

    function paintStars(g: CanvasRenderingContext2D, sky: Sky, treble: number) {
      const a = sky.stars * (1 - sky.haze * 0.6);
      if (a < 0.04) return;
      for (const s of stars) {
        // Twinkle is per-star and driven by the top of the spectrum, where a
        // hi-hat lives — the sky ticks with the pattern.
        const tw = 0.55 + 0.45 * Math.sin(clock * (1 + s.b * 3) + s.b * 40);
        const bright = a * (0.35 + s.b * 0.65) * (tw + treble * 0.5);
        if (bright < 0.05) continue;
        g.fillStyle = `rgba(220,240,255,${Math.min(1, bright)})`;
        g.fillRect(Math.round(s.x * bw), Math.round(s.y), 1, 1);
      }
    }

    /**
     * A shooting star, when there is a sky to see one in.
     *
     * Gated the way the lightning is: it needs the conditions (a sky with stars
     * in it, so the cloudy moods never get one), a gap since the last, and to win
     * a roll — otherwise the rare thing becomes the regular thing and stops being
     * worth catching. It is NOT on the beat: the storm belongs to the music, a
     * meteor belongs to the sky.
     *
     * Drawn as whole-pixel steps, two across for one down, for the same reason
     * the rain is: a fractional slope at this resolution gives a stair with an
     * uneven tread, which reads as a dotted line rather than as something moving
     * fast in a straight line.
     */
    function paintMeteor(g: CanvasRenderingContext2D) {
      if (!meteor) return;
      const t = meteor.t / meteor.life;
      // In and out rather than on and off — a streak that pops is a dropped frame.
      const a = Math.sin(Math.PI * t) * meteor.bright;
      if (a < 0.03) return;
      const hx = meteor.x + meteor.dir * meteor.speed * meteor.t;
      const hy = meteor.y + meteor.speed * 0.5 * meteor.t;
      if (hy > HORIZON - 22) return;
      const tail = Math.round(4 + a * 7);
      for (let k = tail; k >= 0; k--) {
        const px = Math.round(hx - meteor.dir * k * 2);
        const py = Math.round(hy - k);
        if (px < -2 || px >= bw || py < 0) continue;
        const fall = 1 - k / (tail + 1);
        g.fillStyle =
          k === 0
            ? `rgba(255,255,255,${Math.min(1, a * 1.2)})`
            : `rgba(210,232,255,${a * fall * 0.7})`;
        // Three across per step, not one: the steps are two apart, so a single
        // pixel each leaves them touching at the corners and the streak reads as
        // a dotted line. Overlapping by a column makes it one mark travelling.
        g.fillRect(meteor.dir > 0 ? px : px - 2, py, 3, 1);
      }
    }

    /** Bake the disc a pixel at a time: the terminator is a curve on a grid this
     *  coarse, and compositing two arcs at 22 pixels across gives a soft grey
     *  edge where the picture wants a hard one. */
    function bakeMoon(phase: number) {
      if (!moonCtx) return;
      moonCtx.clearRect(0, 0, moonCnv.width, moonCnv.height);
      for (let y = -MOON_R; y < MOON_R; y++) {
        for (let x = -MOON_R; x < MOON_R; x++) {
          // Pixel centres, not corners — see the canvas sizing above.
          const nx = (x + 0.5) / MOON_R;
          const ny = (y + 0.5) / MOON_R;
          if (nx * nx + ny * ny > 1) continue;
          const lit = moonLit(nx, ny, phase);
          let shade = lit ? 1 : 0.12; // earthshine keeps the dark limb present
          if (lit) {
            for (const [mx, my, mr] of MARIA) {
              const d = Math.hypot(nx - mx, ny - my);
              if (d < mr) shade -= 0.22 * (1 - d / mr);
            }
            // Limb darkening — without it the disc reads as a flat sticker.
            shade -= 0.18 * (nx * nx + ny * ny);
          }
          const v = Math.max(0, Math.min(1, shade));
          moonCtx.fillStyle = `rgb(${(228 * v + 14) | 0},${(224 * v + 16) | 0},${(238 * v + 30) | 0})`;
          moonCtx.fillRect(x + MOON_R, y + MOON_R, 1, 1);
        }
      }
    }

    function paintMoon(
      g: CanvasRenderingContext2D,
      sky: Sky,
      cx: number,
      cy: number,
      phase: number,
    ) {
      const bright = sky.moon * (1 - sky.haze * 0.45);
      if (bright < 0.05) return;
      const key = Math.round(phase * 96);
      if (key !== moonBaked) {
        bakeMoon(phase);
        moonBaked = key;
      }
      // Halo: wider and softer through cloud, tighter and brighter as the track
      // gets loud — the only thing the moon reacts to.
      const haloR = MOON_R * (2.2 + sky.haze * 2.4 + level * 0.9);
      const halo = g.createRadialGradient(cx, cy, MOON_R * 0.6, cx, cy, haloR);
      halo.addColorStop(0, `rgba(190,220,255,${0.3 * bright})`);
      halo.addColorStop(0.45, `rgba(150,120,255,${0.12 * bright})`);
      halo.addColorStop(1, "rgba(120,90,255,0)");
      g.fillStyle = halo;
      g.fillRect(cx - haloR, cy - haloR, haloR * 2, haloR * 2);
      g.globalAlpha = bright;
      g.drawImage(moonCnv, cx - MOON_R, cy - MOON_R);
      g.globalAlpha = 1;
    }

    /** Cloud as banks of flat-bottomed columns from a sampled sine sum, so it
     *  costs a few dozen rectangles and tiles forever. */
    function paintClouds(g: CanvasRenderingContext2D, sky: Sky) {
      if (sky.haze < 0.12) return;
      const drift = scroll * 0.012;
      for (let band = 0; band < 3; band++) {
        const baseY = 12 + band * 13;
        const a = sky.haze * (0.3 - band * 0.06);
        g.fillStyle = `rgba(${28 + band * 6},${14 + band * 4},${48 + band * 8},${a})`;
        for (let x = 0; x < bw; x += 2) {
          const u = (x + drift * (1 + band * 0.4)) * 0.035;
          const top =
            baseY +
            Math.sin(u + band) * 5 +
            Math.sin(u * 2.7 + band * 3) * 3 +
            Math.sin(u * 0.6) * 4;
          g.fillRect(x, Math.round(top), 2, Math.round(16 - band * 3));
        }
      }
    }

    /** One tiling strip of towers, drawn twice so it never runs out. */
    function paintSkyline(
      g: CanvasRenderingContext2D,
      layer: Layer,
      factor: number,
      baseY: number,
      near: [number, number, number],
      farC: [number, number, number],
      sky: Sky,
      lit: boolean,
      vu: number[],
      mid: number,
    ) {
      const off = -(((scroll * factor) % layer.span) + layer.span) % layer.span;
      // As many copies of the strip as the buffer is wide enough to need. A fixed
      // two passes was right while the buffer was narrower than the strip and
      // left the right-hand columns of a letterbox pane empty once it was not.
      for (let ox = off; ox <= bw; ox += layer.span) {
        for (const t of layer.towers) {
          const sx = Math.round(ox + t.x);
          if (sx + t.w < 0 || sx > bw) continue;
          const dimming = 1 - sky.haze * 0.35;
          g.fillStyle = rgb([
            mix(farC[0], near[0], t.shade) * dimming,
            mix(farC[1], near[1], t.shade) * dimming,
            mix(farC[2], near[2], t.shade) * dimming,
          ]);
          const topY = baseY - t.h;
          g.fillRect(sx, topY, t.w, t.h);

          if (t.crown >= 0) {
            const name = CROWN_NAMES[t.crown];
            const r = atlas.rect(name);
            if (r) {
              const cx = sx + Math.round((t.w - r.w) / 2);
              drawSprite(g, atlas, name, cx, topY - r.h);
              // The mast carries an aircraft light: the one red in the scene,
              // and slow enough to notice rather than to flicker.
              if (name === "crownMast" && Math.sin(clock * 1.6 + t.x) > 0.4) {
                g.fillStyle = "rgba(255,60,90,0.9)";
                g.fillRect(cx + ((r.w / 2) | 0), topY - r.h - 1, 1, 1);
              }
            }
          }
          if (!lit) continue;

          for (const win of t.windows) {
            const chLevel = vu.length ? vu[win.ch % vu.length] : 0;
            // Every window has its own threshold, so a loud channel lights a
            // block of a tower rather than switching all of it at once.
            if (win.bias > 0.22 + chLevel * 0.6) continue;
            g.globalAlpha = Math.min(1, (0.35 + chLevel * 0.6) * (1 - sky.haze * 0.5));
            // One hue per tower; the mixed towers (hue 2) split per window, and
            // a few windows everywhere burn the old sodium yellow.
            const hue = win.bias > 0.94 ? 2 : t.hue === 2 ? (win.bias < 0.5 ? 0 : 1) : t.hue;
            g.fillStyle = WINDOW_HUES[hue];
            g.fillRect(sx + win.dx, topY + win.dy, 1, 2);
          }
          g.globalAlpha = 1;

          for (const sign of t.signs) {
            const name = SIGN_NAMES[sign.sprite];
            const r = atlas.rect(name);
            if (!r) continue;
            const blink = Math.sin(clock * sign.rate + sign.phase);
            if (blink < -0.8) continue; // a dead beat in the tube
            const x = sx + sign.dx;
            const y = topY + sign.dy;
            const glow = 0.4 + 0.35 * Math.max(0, blink) + mid * 0.45;
            g.fillStyle = `rgba(${sign.hue === 0 ? "255,59,212" : "57,246,255"},${Math.min(0.3, glow * 0.2)})`;
            g.fillRect(x - 1, y - 1, r.w + 2, r.h + 2);
            // Frame 1 is the sign with sections failing — it flickers on the
            // downbeat of its own blink, not on every frame.
            const failing = blink < -0.55 && atlas.frames(name) > 1;
            drawSprite(g, atlas, name, x, y, failing ? 1 : 0, sign.hue);
          }
        }
      }
    }

    /** Signs are what a wet road has to reflect, so they are collected while the
     *  skyline is drawn and smeared downward once the tarmac is down. */
    const reflections: { x: number; w: number; colour: string; glow: number }[] = [];

    function collectReflections(layer: Layer, factor: number, mid: number) {
      reflections.length = 0;
      const off = -(((scroll * factor) % layer.span) + layer.span) % layer.span;
      for (let ox = off; ox <= bw; ox += layer.span) {
        for (const t of layer.towers) {
          const sx = Math.round(ox + t.x);
          if (sx + t.w < 0 || sx > bw) continue;
          for (const sign of t.signs) {
            const r = atlas.rect(SIGN_NAMES[sign.sprite]);
            if (!r) continue;
            const blink = Math.sin(clock * sign.rate + sign.phase);
            if (blink < -0.8) continue;
            // Narrower than the sign, and quieter the taller the sign is. A
            // reflection is a suggestion of a light source, not a copy of it: the
            // kana columns are 25 pixels of lit tube, and smearing all of that
            // down the tarmac put wavy teal slabs across the far lane.
            const width = Math.min(r.w, 4);
            reflections.push({
              x: sx + sign.dx + Math.round((r.w - width) / 2),
              w: width,
              colour: sign.hue === 0 ? "255,59,212" : "57,246,255",
              glow: (0.5 + 0.5 * Math.max(0, blink) + mid * 0.3) * (8 / (4 + r.h * 0.5)),
            });
          }
        }
      }
    }

    function paintRoad(g: CanvasRenderingContext2D, sky: Sky) {
      // Asphalt: darkest at the horizon, opening up toward the camera where the
      // car's own light reaches it.
      const road = g.createLinearGradient(0, HORIZON, 0, bh);
      road.addColorStop(0, "#120a1e");
      road.addColorStop(0.35, "#0d0714");
      road.addColorStop(1, "#16091f");
      g.fillStyle = road;
      g.fillRect(0, HORIZON, bw, bh - HORIZON);

      // The city's glow bleeding onto the far edge of the tarmac.
      const bleed = g.createLinearGradient(0, HORIZON, 0, HORIZON + 22);
      bleed.addColorStop(0, `rgba(${sky.horizon.map((c) => c | 0).join(",")},0.5)`);
      bleed.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = bleed;
      g.fillRect(0, HORIZON, bw, 22);

      // Reflections: a wet road doubles the city, a dry one only hints at it.
      if (sky.wet <= 0.05) return;
      const len = Math.round(6 + sky.wet * 22);
      const shimmer = (clock * 3) | 0; // the surface moves in steps, not per frame
      for (const r of reflections) {
        for (let i = 0; i < len; i++) {
          const t = i / len;
          const a = (1 - t) * (1 - t) * 0.44 * sky.wet * r.glow;
          if (a < 0.02) continue;
          // The smear wanders with the surface water instead of falling straight.
          const jitter = Math.round(Math.sin(i * 0.7 + clock * 3 + r.x) * (1 + sky.wet * 1.5));
          g.fillStyle = `rgba(${r.colour},${a})`;
          // Broken up across its width rather than drawn as a bar: water carries a
          // light in pieces, and an unbroken column of it reads as a solid object
          // lying on the road.
          for (let c = 0; c < r.w; c++) {
            if (noise(r.x + c, i * 3 + shimmer) < 0.34) continue;
            g.fillRect(r.x + jitter + c, HORIZON + 2 + i, 1, 1);
          }
        }
      }
    }

    /**
     * The strip between the city's feet and the roadside — and the part of the
     * picture the route owns. Drawn per column against the route map, so a
     * bridge joint scrolls past like everything else: on a street stretch it is
     * shopfronts, on a bridge it is the water the road is crossing, on a
     * highway it is dark ground with distant traffic. The roadside furniture
     * changes with it — guardrail, bridge railing, concrete barrier.
     */
    function paintBand(g: CanvasRenderingContext2D, sky: Sky) {
      const top = HORIZON + 1;
      const depth = RAIL_Y - top;
      const base = scroll * 0.6;

      for (let x = 0; x < bw; x += 2) {
        const u = base + x;
        const kind = routeAt(route, ROUTE_SPAN, u).kind;
        if (kind === "bridge") {
          // Water. The ripples move on their own clock, not the road's — the
          // river is not driving anywhere.
          g.fillStyle = "#0a0e22";
          g.fillRect(x, top, 2, depth);
          const cell = (u * 2654435761) & 0xffff;
          for (let y = 1; y < depth; y += 2) {
            const ph = Math.sin(clock * 1.3 + (cell % 7) + y * 1.7 + x * 0.11);
            if (ph > 0.55) {
              g.fillStyle = `rgba(90,110,200,${0.12 + (y / depth) * 0.1})`;
              g.fillRect(x, top + y, 2, 1);
            }
          }
          // Rail: an open railing rather than the street's solid rail.
          g.fillStyle = "#2a1a3e";
          g.fillRect(x, RAIL_Y, 2, 1);
          if (((u | 0) & 7) < 2) g.fillRect(x, RAIL_Y - 2, 1, 2); // baluster
        } else if (kind === "highway") {
          // Embankment falling away to far lanes; sparse opposing traffic.
          g.fillStyle = "#0c0714";
          g.fillRect(x, top, 2, depth);
          const cell = ((u / 6) | 0) * 2654435761;
          if ((cell & 31) === 3) {
            g.fillStyle = "rgba(255,110,80,0.5)";
            g.fillRect(x, top + depth - 3 - (cell % 3), 2, 1);
          }
          // Concrete barrier where the others have a rail.
          g.fillStyle = "#38304a";
          g.fillRect(x, RAIL_Y - 1, 2, 3);
          g.fillStyle = "#55506e";
          g.fillRect(x, RAIL_Y - 1, 2, 1);
          if ((u | 0) % 24 < 2) {
            g.fillStyle = "rgba(255,196,120,0.8)"; // barrier reflector
            g.fillRect(x, RAIL_Y, 1, 1);
          }
        } else {
          // Street: shopfront band. Lights are hashed from the world cell, so
          // they belong to the street rather than to the screen.
          g.fillStyle = "#100820";
          g.fillRect(x, top, 2, depth);
          const cell = ((u / 8) | 0) * 2654435761;
          if ((cell & 7) < 2) {
            const warm = (cell & 63) < 9;
            const colour = warm ? "255,208,112" : cell & 8 ? "255,59,212" : "57,246,255";
            const a = (0.3 + level * 0.35) * (1 - sky.haze * 0.4);
            g.fillStyle = `rgba(${colour},${a})`;
            g.fillRect(x, top + 1 + ((cell >> 4) % Math.max(1, depth - 2)), 2, 1);
          }
          // Paper lanterns strung over the shopfronts: the one warm red in the
          // scene, and what says this street has a market on it rather than an
          // office block. Strung in runs with dark stretches between — a lantern
          // every eighth pixel forever is bunting, not a shopfront.
          const strand = ((u / 112) | 0) * 2654435761;
          if ((strand & 7) === 1) {
            const local = ((u % 112) + 112) % 112;
            // The wire sags between its two ends, and the lanterns hang off it.
            const sag = Math.round(Math.sin((local / 112) * Math.PI) * 2.4);
            g.fillStyle = "rgba(90,60,110,0.5)";
            g.fillRect(x, top + sag, 2, 1);
            if (local % 10 < 2) {
              const lit = 0.34 + level * 0.26 + Math.sin(clock * 1.6 + local) * 0.06;
              g.fillStyle = `rgba(255,86,72,${lit})`;
              g.fillRect(x, top + sag + 1, 2, 2);
              g.fillStyle = `rgba(255,180,120,${lit * 0.5})`;
              g.fillRect(x, top + sag + 1, 2, 1);
            }
          }
          g.fillStyle = "#241536";
          g.fillRect(x, RAIL_Y, 2, 2);
          g.fillStyle = "rgba(120,90,180,0.35)";
          g.fillRect(x, RAIL_Y, 2, 1);
        }
      }

      // Bridge main cables: sagging between towers, drawn from the same grid
      // arithmetic that placed the towers so they always meet at the saddles.
      const towerR = atlas.rect("pylonTower");
      if (!towerR) return;
      const topOfTower = RAIL_Y - towerR.h;
      for (let x = 0; x < bw; x += 2) {
        const u = base + x;
        const seg = routeAt(route, ROUTE_SPAN, u);
        if (seg.kind !== "bridge") continue;
        const local = (((u - seg.start) % BRIDGE_TOWER_GAP) + BRIDGE_TOWER_GAP) % BRIDGE_TOWER_GAP;
        const t = local / BRIDGE_TOWER_GAP;
        const y = Math.round(topOfTower + 4 * (RAIL_Y - 8 - topOfTower) * t * (1 - t));
        g.fillStyle = "#3a2a54";
        g.fillRect(x, y, 2, 1);
        if ((local | 0) % 16 < 2 && y < RAIL_Y - 1) {
          g.fillStyle = "#241536"; // hanger down to the deck
          g.fillRect(x, y, 1, RAIL_Y - y);
        }
      }
    }

    /** The roadside furniture the route laid out — the layer the headlights
     *  sweep. The rail itself lives in paintBand, which knows the route. */
    function paintProps(g: CanvasRenderingContext2D, sky: Sky) {
      const off = -(((scroll * 0.6) % ROUTE_SPAN) + ROUTE_SPAN) % ROUTE_SPAN;

      for (let ox = off; ox <= bw; ox += ROUTE_SPAN) {
        for (const pr of props) {
          const sx = Math.round(ox + pr.x);
          if (sx < -24 || sx > bw + 24) continue;
          if (pr.kind === "pylonTower") {
            const r = atlas.rect("pylonTower");
            if (!r) continue;
            drawSprite(g, atlas, "pylonTower", sx - 2, RAIL_Y - r.h);
            // A beacon at the saddle, slow like the skyline masts.
            if (Math.sin(clock * 1.4 + pr.phase) > 0.3) {
              g.fillStyle = "rgba(255,60,90,0.9)";
              g.fillRect(sx, RAIL_Y - r.h - 1, 1, 1);
            }
            continue;
          }
          if (pr.kind === "gantry") {
            const r = atlas.rect("gantry", 0, pr.hue);
            if (!r) continue;
            // Its sign flickers like the city's, on its own phase.
            const failing = Math.sin(clock * 2.1 + pr.phase) < -0.6 && atlas.frames("gantry") > 1;
            drawSprite(g, atlas, "gantry", sx - 11, RAIL_Y - r.h, failing ? 1 : 0, pr.hue);
            continue;
          }
          g.fillStyle = "#1b0f2a";
          g.fillRect(sx, RAIL_Y, 1, 4); // rail post
          if (pr.kind === "palm") {
            // Sway: two frames, stepped per palm rather than per frame, so a row
            // of them moves like trees and not like a flick-book.
            const frame = Math.sin(clock * 1.1 + pr.phase) > 0 || PALM_FRAMES < 2 ? 0 : 1;
            const r = atlas.rect("palm", frame);
            if (r) drawSprite(g, atlas, "palm", sx - 5, RAIL_Y - r.h, frame);
            continue;
          }
          if (pr.kind === "pylon") {
            const r = atlas.rect("pylon");
            if (r) drawSprite(g, atlas, "pylon", sx - 4, RAIL_Y - r.h);
            continue;
          }
          const r = atlas.rect("lamp", 0, pr.hue);
          if (!r) continue;
          const topY = RAIL_Y - r.h;
          drawSprite(g, atlas, "lamp", sx, topY, 0, pr.hue);
          // The cone the lamp drops onto the rail. Cloud thickens it, which is
          // the cheapest way to say the air has water in it.
          const colour = pr.hue === 0 ? "255,59,212" : "57,246,255";
          const glow = 0.7 + level * 0.3;
          const cone = g.createLinearGradient(0, topY, 0, RAIL_Y + 6);
          cone.addColorStop(0, `rgba(${colour},${0.34 * glow * (0.6 + sky.haze * 0.8)})`);
          cone.addColorStop(1, "rgba(0,0,0,0)");
          g.fillStyle = cone;
          g.fillRect(sx + 1, topY + 2, 11, RAIL_Y - topY + 4);
          // The tube itself, bright enough to be the light source it is drawing.
          g.fillStyle = `rgba(${colour},${Math.min(1, 0.8 + level * 0.2)})`;
          g.fillRect(sx + 3, topY + 1, 3, 2);
        }
      }
    }

    /** Lane dashes and the surface closest to the camera — the fastest thing in
     *  the frame, and where the speed actually reads. */
    function paintTarmac(g: CanvasRenderingContext2D) {
      const dashY = GROUND_Y + 9;
      const period = 26;
      const off = -(scroll % period);
      g.fillStyle = "rgba(210,180,255,0.32)";
      for (let x = off; x < bw; x += period) g.fillRect(Math.round(x), dashY, 10, 1);

      // Cat's eyes along the shoulder, moving faster than anything else in the
      // frame. They are what the speed actually reads off — a dashed line alone
      // is ambiguous about how fast it is going.
      const eyeY = bh - 6;
      const eyePeriod = 34;
      const eyeOff = -((scroll * 1.35) % eyePeriod);
      for (let x = eyeOff; x < bw; x += eyePeriod) {
        const px = Math.round(x);
        g.fillStyle = "rgba(255,196,120,0.75)";
        g.fillRect(px, eyeY, 2, 1);
        g.fillStyle = "rgba(255,150,60,0.18)";
        g.fillRect(px - 1, eyeY + 1, 4, 1);
      }

      // Streaks of surface texture running past. Sparse: they are there to give
      // the near tarmac something to move, and a dozen of them do that where two
      // dozen turned the bottom of the frame into hatching.
      for (let i = 0; i < 8; i++) {
        const lane = (i * 7919) % 13;
        const y = bh - 1 - lane;
        const sp = 1.5 + lane * 0.06;
        const x = ((-scroll * sp + i * 97) % (bw + 40)) - 20;
        g.fillStyle = `rgba(150,110,200,${0.035 + (lane / 13) * 0.05})`;
        g.fillRect(Math.round(x), y, Math.round(4 + lane * 0.7), 1);
      }
    }

    /**
     * Snow on the road: the surface turns matte white, and the car cuts a rut in it.
     *
     * A flat tint, NOT accumulated grains. Dithered cover is the obvious way to
     * draw settled snow and the wrong one here — at this magnification the grain
     * reads as noise crawling over the tarmac rather than as a surface, and every
     * variant of it (holes in a sheet, drifts over a sheet) landed somewhere
     * between hatching and television static. What actually says snow is simply
     * that the road has stopped being a road colour.
     */
    function paintSnowpack(g: CanvasRenderingContext2D, sky: Sky) {
      if (snowPack < 0.02) return;
      const top = RAIL_Y + 1;

      // The rail cap holds it before the road does — nothing drives over that.
      g.fillStyle = `rgba(206,216,248,${Math.min(0.7, snowPack * 0.8)})`;
      g.fillRect(0, RAIL_Y - 1, bw, 1);

      // Matte: one flat wash, no gradient and no sheen. Snow is the one surface
      // in this scene that does not take the city's light.
      g.fillStyle = `rgba(196,204,232,${0.88 * snowPack})`;
      g.fillRect(0, top, bw, bh - top);

      // The rut. Seen from the side both wheels ride one line, so it is a single
      // track, and it only runs BACK from the wheels — the road ahead of the car
      // is road it has not been over yet.
      const rutY = GROUND_Y - 1;
      // It ends under the FRONT TYRE, which is the thing laying it — a couple of
      // pixels into that contact patch and no further. Running it to the nose put
      // track on road the car has not reached yet.
      const frontWheel = Math.max(...CAR_WHEELS.map(([wx]) => wx));
      const carEnd = Math.round(bw * 0.3) + frontWheel + 2;
      for (let x = 0; x < carEnd; x++) {
        const u = (x + scroll) | 0;
        // Sharp at the wheels and filling in again toward the edge of frame while
        // it is still coming down: a rut is only as permanent as the weather.
        const cut = clamp01(snowPack) * (1 - (1 - x / carEnd) * sky.snow * 0.8);
        if (cut < 0.05) continue;
        // Cleared back to wet asphalt, two rows of it — one row reads as a wire.
        g.fillStyle = `rgba(14,8,24,${0.35 + cut * 0.6})`;
        g.fillRect(x, rutY, 1, 2);
        // Tread, scrolling with the road so the track reads as being laid rather
        // than painted onto the screen.
        if ((u & 7) < 3) {
          g.fillStyle = `rgba(150,120,200,${cut * 0.3})`;
          g.fillRect(x, rutY + 1, 1, 1);
        }
        // The snow the tyres shouldered aside, heaped along the rut's upper lip.
        // No crumbs flung clear of it: loose pixels sitting off on their own are
        // the one thing that reads as a defect rather than as weather.
        g.fillStyle = `rgba(226,234,255,${cut * 0.55})`;
        g.fillRect(x, rutY - 1, 1, 1);
      }
    }

    function paintCar(g: CanvasRenderingContext2D, sky: Sky) {
      const cx = Math.round(bw * 0.3);
      // Suspension: a slow float plus a kick on the beat, rounded — a sprite
      // sitting between two pixels is the one way to lose the grid.
      //
      // Held inside one pixel either way. The amplitude reads against the
      // 20-pixel-tall car, not against the pane, so a 3px hop is a car being
      // thrown down the road rather than riding it: the float only reaches ±1 at
      // the ends of its travel, and the beat is worth a single pixel of squat.
      const bob = Math.round((Math.sin(clock * 2.1) * 0.55 + pulse * 0.7) * motion);
      const y = GROUND_Y - CAR_H + bob;

      // Underglow, on the road rather than on the car.
      const ug = g.createRadialGradient(
        cx + CAR_W / 2,
        GROUND_Y,
        1,
        cx + CAR_W / 2,
        GROUND_Y,
        CAR_W * 0.6,
      );
      const ua = 0.35 + level * 0.35 + pulse * 0.3;
      ug.addColorStop(0, `rgba(255,59,212,${Math.min(0.9, ua)})`);
      ug.addColorStop(0.5, `rgba(180,40,220,${Math.min(0.5, ua * 0.4)})`);
      ug.addColorStop(1, "rgba(120,0,180,0)");
      g.fillStyle = ug;
      g.fillRect(cx - 12, GROUND_Y - 10, CAR_W + 24, 20);

      // Headlight wash, thrown forward down the road.
      const beam = g.createLinearGradient(cx + CAR_W, GROUND_Y - 6, bw, GROUND_Y + 6);
      const ba = (0.3 + level * 0.4) * (0.6 + sky.haze * 0.7);
      beam.addColorStop(0, `rgba(255,240,200,${Math.min(0.8, ba)})`);
      beam.addColorStop(1, "rgba(255,220,160,0)");
      g.fillStyle = beam;
      g.beginPath();
      g.moveTo(cx + CAR_W - 2, y + 6);
      g.lineTo(bw, GROUND_Y - 16);
      g.lineTo(bw, GROUND_Y + 8);
      g.lineTo(cx + CAR_W - 2, y + 10);
      g.closePath();
      g.fill();

      // Tail glow: three stacked runs, each shorter and fainter than the one
      // below it, so the light falls off in both directions instead of trailing
      // one solid bar the length of a car.
      const ta = 0.3 + pulse * 0.4 + level * 0.22;
      for (let i = 0; i < 3; i++) {
        const len = 20 - i * 6;
        const tail = g.createLinearGradient(cx - len, 0, cx + 2, 0);
        tail.addColorStop(0, "rgba(255,47,106,0)");
        tail.addColorStop(1, `rgba(255,47,106,${Math.min(0.8, ta * (1 - i * 0.25))})`);
        g.fillStyle = tail;
        g.fillRect(cx - len, y + 5 + i * 2, len + 2, 2);
      }

      drawSprite(g, atlas, "car", cx, y);
      // Spokes over the baked wheels: the only moving part on the car, and the
      // one that says the wheels are turning rather than the world sliding.
      const frame = SPOKE_FRAMES ? Math.floor(wheel) % SPOKE_FRAMES : 0;
      for (const [wx, wy] of CAR_WHEELS) drawSprite(g, atlas, "spoke", cx + wx, y + wy, frame);

      // The city catching the car on the beat.
      //
      // The sprite drawn over itself in `lighter`, NOT a rectangle: a band was
      // a guess at where the car is, and on this sprite it landed square on the
      // greenhouse and read as a glowing side window. Compositing the art with
      // itself brightens what is already bright — the cyan roof rim, the glass
      // sheen, the tail — and leaves the dark body dark, which is what a passing
      // light actually does to a car.
      if (pulse > 0.02) {
        g.globalCompositeOperation = "lighter";
        g.globalAlpha = Math.min(0.45, pulse * 0.3);
        drawSprite(g, atlas, "car", cx, y);
        g.globalAlpha = 1;
        g.globalCompositeOperation = "source-over";
      }
    }

    /**
     * How much of a falling drop or flake still shows at this row.
     *
     * Precipitation is drawn in front of the whole scene, but a drop painted over
     * the near tarmac stops reading as weather in the air and starts reading as a
     * speck ON the road: at this magnification an isolated pixel is a blemish,
     * and a drizzle's worth of them is a rash of them. So both rain and snow thin
     * out across the road and are gone by the car's contact line, where the wet
     * is carried by the reflections and the splashes instead.
     */
    const FADE_FROM = HORIZON + 18;
    const nearFade = (py: number) =>
      py < FADE_FROM ? 1 : Math.max(0, (GROUND_Y - py) / (GROUND_Y - FADE_FROM));

    /**
     * Rain, from a still drizzle to a wind-driven downpour.
     *
     * The slant is an integer run — one pixel across every `run` pixels down —
     * rather than a float multiplied per pixel. That matters at this
     * resolution: rounding a fractional slope gives a stair with an uneven
     * tread, and a short streak drawn that way stops reading as a falling drop
     * and starts reading as a glyph scattered over the sky. Whole-pixel steps
     * give the clean diagonals a pixel artist would draw by hand.
     */
    function paintRain(g: CanvasRenderingContext2D, sky: Sky, wind: number) {
      if (sky.rain < 0.02) return;
      const amt = sky.rain;
      const count = Math.round(RAIN * amt);
      // Calm rain falls straight; a gale lays it over to 45°. Nothing between
      // those is a fraction of a pixel.
      // Never steeper than 27° — 45° is a wind that would take the signs with
      // it, and one-in-one diagonals of this length read as glyphs anyway.
      const run = wind < 0.14 ? 0 : wind < 0.45 ? 4 : wind < 0.75 ? 3 : 2;
      const fallRate = 150 + amt * 320;
      for (let i = 0; i < count; i++) {
        const d = rainD[i];
        const z = 0.35 + d.z * 0.65;
        // Far drops are short ticks, near ones longer streaks; drizzle keeps
        // even the near ones short.
        const len = Math.max(2, Math.round((1 + z * 4) * (0.5 + amt * 0.8)));
        const head = ((clock * fallRate * z + d.y * bh * 3) % (bh + 24)) - 12;
        // Its own travel drags the rain backwards past the car.
        const drift = (scroll * z * 0.35 + clock * wind * 60 * z) % bw;
        const x0 = Math.round((((d.x * bw - drift) % bw) + bw) % bw);
        const body = (0.07 + z * 0.13) * (0.6 + amt * 0.5);
        for (let k = 0; k < len; k++) {
          const py = Math.round(head) - k;
          if (py < 0 || py >= bh) continue;
          const fade = nearFade(py);
          if (fade <= 0) continue;
          // The head (the drop) bright, the tail (its motion) faint.
          g.fillStyle =
            k === 0
              ? `rgba(215,235,255,${Math.min(0.8, body * 2.4) * fade})`
              : `rgba(180,210,255,${body * (1 - (k / len) * 0.6) * fade})`;
          g.fillRect(run ? x0 + ((k / run) | 0) : x0, py, 1, 1);
        }
      }

      // Splashes: without them heavy rain falls onto a road it never hits.
      //
      // Each one is a place on the ROAD, so it scrolls away to the left with the
      // road it landed on. The old version put the set at `(tick * K) % bw`, and
      // a multiplier stepped once per tick walks its whole output across the
      // screen at a fixed rate: a rank of dots travelling the wrong way, against
      // the traffic, tied to nothing else in the frame. That reads as a glitch
      // because it is one. (It also multiplied past exact integers after about
      // forty minutes of playing, at which point they clumped into columns.)
      if (amt < 0.45) return;
      const tick = (clock * 7) | 0; // a new set every ~140ms
      const age = clock * 7 - tick; // 0..1 through this set's life
      for (let i = 0; i < 18; i++) {
        const x = Math.round(noise(tick, i * 31) * bw - age * speed * 0.14 * motion);
        if (x < 0 || x >= bw) continue;
        const y = GROUND_Y + 4 + ((noise(tick, i * 31 + 7) * 12) | 0);
        g.fillStyle = `rgba(200,225,255,${(0.18 + amt * 0.2) * (1 - age * 0.7)})`;
        g.fillRect(x, y, 2, 1);
        // The kick-up, for the first half of its life only.
        if (age < 0.5) g.fillRect(x, y - 1, 1, 1);
      }
    }

    function paintSnow(g: CanvasRenderingContext2D, sky: Sky, wind: number) {
      if (sky.snow < 0.02) return;
      const count = Math.round(SNOW * sky.snow);
      for (let i = 0; i < count; i++) {
        const d = snowD[i];
        const z = 0.3 + d.z * 0.7;
        const fall = ((clock * (14 + z * 30) + d.y * bh * 2) % (bh + 8)) - 4;
        const drift = (scroll * z * 0.22 + clock * wind * 24 * z) % bw;
        // Flakes wander as they fall, and lean with the wind while they do.
        const wob = Math.sin(clock * (0.6 + z) + d.ph) * (2 + z * 3) - wind * 6 * z;
        const x = (((d.x * bw + bw - drift + wob) % bw) + bw) % bw;
        const y = Math.round(fall);
        // Flakes land in the snowpack rather than on top of the picture.
        const fade = nearFade(y);
        if (fade <= 0) continue;
        g.fillStyle = `rgba(235,240,255,${(0.35 + z * 0.5) * fade})`;
        g.fillRect(Math.round(x), y, z > 0.8 ? 2 : 1, z > 0.8 ? 2 : 1);
      }
    }

    /** A bolt is a fixed polyline picked at the strike: regenerating the path
     *  every frame turns one flash into three, which is not what lightning does. */
    function strike(seed: number) {
      const x = 20 + seed * (bw - 40);
      const pts = [{ x, y: 0 }];
      let cx = x;
      for (let y = 6; y < HORIZON - 12; y += 7 + Math.random() * 5) {
        cx += (Math.random() - 0.5) * 12;
        pts.push({ x: cx, y });
      }
      bolt = pts;
    }

    function paintLightning(g: CanvasRenderingContext2D, sky: Sky) {
      if (flash < 0.01) return;
      const a = flash * sky.bolt * (motion < 1 ? 0.25 : 1);
      g.fillStyle = `rgba(226,214,255,${Math.min(0.62, a * 0.62)})`;
      g.fillRect(0, 0, bw, HORIZON + 6);
      if (bolt.length < 2 || flash <= 0.35) return;
      for (let i = 1; i < bolt.length; i++) {
        const a0 = bolt[i - 1];
        const b0 = bolt[i];
        const steps = Math.max(1, Math.round(b0.y - a0.y));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const px = Math.round(mix(a0.x, b0.x, t));
          const py = Math.round(mix(a0.y, b0.y, t));
          g.fillStyle = `rgba(255,120,240,${0.35 * a})`;
          g.fillRect(px - 1, py, 3, 1);
          g.fillStyle = `rgba(255,255,255,${Math.min(1, a)})`;
          g.fillRect(px, py, 1, 1);
        }
      }
    }

    // ---------- the frame ----------

    const stopFrames = driveFrames(
      (dt: number) => {
        const key = playback.current?.hash ?? playback.current?.filename ?? "";
        if (key !== worldKey) {
          worldKey = key;
          buildWorld(key);
        }

        const vu = playback.vu;
        const energy = vu.length ? Math.max(...vu) : 0;
        const bands = sampleBands();
        level += ((active ? energy : 0) - level) * 0.09;

        if (lastBeat < 0) lastBeat = playback.beat;
        else if (playback.beat !== lastBeat) {
          lastBeat = playback.beat;
          pulse = 1;
          // Lightning rides the beat but is not *on* it: it needs the storm, a
          // gap since the last one, and to win a coin toss, or the sky becomes a
          // strobe at 125 BPM.
          if (SKY[mood].bolt > 0.5 && clock - boltAt > 1.2 && Math.random() < 0.3) {
            boltAt = clock;
            flash = 1;
            strike(Math.random());
          }
        }
        pulse *= Math.exp(-dt / 0.22);
        flash *= Math.exp(-dt / 0.19);

        // Weather only advances while something is playing: a paused viz should
        // be the same sky when you come back to it.
        if (active) {
          clock += dt;
          dwell -= dt;
          if (dwell <= 0) {
            prevMood = mood;
            mood = nextMood(mood, wrnd);
            dwell = cycling ? CYCLE_DWELL : dwellFor(wrnd);
            fade = 0;
          }
        }
        fade = Math.min(1, fade + dt / FADE);
        // Smootherstep, so no layer starts or stops abruptly at either end.
        const f = fade * fade * fade * (fade * (fade * 6 - 15) + 10);
        const sky = mixSky(SKY[prevMood], SKY[mood], f);

        // Snow settles over about half a minute and leaves faster than it came:
        // rain takes a road back to black long before the cold gives it up. Slow
        // on purpose — a road that whitened inside one bar would be the most
        // obvious thing on screen, and the weather here never is.
        if (active) {
          const settle = sky.snow > 0.04 ? clamp01(sky.snow * 1.3) : 0;
          // While it is being inspected the road has to reach its state in
          // seconds, or stepping to the snow shows a road that has not whitened.
          const rate = inspecting ? 0.9 : settle > snowPack ? 0.045 : 0.09 + sky.rain * 0.4;
          snowPack += (settle - snowPack) * Math.min(1, dt * rate);

          // Shooting stars: only where there are stars to shoot, so the cloudy
          // moods never get one, and roughly one every half minute at best. Rare
          // enough that catching one is luck rather than a feature of the scene.
          if (meteor) {
            meteor.t += dt;
            if (meteor.t > meteor.life) meteor = null;
          } else if (sky.stars > 0.6 && clock - meteorAt > 16 && Math.random() < dt * 0.05) {
            meteorAt = clock;
            const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
            meteor = {
              // Entering from its own side, so the whole streak is on screen.
              x: dir > 0 ? Math.random() * bw * 0.35 : bw * (0.65 + Math.random() * 0.35),
              y: 3 + Math.random() * 20,
              dir,
              speed: (80 + Math.random() * 70) * motion,
              life: 0.5 + Math.random() * 0.45,
              bright: 0.65 + Math.random() * 0.35,
              t: 0,
            };
          }
        }

        const targetSpeed = active ? 30 + level * 150 + pulse * 45 : 3;
        speed += (targetSpeed - speed) * Math.min(1, dt * 2.2);
        scroll += speed * dt * motion;
        wheel += speed * dt * 0.22;

        if (w <= 0 || h <= 0) return;
        const wantW = Math.max(BUF_W_MIN, Math.min(BUF_W_MAX, Math.round((BUF_H * w) / h)));
        if (wantW !== bw) {
          bw = wantW;
          buf.width = bw;
          buf.height = bh;
        }

        const phase = moonPhaseAt(clock, moonOffset);

        paintSky(p, sky);
        paintStars(p, sky, bands.treble);
        paintMeteor(p);
        paintMoon(p, sky, Math.round(bw * 0.72), 30, phase);
        paintClouds(p, sky);
        paintSkyline(p, far, 0.08, FAR_BASE, [46, 24, 74], [26, 14, 46], sky, false, vu, bands.mid);
        collectReflections(midCity, 0.22, bands.mid);
        paintSkyline(
          p,
          midCity,
          0.22,
          MID_BASE,
          [34, 16, 56],
          [22, 10, 38],
          sky,
          true,
          vu,
          bands.mid,
        );
        paintRoad(p, sky);
        paintBand(p, sky);
        paintProps(p, sky);
        paintTarmac(p);
        paintSnowpack(p, sky);
        paintCar(p, sky);
        // Gusts: two slow sines with no common period, so the wind rises and
        // drops without ever repeating on a beat you could count.
        const wind = clamp01(
          sky.wind * (0.8 + 0.3 * Math.sin(clock * 0.19) + 0.15 * Math.sin(clock * 0.73)),
        );
        paintRain(p, sky, wind);
        paintSnow(p, sky, wind);
        paintLightning(p, sky);

        // Magnify. Nearest-neighbour is the point: this is the step that turns
        // the buffer's pixels into the picture's pixels.
        //
        // The buffer is CROPPED to the pane's shape, never stretched to it. Its
        // width is clamped, so a pane wider than 2.67:1 or narrower than 4:3 has
        // no matching buffer to stretch from, and stretching one is what turned
        // the pixels into rectangles the moment the window left that range.
        // Cropping keeps them square at every size; the crop comes off the sky
        // and off the far side of the frame, never off the road or the car.
        const sw = Math.min(bw, Math.round((bh * w) / h));
        const sh = Math.min(bh, Math.round((bw * h) / w));
        const sx = Math.min(Math.max(0, Math.round(bw * 0.3 + CAR_W / 2 - sw / 2)), bw - sw);
        // Vertically the crop comes off the sky, but not all of it: a few rows of
        // the near shoulder go too, so a pane too wide even for the widest buffer
        // does not end up half road. Never past the lane dashes — they are what
        // the speed reads off.
        const spare = bh - sh;
        const sy = spare - Math.min(spare, bh - (GROUND_Y + 12));
        g2.imageSmoothingEnabled = false;
        g2.drawImage(buf, sx, sy, sw, sh, 0, 0, w, h);
        g2.imageSmoothingEnabled = true;
      },
      { active: () => active },
    );

    return () => {
      stopFrames();
      fit.stop();
      window.removeEventListener("keydown", onWeatherKey);
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
