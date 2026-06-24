<script lang="ts">
	// Canvas image viewer. Draws a (browser-native) image to a canvas at its
	// native resolution with nearest-neighbour scaling, so pixel art stays crisp.
	// Built on canvas (not <img>) so it can later render raw decoded pixels from
	// the transcoder / a client-side LBM/PCX decoder.
	let { src, alt = '' }: { src: string; alt?: string } = $props();

	let canvas = $state<HTMLCanvasElement | null>(null);
	let error = $state(false);

	$effect(() => {
		const el = canvas;
		const url = src;
		if (!el) return;
		const ctx = el.getContext('2d');
		if (!ctx) return;
		error = false;
		const img = new Image();
		img.onload = () => {
			el.width = img.naturalWidth;
			el.height = img.naturalHeight;
			ctx.imageSmoothingEnabled = false;
			ctx.clearRect(0, 0, el.width, el.height);
			ctx.drawImage(img, 0, 0);
		};
		img.onerror = () => (error = true);
		img.src = url;
		return () => {
			img.onload = null;
			img.onerror = null;
		};
	});
</script>

{#if error}
	<p class="err">could not decode image</p>
{:else}
	<canvas bind:this={canvas} aria-label={alt}></canvas>
{/if}

<style>
	canvas {
		display: block;
		max-width: 100%;
		height: auto;
		image-rendering: pixelated;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface);
	}
	.err {
		color: #ff4136;
	}
</style>
