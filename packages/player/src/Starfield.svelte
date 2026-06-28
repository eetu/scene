<script lang="ts">
  // Parallax starfield over a deep-space nebula backdrop: stars stream out of the
  // bright centre leaving motion-blur trails, their speed pulsing with the music's
  // energy and easing to a near-stop when it stops. Periodically the whole field
  // barrel-rolls about the centre for a bit of demoscene flair. (A 3D ship model
  // will be brought in later from ../maquette.) Backdrop is the shared nebula asset.
  import { playback } from "./player.svelte";
  import bgUrl from "./assets/starfield-bg.jpg";

  let { active = true }: { active?: boolean } = $props();

  let canvas: HTMLCanvasElement | null = $state(null);

  const COUNT = 420;

  // Per-star tint: mostly white, with occasional cool-blue stars (echoing the
  // nebula's glow) and warm ones in the brand accent (#f78f08) and a softer gold.
  const PALETTE = [
    "255,255,255",
    "255,255,255",
    "255,255,255",
    "255,255,255",
    "255,255,255",
    "255,255,255",
    "255,255,255",
    "190,218,255",
    "160,200,255",
    "247,143,8",
    "255,206,140",
  ];

  $effect(() => {
    const el = canvas;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const g2: CanvasRenderingContext2D = ctx;

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

    // Barrel roll: every ROLL_PERIOD seconds of playback the field rotates a full
    // turn over ROLL_DUR seconds with an ease-in-out, resting flat in between. The
    // clock only advances while active, so a paused field never rolls mid-stop.
    const TAU = Math.PI * 2;
    const ROLL_PERIOD = 22; // s between roll starts
    const ROLL_DUR = 6; // s per full turn — slow enough to glide, not whip
    // Smootherstep (Perlin): zero velocity AND acceleration at both ends, so the
    // roll eases in and out gently instead of snapping — much smoother than a cubic.
    const easeInOut = (p: number) => p * p * p * (p * (p * 6 - 15) + 10);
    // Trail subdivisions while rolling — the streak is drawn as a SEG-segment arc
    // following the roll, collapsing to a straight line when not rolling. The
    // per-segment angles are the same for every star, so precompute them per frame.
    const SEG = 6;
    const segCos = new Float32Array(SEG + 1);
    const segSin = new Float32Array(SEG + 1);

    let raf = 0;
    let warp = 0.004; // eased star speed
    // Start mid-rest so the first roll waits out a full rest (~ROLL_PERIOD-ROLL_DUR)
    // instead of firing the instant the viz appears.
    let cycle = ROLL_DUR; // seconds into the current roll cycle
    let rollDir = 1; // +1 / -1 — alternates each cycle so rolls go both ways
    let prevRot = 0; // last frame's roll angle, for the trail's tangential smear
    let prev = performance.now();
    function frame(now: number) {
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;

      const energy = playback.vu.length ? Math.max(...playback.vu) : 0;
      const targetWarp = active ? 0.0011 + energy * 0.008 : 0.00006;
      warp += (targetWarp - warp) * 0.08;

      if (active) cycle += dt;
      if (cycle >= ROLL_PERIOD) {
        cycle -= ROLL_PERIOD;
        rollDir = -rollDir; // next roll spins the opposite way
      }
      const rot = cycle < ROLL_DUR ? easeInOut(cycle / ROLL_DUR) * TAU * rollDir : 0;
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
      const tc = Math.cos(tailRot);
      const ts = Math.sin(tailRot);
      // While rolling, build the shared tail→head angle table for the arc trails.
      const rolling = cycle < ROLL_DUR;
      if (rolling) {
        for (let k = 0; k <= SEG; k++) {
          const a = tailRot + (rot - tailRot) * (k / SEG);
          segCos[k] = Math.cos(a);
          segSin[k] = Math.sin(a);
        }
      }

      if (w > 0 && h > 0) {
        // Backdrop (or a dark fill until it loads). Full redraw each frame, so
        // no trail buildup — the star *streaks* below carry the motion blur.
        if (bg.complete && bg.naturalWidth) drawCover(bg);
        else {
          g2.fillStyle = "#0a0a12";
          g2.fillRect(0, 0, w, h);
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

        // Parallax stars as streaks (trail from a few steps back to now).
        for (let i = 0; i < COUNT; i++) {
          zs[i] -= warp;
          if (zs[i] <= 0.02) {
            place(i, true);
            continue;
          }
          // Rotate the star about the centre for the barrel roll (flat when rot=0).
          const rx = xs[i] * rc - ys[i] * rs;
          const ry = xs[i] * rs + ys[i] * rc;
          const inv = 1 / zs[i];
          const px = cx + rx * inv * scale * 0.5;
          const py = cy + ry * inv * scale * 0.5;
          if (px < -60 || px > w + 60 || py < -60 || py > h + 60) continue;
          const b = 1 - zs[i];
          g2.globalAlpha = Math.min(1, b * 1.25);
          g2.strokeStyle = `rgb(${cols[i]})`;
          g2.lineWidth = b * 1.8 + 0.3;
          g2.beginPath();
          if (rolling) {
            // Arc trail: sample depth and roll angle together from the tail
            // (oldest, deepest, earliest angle) to the head (now), so the streak
            // curves along the spin and straightens as the roll's angular
            // velocity eases off. Head sample equals (px,py) by construction.
            const zSpan = warp * 7;
            for (let k = 0; k <= SEG; k++) {
              const invK = 1 / (zs[i] + zSpan * (1 - k / SEG));
              const sx = cx + (xs[i] * segCos[k] - ys[i] * segSin[k]) * invK * scale * 0.5;
              const sy = cy + (xs[i] * segSin[k] + ys[i] * segCos[k]) * invK * scale * 0.5;
              if (k === 0) g2.moveTo(sx, sy);
              else g2.lineTo(sx, sy);
            }
          } else {
            // Resting: a single radial streak (tail angle == head angle).
            const tx = xs[i] * tc - ys[i] * ts;
            const ty = xs[i] * ts + ys[i] * tc;
            const invP = 1 / (zs[i] + warp * 7);
            g2.moveTo(cx + tx * invP * scale * 0.5, cy + ty * invP * scale * 0.5);
            g2.lineTo(px, py);
          }
          g2.stroke();
        }
        g2.globalAlpha = 1;
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
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
