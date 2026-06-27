<script lang="ts">
	// Parallax starfield over a deep-space nebula backdrop: stars stream out of the
	// bright centre leaving motion-blur trails, their speed pulsing with the music's
	// energy and easing to a near-stop when it stops. (A 3D ship model will be
	// brought in later from ../maquette.) Backdrop is the shared nebula asset.
	import { playback } from './player.svelte';
	import bgUrl from './assets/starfield-bg.jpg';

	let { active = true }: { active?: boolean } = $props();

	let canvas: HTMLCanvasElement | null = $state(null);

	const COUNT = 620;

	$effect(() => {
		const el = canvas;
		if (!el) return;
		const ctx = el.getContext('2d');
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
		let seed = 1234567;
		const rnd = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		function place(i: number, far: boolean) {
			xs[i] = rnd() * 2 - 1;
			ys[i] = rnd() * 2 - 1;
			zs[i] = far ? 1 : rnd();
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
				img.naturalHeight * s
			);
		}

		let raf = 0;
		let warp = 0.004; // eased star speed
		function frame() {
			const energy = playback.vu.length ? Math.max(...playback.vu) : 0;
			const targetWarp = active ? 0.0016 + energy * 0.011 : 0.00006;
			warp += (targetWarp - warp) * 0.08;

			if (w > 0 && h > 0) {
				// Backdrop (or a dark fill until it loads). Full redraw each frame, so
				// no trail buildup — the star *streaks* below carry the motion blur.
				if (bg.complete && bg.naturalWidth) drawCover(bg);
				else {
					g2.fillStyle = '#0a0a12';
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
				cg.addColorStop(1, 'rgba(120,190,255,0)');
				g2.globalCompositeOperation = 'lighter';
				g2.fillStyle = cg;
				g2.beginPath();
				g2.arc(cx, cy, glowR, 0, Math.PI * 2);
				g2.fill();
				g2.globalCompositeOperation = 'source-over';

				// Parallax stars as streaks (trail from a few steps back to now).
				for (let i = 0; i < COUNT; i++) {
					zs[i] -= warp;
					if (zs[i] <= 0.02) {
						place(i, true);
						continue;
					}
					const inv = 1 / zs[i];
					const px = cx + xs[i] * inv * scale * 0.5;
					const py = cy + ys[i] * inv * scale * 0.5;
					if (px < -60 || px > w + 60 || py < -60 || py > h + 60) continue;
					const invP = 1 / (zs[i] + warp * 7);
					const px0 = cx + xs[i] * invP * scale * 0.5;
					const py0 = cy + ys[i] * invP * scale * 0.5;
					const b = 1 - zs[i];
					g2.globalAlpha = Math.min(1, b * 1.25);
					g2.strokeStyle = '#fff';
					g2.lineWidth = b * 1.8 + 0.3;
					g2.beginPath();
					g2.moveTo(px0, py0);
					g2.lineTo(px, py);
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
