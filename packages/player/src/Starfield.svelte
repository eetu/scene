<script lang="ts">
	// Parallax starfield over a deep-space backdrop: a centred nebula image sits
	// at the back, parallax stars stream out of the centre (speed pulsing with the
	// music's energy), and an angular starfighter rides on top — so the stars fly
	// *under* the ship, toward the nebula it's racing into. The backdrop + ship are
	// pre-rendered assets imported below (./assets/*, the ship keyed to
	// transparency). Always dark — a "window into space" in either theme.
	import { playback } from './player.svelte';
	// Shared assets live in this package (one copy in git); each app's Vite emits
	// them into its own build.
	import bgUrl from './assets/starfield-bg.jpg';
	import shipUrl from './assets/starfield-ship.webp';

	let { active = true }: { active?: boolean } = $props();

	let canvas: HTMLCanvasElement | null = $state(null);

	const COUNT = 560;

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

		// Backdrop + ship sprite (ship background already keyed to transparent).
		const bg = new Image();
		bg.src = bgUrl;
		const ship = new Image();
		ship.src = shipUrl;

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
			const dw = img.naturalWidth * s;
			const dh = img.naturalHeight * s;
			g2.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
		}

		let raf = 0;
		let warp = 0.004; // eased speed
		function frame() {
			const energy = playback.vu.length ? Math.max(...playback.vu) : 0;
			const targetWarp = active ? 0.0014 + energy * 0.009 : 0.0005;
			warp += (targetWarp - warp) * 0.1;

			if (w > 0 && h > 0) {
				// Backdrop (or a dark fill until it loads). Full redraw each frame, so
				// no trail buildup — crisp stars read better over the busy nebula.
				if (bg.complete && bg.naturalWidth) drawCover(bg);
				else {
					g2.fillStyle = '#0a0a12';
					g2.fillRect(0, 0, w, h);
				}

				// Parallax stars, streaming out of the centre.
				const cx = w / 2;
				const cy = h / 2;
				const scale = Math.min(w, h) * 0.9;
				for (let i = 0; i < COUNT; i++) {
					zs[i] -= warp;
					if (zs[i] <= 0.02) place(i, true);
					const px = cx + (xs[i] / zs[i]) * scale * 0.5;
					const py = cy + (ys[i] / zs[i]) * scale * 0.5;
					if (px < 0 || px >= w || py < 0 || py >= h) continue;
					const b = 1 - zs[i];
					// Bigger, chunkier stars with a brightness floor so even the far
					// ones stay legible over the busy nebula (they were vanishing into
					// it). Size/alpha still grow as they rush past.
					const size = b * 3.6 + 1;
					g2.globalAlpha = Math.min(1, 0.4 + b * 1.1);
					g2.fillStyle = '#fff';
					g2.fillRect(px, py, size, size);
				}
				g2.globalAlpha = 1;

				// Ship on top — stars pass behind it. POV foreground: scaled to ~60%
				// of the height, bottom-anchored (slight overhang), centred — racing
				// away into the depth with the nose pointing up toward the nebula at
				// the starfield's centre.
				if (ship.complete && ship.naturalWidth) {
					const sAR = ship.naturalWidth / ship.naturalHeight;
					const dH = h * 0.6;
					const dW = dH * sAR;
					// The nose sits at ~0.36 of the sprite width (left of centre), so
					// nudge the ship right by ~0.14·dW to aim the tip at the screen
					// centre (the nebula core the stars stream from).
					const x = (w - dW) / 2 + dW * 0.14;
					// Bottom-anchored with a small (~8%) overhang so the engines crop
					// just off-frame (POV "near").
					g2.drawImage(ship, x, h - dH * 0.92, dW, dH);
				}
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
