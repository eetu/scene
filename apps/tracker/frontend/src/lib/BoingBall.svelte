<script lang="ts">
	// The Amiga Boing Ball — a spinning red/white checkered sphere bouncing on a
	// magenta grid. Two layers on one canvas: the grid is drawn crisp at full
	// resolution (thin 1px lines), while the ball is rendered into a small
	// offscreen buffer and composited on top nearest-neighbour, so it stays
	// chunky/pixelated. Used both as the scan loader and a playback visualizer.

	// `energy` (0..1) modulates the ball when used as a visualizer: it spins
	// faster and pulses bigger with the music. Only spin (incremental) and drawn
	// size react — the analytic position speeds stay fixed so the bounce never
	// jumps. Default 0 = idle.
	let { energy = 0 }: { energy?: number } = $props();

	let canvas: HTMLCanvasElement | null = $state(null);

	$effect(() => {
		const el = canvas;
		if (!el) return;
		const mainCtx = el.getContext('2d');
		if (!mainCtx) return;
		const off = document.createElement('canvas');
		const offCtx = off.getContext('2d');
		if (!offCtx) return;
		// Static grid is cached here and redrawn only on resize (not every frame).
		const gridC = document.createElement('canvas');
		const gridCtx = gridC.getContext('2d');
		if (!gridCtx) return;
		const main: CanvasRenderingContext2D = mainCtx;
		const og: CanvasRenderingContext2D = offCtx;
		const gg: CanvasRenderingContext2D = gridCtx;

		const PIXEL = 4; // offscreen→screen upscale (ball chunkiness)
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		let W = 0; // CSS px (grid space)
		let H = 0;
		let oW = 0; // offscreen px (ball space)
		let oH = 0;

		const ro = new ResizeObserver(() => {
			const r = el.getBoundingClientRect();
			W = r.width;
			H = r.height;
			el.width = Math.max(1, Math.round(W * dpr));
			el.height = Math.max(1, Math.round(H * dpr));
			main.setTransform(dpr, 0, 0, dpr, 0, 0);
			oW = Math.max(1, Math.round(W / PIXEL));
			oH = Math.max(1, Math.round(H / PIXEL));
			off.width = oW;
			off.height = oH;
			// Re-render the static grid once, at the new size.
			gridC.width = el.width;
			gridC.height = el.height;
			gg.setTransform(dpr, 0, 0, dpr, 0, 0);
			grid();
		});
		ro.observe(el);

		let spin = 0;
		let t0 = 0;
		let lastT = 0;
		const tilt = (16 * Math.PI) / 180;
		const cosT = Math.cos(tilt); // precomputed (constant) tilt rotation
		const sinT = Math.sin(tilt);
		const H_SPEED = 0.14;
		const V_SPEED = 2.3;
		const SPIN_RATE = 1.7;

		function radius() {
			return Math.max(10, Math.min(60, Math.min(oW, oH) * 0.2));
		}

		// Boing scene over the app's (theme) background: a flat back-wall grid up
		// top and a gentle one-point perspective floor below the horizon.
		function grid() {
			gg.clearRect(0, 0, W, H); // transparent — theme bg shows through
			gg.strokeStyle = '#b41eb4';
			gg.lineWidth = 2;
			// Cell size scales with the smaller dimension (clamped) so the grid
			// density stays balanced at any container size / aspect ratio.
			const GRID = Math.max(26, Math.min(64, Math.round(Math.min(W, H) / 11)));
			// Snap the horizon to a grid line so the wall's bottom row is a full
			// cell (not a leftover wide/narrow strip at the wall/floor corner).
			const hY = Math.round((H * 0.7) / GRID) * GRID; // horizon
			const floorH = H - hY;
			const vpX = W / 2; // floor vanishing point (on the horizon)
			gg.beginPath();

			// Wall — square grid from the top down to the horizon.
			for (let gx = 0; gx <= W; gx += GRID) {
				gg.moveTo(gx, 0);
				gg.lineTo(gx, hY);
			}
			for (let gy = 0; gy <= hY; gy += GRID) {
				gg.moveTo(0, gy);
				gg.lineTo(W, gy);
			}
			gg.moveTo(0, hY);
			gg.lineTo(W, hY); // horizon

			// Floor continues the room: depth lines pick up the wall's verticals at
			// the horizon (full width) and fan gently OUTWARD toward the viewer (near
			// edge wider than the back). No central runway / convergence spike.
			const spread = 1.45; // near edge width / back edge width
			const backHalf = W / 2; // back edge = full wall width at the horizon
			const nearHalf = backHalf * spread;
			for (let x = 0; x <= W; x += GRID) {
				gg.moveTo(x, hY);
				gg.lineTo(vpX + (x - vpX) * spread, H);
			}
			// Rows: a fixed count, power-law spaced so they bunch toward the horizon
			// AND the farthest lands exactly on it (no wide gap at the wall/floor
			// corner). Each spans the trapezoid width at its depth.
			const ROWS = 9;
			const POW = 2.3;
			for (let i = 0; i <= ROWS; i++) {
				const f = 1 - i / ROWS; // 1 at the near edge, 0 at the horizon
				const ry = hY + floorH * Math.pow(f, POW);
				const s = (H - ry) / (H - hY); // 0 near the viewer, 1 at the horizon
				const half = backHalf + (nearHalf - backHalf) * (1 - s);
				gg.moveTo(vpX - half, ry);
				gg.lineTo(vpX + half, ry);
			}
			gg.stroke();
		}

		// cs/sn = cos/sin(spin) for this frame (computed once, not per vertex).
		function project(theta: number, phi: number, cs: number, sn: number) {
			let px = Math.sin(theta) * Math.cos(phi);
			const py = Math.cos(theta);
			let pz = Math.sin(theta) * Math.sin(phi);
			const x2 = px * cs + pz * sn;
			pz = -px * sn + pz * cs;
			px = x2;
			return {
				x: px * cosT - py * sinT,
				y: px * sinT + py * cosT,
				z: pz
			};
		}

		// Ball drawn into the offscreen (low-res) buffer.
		function ball(cx: number, cy: number, r: number) {
			og.beginPath();
			og.arc(cx, cy, r, 0, Math.PI * 2);
			const g = og.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r);
			g.addColorStop(0, '#ff4d4d');
			g.addColorStop(1, '#b00000');
			og.fillStyle = g;
			og.fill();

			const LAT = 8;
			const LON = 16;
			const cs = Math.cos(spin); // once per frame, not per vertex
			const sn = Math.sin(spin);
			for (let i = 0; i < LAT; i++) {
				for (let j = 0; j < LON; j++) {
					if ((i + j) % 2 === 0) continue;
					const t0a = (Math.PI * i) / LAT;
					const t1 = (Math.PI * (i + 1)) / LAT;
					const p0 = (2 * Math.PI * j) / LON;
					const p1 = (2 * Math.PI * (j + 1)) / LON;
					const a = project(t0a, p0, cs, sn);
					const b = project(t1, p0, cs, sn);
					const c = project(t1, p1, cs, sn);
					const d = project(t0a, p1, cs, sn);
					if ((a.z + b.z + c.z + d.z) / 4 <= 0) continue;
					og.beginPath();
					og.moveTo(cx + a.x * r, cy + a.y * r);
					og.lineTo(cx + b.x * r, cy + b.y * r);
					og.lineTo(cx + c.x * r, cy + c.y * r);
					og.lineTo(cx + d.x * r, cy + d.y * r);
					og.closePath();
					og.fillStyle = '#f2f2f2';
					og.strokeStyle = '#f2f2f2';
					og.lineWidth = 1;
					og.fill();
					og.stroke();
				}
			}
			og.beginPath();
			og.arc(cx, cy, r, 0, Math.PI * 2);
			const rim = og.createRadialGradient(cx, cy, r * 0.6, cx, cy, r);
			rim.addColorStop(0, 'rgba(0,0,0,0)');
			rim.addColorStop(1, 'rgba(0,0,0,0.35)');
			og.fillStyle = rim;
			og.fill();
		}

		let raf = 0;
		function frame(ts: number) {
			if (!t0) {
				t0 = ts;
				lastT = ts;
			}
			const t = (ts - t0) / 1000;
			const dt = Math.min(0.05, (ts - lastT) / 1000);
			lastT = ts;

			if (oW > 0 && oH > 0) {
				const r = radius();
				const pad = 4;
				const left = r + pad;
				const right = oW - r - pad;
				const floor = oH - r - pad;
				const ceil = r + pad;

				const hp = t * H_SPEED;
				const f = hp - Math.floor(hp);
				const hx = f < 0.5 ? f * 2 : 2 - f * 2;
				const dir = f < 0.5 ? 1 : -1;
				const x = left + (right - left) * hx;

				const bounce = Math.abs(Math.sin(t * V_SPEED));
				const y = floor - (floor - ceil) * bounce;

				spin += SPIN_RATE * (0.6 + energy * 2) * dir * dt;
				const rDraw = r * (1 + energy * 0.15);

				// Grid layer: blit the cached static grid (redrawn only on resize).
				main.clearRect(0, 0, W, H);
				main.imageSmoothingEnabled = false;
				main.drawImage(gridC, 0, 0, W, H);

				// Ball layer (low-res offscreen, transparent), then composite up.
				og.clearRect(0, 0, oW, oH);
				// drop shadow on the wall, offset down-right behind the ball
				og.fillStyle = 'rgba(30,30,30,0.3)';
				og.beginPath();
				og.arc(x + rDraw * 0.32, y + rDraw * 0.22, rDraw, 0, Math.PI * 2);
				og.fill();
				ball(x, y, rDraw);

				main.drawImage(off, 0, 0, oW, oH, 0, 0, W, H);
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
