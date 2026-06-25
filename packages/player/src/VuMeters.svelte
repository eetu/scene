<script lang="ts">
	// Analog VU meters styled after a warm backlit hi-fi meter: a glowing amber
	// dial face, a curved numbered scale (denser, red near full scale), a slim
	// black needle and a dark bezel hiding the pivot. Two meters (L/R banks of the
	// VU channels) with meter ballistics — eased attack + slower release. The dial
	// is self-coloured, so it reads identically in both themes.
	import { playback } from './player.svelte';

	let { active = true }: { active?: boolean } = $props();

	let canvas: HTMLCanvasElement | null = $state(null);

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

		let posL = 0;
		let posR = 0;
		const SWEEP = Math.PI * 0.4; // ±72° total

		function bank(lo: number, hi: number): number {
			const vu = playback.vu;
			if (!vu.length) return 0;
			const a = Math.floor(vu.length * lo);
			const b = Math.max(a + 1, Math.floor(vu.length * hi));
			let s = 0;
			let n = 0;
			for (let i = a; i < b && i < vu.length; i++) {
				s += vu[i];
				n++;
			}
			return n ? Math.min(1, s / n) : 0;
		}

		const MINOR = 20;
		const MAJOR = 4; // every 4th minor tick is major + labelled

		function meter(x0: number, y0: number, cw: number, ch: number, level: number, label: string) {
			const pad = Math.min(cw, ch) * 0.06;
			const fx = x0 + pad;
			const fy = y0 + pad;
			const fw = cw - pad * 2;
			const fh = ch - pad * 2;
			const pivotX = fx + fw / 2;
			const pivotY = fy + fh * 0.92;
			const r = Math.min(fw * 0.46, fh * 0.86);

			g2.save();

			// Backlit amber face.
			const face = g2.createRadialGradient(pivotX, fy + fh * 0.35, fh * 0.05, pivotX, fy + fh * 0.35, fh * 1.1);
			face.addColorStop(0, '#ffe0a4');
			face.addColorStop(0.55, '#f0a338');
			face.addColorStop(1, '#7c4214');
			g2.fillStyle = face;
			g2.beginPath();
			g2.roundRect(fx, fy, fw, fh, Math.min(fw, fh) * 0.07);
			g2.fill();

			// Scale ticks + numbers.
			g2.textAlign = 'center';
			g2.textBaseline = 'middle';
			const numFont = Math.max(7, r * 0.1);
			for (let i = 0; i <= MINOR; i++) {
				const f = i / MINOR;
				const ang = -Math.PI / 2 + (f - 0.5) * 2 * SWEEP;
				const major = i % MAJOR === 0;
				const red = f > 0.8;
				const r0 = r * (major ? 0.84 : 0.9);
				g2.strokeStyle = red ? '#bb2d1c' : '#3a2206';
				g2.lineWidth = major ? 2 : 1;
				g2.beginPath();
				g2.moveTo(pivotX + Math.cos(ang) * r0, pivotY + Math.sin(ang) * r0);
				g2.lineTo(pivotX + Math.cos(ang) * r, pivotY + Math.sin(ang) * r);
				g2.stroke();
				if (major) {
					g2.fillStyle = red ? '#bb2d1c' : '#42280a';
					g2.font = `${numFont}px ui-monospace, monospace`;
					g2.fillText(
						String(i * 5),
						pivotX + Math.cos(ang) * r * 0.72,
						pivotY + Math.sin(ang) * r * 0.72
					);
				}
			}

			// Label (channel) under the arc.
			g2.fillStyle = 'rgba(60,34,8,0.7)';
			g2.font = `${Math.max(8, r * 0.13)}px ui-monospace, monospace`;
			g2.fillText(label, pivotX, fy + fh * 0.52);

			// Needle (black) with a soft shadow.
			const ang = -Math.PI / 2 + (Math.min(1, level) - 0.5) * 2 * SWEEP;
			g2.strokeStyle = '#1a1206';
			g2.shadowColor = 'rgba(0,0,0,0.35)';
			g2.shadowBlur = 3;
			g2.lineWidth = Math.max(1.5, r * 0.022);
			g2.lineCap = 'round';
			g2.beginPath();
			g2.moveTo(pivotX, pivotY);
			g2.lineTo(pivotX + Math.cos(ang) * r * 0.92, pivotY + Math.sin(ang) * r * 0.92);
			g2.stroke();
			g2.shadowBlur = 0;

			// Dark bezel under the pivot — a dome sitting on a flat bottom edge
			// (the needle emerges from its top), matching the inspiration meter.
			const bezBottom = pivotY + fh * 0.06;
			const bezHalf = fw * 0.34;
			g2.fillStyle = '#0e0a05';
			g2.beginPath();
			g2.moveTo(pivotX - bezHalf, bezBottom);
			g2.quadraticCurveTo(pivotX, pivotY - fh * 0.22, pivotX + bezHalf, bezBottom);
			g2.closePath();
			g2.fill();
			g2.fillStyle = '#2a1c0c';
			g2.beginPath();
			g2.arc(pivotX, pivotY, Math.max(2, r * 0.05), 0, Math.PI * 2);
			g2.fill();

			g2.restore();
		}

		let raf = 0;
		function frame() {
			const tL = active ? bank(0, 0.5) : 0;
			const tR = active ? bank(0.5, 1) : 0;
			// Eased attack, slower release (≈ VU ballistics).
			posL += (tL - posL) * (tL > posL ? 0.3 : 0.1);
			posR += (tR - posR) * (tR > posR ? 0.3 : 0.1);

			if (w > 0 && h > 0) {
				g2.fillStyle = '#120d07';
				g2.fillRect(0, 0, w, h);
				meter(0, 0, w / 2, h, posL, 'L');
				meter(w / 2, 0, w / 2, h, posR, 'R');
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
