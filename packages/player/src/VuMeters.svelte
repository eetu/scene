<script lang="ts">
	// Analog VU meters: a pair of swinging-needle dials on a warm backlit panel —
	// the classic hi-fi look. Driven by the per-channel VU levels (split into two
	// banks for a left/right feel), with meter ballistics (fast attack, slow
	// release) and a red zone near full scale. Self-coloured (cream dial face), so
	// it reads the same in both themes.
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
		const SWEEP = Math.PI * 0.46; // ±~41° from vertical

		// Mean level of one half of the VU channels (0..1), our L/R approximation.
		function bank(lo: number, hi: number): number {
			const vu = playback.vu;
			if (!vu.length) return 0;
			const a = Math.floor((vu.length * lo) / 1);
			const b = Math.max(a + 1, Math.floor((vu.length * hi) / 1));
			let s = 0;
			let n = 0;
			for (let i = a; i < b && i < vu.length; i++) {
				s += vu[i];
				n++;
			}
			return n ? Math.min(1, s / n) : 0;
		}

		function meter(cx: number, baseY: number, r: number, level: number, label: string) {
			// Dial face: a soft cream sector with a warm backlight glow.
			g2.save();
			g2.translate(cx, baseY);
			g2.fillStyle = 'rgba(255, 178, 60, 0.10)';
			g2.beginPath();
			g2.arc(0, 0, r * 1.08, -Math.PI / 2 - SWEEP, -Math.PI / 2 + SWEEP);
			g2.lineTo(0, 0);
			g2.fill();

			// Scale arc + ticks.
			const steps = 10;
			for (let i = 0; i <= steps; i++) {
				const f = i / steps;
				const ang = -Math.PI / 2 + (f - 0.5) * 2 * SWEEP;
				const r0 = r * (i % 5 === 0 ? 0.82 : 0.9);
				g2.strokeStyle = f > 0.8 ? '#d0392b' : '#cfc6a8';
				g2.lineWidth = f > 0.8 ? 2 : 1;
				g2.beginPath();
				g2.moveTo(Math.cos(ang) * r0, Math.sin(ang) * r0);
				g2.lineTo(Math.cos(ang) * r, Math.sin(ang) * r);
				g2.stroke();
			}

			// Needle.
			const ang = -Math.PI / 2 + (Math.min(1, level) - 0.5) * 2 * SWEEP;
			g2.strokeStyle = '#e7ddbf';
			g2.shadowColor = 'rgba(255,200,90,0.8)';
			g2.shadowBlur = 6;
			g2.lineWidth = 2;
			g2.lineCap = 'round';
			g2.beginPath();
			g2.moveTo(0, 0);
			g2.lineTo(Math.cos(ang) * r * 0.96, Math.sin(ang) * r * 0.96);
			g2.stroke();
			g2.shadowBlur = 0;

			// Hub + label.
			g2.fillStyle = '#cfc6a8';
			g2.beginPath();
			g2.arc(0, 0, Math.max(2, r * 0.04), 0, Math.PI * 2);
			g2.fill();
			g2.fillStyle = 'rgba(207,198,168,0.7)';
			g2.font = `${Math.max(8, r * 0.12)}px ui-monospace, monospace`;
			g2.textAlign = 'center';
			g2.fillText(label, 0, -r * 0.5);
			g2.restore();
		}

		let raf = 0;
		function frame() {
			const tL = active ? bank(0, 0.5) : 0;
			const tR = active ? bank(0.5, 1) : 0;
			// Ballistics: snap up, ease down.
			posL = tL > posL ? tL : posL + (tL - posL) * 0.12;
			posR = tR > posR ? tR : posR + (tR - posR) * 0.12;

			if (w > 0 && h > 0) {
				g2.fillStyle = '#15120c';
				g2.fillRect(0, 0, w, h);
				const r = Math.min(w * 0.22, h * 0.7);
				const baseY = h * 0.62 + r * 0.25;
				meter(w * 0.28, baseY, r, posL, 'L');
				meter(w * 0.72, baseY, r, posR, 'R');
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
