<script lang="ts">
  // Parallax starfield over a deep-space nebula backdrop: stars stream out of the
  // bright centre leaving motion-blur trails, their speed pulsing with the music's
  // energy and easing to a near-stop when it stops. Periodically the whole field
  // barrel-rolls about the centre for a bit of demoscene flair. (A 3D ship model
  // will be brought in later from ../maquette.) Backdrop is the shared nebula asset.
  import { playback } from "./player.svelte";
  import { driveFrames } from "./raf";
  import bgUrl from "./assets/starfield-bg.jpg";

  let { active = true }: { active?: boolean } = $props();

  let canvas: HTMLCanvasElement | null = $state(null);

  const COUNT = 420;

  // Per-star tint: mostly white, with occasional cool-blue stars (echoing the
  // nebula's glow); two accent-tinted stars are added per-instance from the live
  // theme accent (see the effect) so they follow orange/purple.
  const BASE_TINTS = [
    "255,255,255",
    "255,255,255",
    "255,255,255",
    "255,255,255",
    "255,255,255",
    "255,255,255",
    "255,255,255",
    "190,218,255",
    "160,200,255",
  ];

  // "#rgb"/"#rrggbb" → "r,g,b"; falls back to the amber accent if unparseable.
  function hexToRgb(hex: string): string {
    const m = hex.replace("#", "").trim();
    const full = m.length === 3 ? [...m].map((c) => c + c).join("") : m;
    const n = parseInt(full, 16);
    if (full.length !== 6 || !Number.isFinite(n)) return "247,143,8";
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  }
  function lighten(rgb: string, amt: number): string {
    const [r, g, b] = rgb.split(",").map(Number);
    const up = (c: number) => Math.round(c + (255 - c) * amt);
    return `${up(r)},${up(g)},${up(b)}`;
  }

  $effect(() => {
    const el = canvas;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const g2: CanvasRenderingContext2D = ctx;
    // Non-null handle so the frame closure can read the canvas without re-widening.
    const cnv: HTMLCanvasElement = el;

    let w = 0;
    let h = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      w = r.width;
      h = r.height;
      el.width = Math.max(1, Math.round(w * dpr));
      el.height = Math.max(1, Math.round(h * dpr));
      g2.setTransform(dpr, 0, 0, dpr, 0, 0);
    });
    ro.observe(el);

    const bg = new Image();
    bg.src = bgUrl;

    // Offscreen buffer for the music-driven backdrop ripple: the nebula is
    // downsampled into small blocks here, then redrawn with a radial displacement.
    const buf = document.createElement("canvas");
    const bctx = buf.getContext("2d");

    // Accent-tinted stars follow the theme accent (orange/purple).
    const accentRgb = hexToRgb(getComputedStyle(el).getPropertyValue("--accent") || "#f78f08");
    const PALETTE = [...BASE_TINTS, accentRgb, lighten(accentRgb, 0.55)];

    // Stars in a normalized space: x,y in [-1,1], z (depth) in (0,1].
    const xs = new Float32Array(COUNT);
    const ys = new Float32Array(COUNT);
    const zs = new Float32Array(COUNT);
    const cols: string[] = new Array(COUNT).fill("255,255,255");
    let seed = 1234567;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    function place(i: number, far: boolean) {
      xs[i] = rnd() * 2 - 1;
      ys[i] = rnd() * 2 - 1;
      zs[i] = far ? 1 : rnd();
      cols[i] = PALETTE[(rnd() * PALETTE.length) | 0];
    }
    for (let i = 0; i < COUNT; i++) place(i, false);

    // Draw an image scaled to *cover* the canvas (centre-crop), keeping the
    // centred nebula centred regardless of the pane's aspect ratio.
    function drawCover(img: HTMLImageElement) {
      const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
      g2.drawImage(
        img,
        (w - img.naturalWidth * s) / 2,
        (h - img.naturalHeight * s) / 2,
        img.naturalWidth * s,
        img.naturalHeight * s,
      );
    }

    // Barrel roll: every ROLL_PERIOD seconds of playback the field rotates over
    // ROLL_DUR seconds with an ease-in-out, resting flat in between. Successive
    // manoeuvres alternate between a full 360° roll (seamless: TAU ≡ 0) and a
    // gentler bank (roll out to BANK_MAX and back) for variety. The clock only
    // advances while active, so a paused field never rolls mid-stop.
    const TAU = Math.PI * 2;
    const ROLL_PERIOD = 22; // s between roll starts
    const ROLL_DUR = 6; // s per manoeuvre — slow enough to glide, not whip
    const BANK_MAX = 0.6; // radians (~34°) for the gentler "bank" manoeuvre
    // Smootherstep (Perlin): zero velocity AND acceleration at both ends, so the
    // roll eases in and out gently instead of snapping — much smoother than a cubic.
    const easeInOut = (p: number) => p * p * p * (p * (p * 6 - 15) + 10);
    // Trail subdivisions while rolling — the streak is drawn as a SEG-segment arc
    // following the roll, collapsing to a straight line when not rolling. The
    // per-segment angles are the same for every star, so precompute them per frame.
    const SEG = 6;
    const segCos = new Float32Array(SEG + 1);
    const segSin = new Float32Array(SEG + 1);

    let warp = 0.004; // eased star speed
    let clock = 0; // seconds accumulator, drives the backdrop ripple phase
    let raster = 0; // eased energy → ripple amplitude
    let pulse = 0; // beat kick, decays — surges the ripple on each beat
    let fxOn = 0; // eased 0..1 play-state → fades the backdrop effect in/out
    let lastBeat = -1;
    // Start mid-rest so the first roll waits out a full rest (~ROLL_PERIOD-ROLL_DUR)
    // instead of firing the instant the viz appears.
    let cycle = ROLL_DUR; // seconds into the current roll cycle
    let rollDir = 1; // +1 / -1 — alternates each cycle so rolls go both ways
    let rollCount = 0; // manoeuvre index — even = full roll, odd = gentle bank
    let prevRot = 0; // last frame's roll angle, for the trail's tangential smear
    const stopFrames = driveFrames(
      (dt: number) => {
        clock += dt;

        const energy = playback.vu.length ? Math.max(...playback.vu) : 0;
        const targetWarp = active ? 0.0011 + energy * 0.008 : 0.00006;
        warp += (targetWarp - warp) * 0.08;

        // Backdrop ripple: ease toward energy, kicked on each beat.
        raster += ((active ? energy : 0) - raster) * 0.1;
        if (lastBeat < 0) lastBeat = playback.beat;
        else if (playback.beat !== lastBeat) {
          lastBeat = playback.beat;
          pulse = 1;
        }
        pulse *= Math.exp(-dt / 0.25);
        // Ease the effect in on play / out on pause (so it fades, not snaps).
        fxOn += ((active ? 1 : 0) - fxOn) * 0.06;

        if (active) cycle += dt;
        if (cycle >= ROLL_PERIOD) {
          cycle -= ROLL_PERIOD;
          rollDir = -rollDir; // next manoeuvre goes the opposite way
          rollCount++; // ...and alternates roll ↔ bank
        }
        // Current manoeuvre angle. Full roll: ease 0→TAU (ends where it starts).
        // Bank: ease out to BANK_MAX at the midpoint and back to 0 (a there-and-back
        // with zero velocity at both ends via the doubled smootherstep).
        const rolling = cycle < ROLL_DUR;
        let rot = 0;
        if (rolling) {
          const p = cycle / ROLL_DUR;
          if (rollCount % 2 === 1) {
            const pb = p < 0.5 ? easeInOut(p * 2) : easeInOut((1 - p) * 2); // 0→1→0
            rot = pb * BANK_MAX * rollDir;
          } else {
            rot = easeInOut(p) * TAU * rollDir;
          }
        }
        const rc = Math.cos(rot);
        const rs = Math.sin(rot);
        // Per-frame angular velocity of the roll, so a trail's deeper (older) end
        // lags behind its head — the streak curves tangentially while spinning,
        // not just rigidly. Clamp away the one-frame TAU→0 wrap when a roll ends.
        let rotVel = rot - prevRot;
        if (Math.abs(rotVel) > 0.3) rotVel = 0;
        prevRot = rot;
        // The trail tail sits ~7 warp-steps deeper, i.e. ~7 frames back in time.
        const tailRot = rot - rotVel * 7;
        // Shared tail→head angle table for the (always-tapered) trails; when not
        // rolling tailRot==rot==0, so it collapses to a straight radial streak.
        for (let k = 0; k <= SEG; k++) {
          const a = tailRot + (rot - tailRot) * (k / SEG);
          segCos[k] = Math.cos(a);
          segSin[k] = Math.sin(a);
        }

        if (w > 0 && h > 0) {
          // Backdrop: a dark base, then the nebula dimmed so it doesn't overpower
          // the stars. Full redraw each frame — the star *streaks* carry the blur.
          g2.fillStyle = "#05060d";
          g2.fillRect(0, 0, w, h);
          if (bg.complete && bg.naturalWidth) {
            g2.globalAlpha = 0.5;
            drawCover(bg);
            g2.globalAlpha = 1;
          }

          // --- rippling pixelated backdrop (music-driven), BACKGROUND only ---
          // Downsample the nebula into small blocks, then redraw every block sampling
          // from a source cell displaced along a radial sine wave flowing outward
          // from the centre. Amplitude rises with energy and surges on the beat, so
          // the backdrop ripples like water to the music. Stars + glow draw AFTER
          // this, so they stay crisp. On pause the whole effect eases out (fxOn→0):
          // amplitude flattens and the pixelated layer crossfades away over the
          // plain nebula drawn underneath — and fades back in on play.
          if (bctx && fxOn > 0.01) {
            const target = 6; // css px per block — small blocks
            let bw = Math.max(1, Math.round(w / target));
            let bh = Math.max(1, Math.round(h / target));
            const MAX_CELLS = 4200; // cap the per-frame draws on large panes
            if (bw * bh > MAX_CELLS) {
              const s = Math.sqrt((bw * bh) / MAX_CELLS);
              bw = Math.max(1, Math.round(bw / s));
              bh = Math.max(1, Math.round(bh / s));
            }
            buf.width = bw;
            buf.height = bh;
            bctx.imageSmoothingEnabled = true;
            bctx.drawImage(cnv, 0, 0, cnv.width, cnv.height, 0, 0, bw, bh);

            const cellW = w / bw;
            const cellH = h / bh;
            const mx = w / 2;
            const my = h / 2;
            const amp = (0.5 + raster * 1.8 + pulse * 3.0) * fxOn; // ripple depth, in cells
            g2.imageSmoothingEnabled = false;
            g2.globalAlpha = fxOn; // crossfade the pixelated layer over the plain nebula
            for (let gy = 0; gy < bh; gy++) {
              for (let gx = 0; gx < bw; gx++) {
                const px0 = gx * cellW;
                const py0 = gy * cellH;
                const ddx = px0 + cellW * 0.5 - mx;
                const ddy = py0 + cellH * 0.5 - my;
                const dist = Math.sqrt(ddx * ddx + ddy * ddy);
                const disp = Math.sin(dist * 0.035 - clock * 3.0) * amp;
                const nx = dist > 0.001 ? ddx / dist : 0;
                const ny = dist > 0.001 ? ddy / dist : 0;
                const sxc = Math.max(0, Math.min(bw - 1, gx + nx * disp));
                const syc = Math.max(0, Math.min(bh - 1, gy + ny * disp));
                g2.drawImage(buf, sxc, syc, 1, 1, px0, py0, cellW + 1, cellH + 1);
              }
            }
            g2.globalAlpha = 1;
            g2.imageSmoothingEnabled = true;
          }

          const cx = w / 2;
          const cy = h / 2;
          const scale = Math.min(w, h) * 0.9;

          // Cool central glow the stars stream out of.
          const glowR = Math.min(w, h) * (0.18 + energy * 0.12);
          const ci = 0.12 + energy * 0.25;
          const cg = g2.createRadialGradient(cx, cy, 0, cx, cy, glowR);
          cg.addColorStop(0, `rgba(220,240,255,${ci})`);
          cg.addColorStop(0.5, `rgba(130,200,255,${ci * 0.4})`);
          cg.addColorStop(1, "rgba(120,190,255,0)");
          g2.globalCompositeOperation = "lighter";
          g2.fillStyle = cg;
          g2.beginPath();
          g2.arc(cx, cy, glowR, 0, Math.PI * 2);
          g2.fill();
          g2.globalCompositeOperation = "source-over";

          // Parallax stars: a comet-like trail (bright, wide head → thin, faint tail)
          // drawn as SEG segments sampled from the tail (deepest z + earliest roll
          // angle) to the head (now). Tapering width + alpha per segment reads as
          // motion blur; a bright head dot keeps the star visible when the trail is
          // short (slow warp / near-pause). The angle table collapses to a straight
          // radial streak when not rolling and curves tangentially during a roll.
          const zSpan = warp * 7;
          for (let i = 0; i < COUNT; i++) {
            zs[i] -= warp;
            if (zs[i] <= 0.02) {
              place(i, true);
              continue;
            }
            const inv = 1 / zs[i];
            const px = cx + (xs[i] * rc - ys[i] * rs) * inv * scale * 0.5;
            const py = cy + (xs[i] * rs + ys[i] * rc) * inv * scale * 0.5;
            if (px < -60 || px > w + 60 || py < -60 || py > h + 60) continue;
            const b = 1 - zs[i];
            const headA = Math.min(1, b * 1.25);
            const baseW = b * 1.8 + 0.3;
            const col = cols[i];
            // Tapered trail: draw each segment separately so width + alpha ramp from
            // faint/thin at the tail to bright/wide at the head.
            let sx =
              cx + (xs[i] * segCos[0] - ys[i] * segSin[0]) * (1 / (zs[i] + zSpan)) * scale * 0.5;
            let sy =
              cy + (xs[i] * segSin[0] + ys[i] * segCos[0]) * (1 / (zs[i] + zSpan)) * scale * 0.5;
            g2.strokeStyle = `rgb(${col})`;
            for (let k = 1; k <= SEG; k++) {
              const t = k / SEG; // 0 at tail → 1 at head
              const invK = 1 / (zs[i] + zSpan * (1 - t));
              const nx = cx + (xs[i] * segCos[k] - ys[i] * segSin[k]) * invK * scale * 0.5;
              const ny = cy + (xs[i] * segSin[k] + ys[i] * segCos[k]) * invK * scale * 0.5;
              g2.globalAlpha = headA * t * t; // quadratic fade → soft tail
              g2.lineWidth = baseW * (0.2 + 0.8 * t);
              g2.beginPath();
              g2.moveTo(sx, sy);
              g2.lineTo(nx, ny);
              g2.stroke();
              sx = nx;
              sy = ny;
            }
            // Bright head dot — the star itself.
            g2.globalAlpha = headA;
            g2.fillStyle = `rgb(${col})`;
            g2.beginPath();
            g2.arc(px, py, baseW * 0.6, 0, TAU);
            g2.fill();
          }
          g2.globalAlpha = 1;
        }
      },
      { active: () => active },
    );

    return () => {
      stopFrames();
      ro.disconnect();
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
