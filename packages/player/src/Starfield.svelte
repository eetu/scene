<script lang="ts">
	// Parallax starfield — the quintessential demo effect. Stars stream out of the
	// centre; their speed and brightness pulse with the music's energy (VU). On a
	// dark panel in both themes (a starfield only reads on black). Accent-tinted.
	import { playback } from './player.svelte';

	let { active = true }: { active?: boolean } = $props();

	let canvas: HTMLCanvasElement | null = $state(null);

	const COUNT = 320;

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

		// Stars in a normalized space: x,y in [-1,1], z (depth) in (0,1]. Seeded
		// deterministically (no Math.random dependence on first paint order).
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

		let accent = '#f78f08';
		let cachedMode: string | null = null;
		const node: HTMLCanvasElement = el;
		const refresh = () => {
			accent = getComputedStyle(node).getPropertyValue('--accent').trim() || accent;
		};

		let raf = 0;
		let warp = 0.004; // eased speed
		function frame() {
			const mode = document.documentElement.dataset.theme ?? '';
			if (mode !== cachedMode) {
				refresh();
				cachedMode = mode;
			}
			const energy = playback.vu.length ? Math.max(...playback.vu) : 0;
			const targetWarp = active ? 0.004 + energy * 0.05 : 0.0008;
			warp += (targetWarp - warp) * 0.1;

			if (w > 0 && h > 0) {
				// Slight trail: fade the previous frame instead of clearing.
				g2.fillStyle = 'rgba(6, 6, 12, 0.35)';
				g2.fillRect(0, 0, w, h);
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
					const size = b * 2.4 + 0.3;
					g2.globalAlpha = Math.min(1, b * 1.2);
					g2.fillStyle = b > 0.75 ? '#fff' : accent;
					g2.fillRect(px, py, size, size);
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
