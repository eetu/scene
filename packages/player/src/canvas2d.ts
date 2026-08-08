// Standard 2D-canvas setup for the raster visualisers: get the context, clamp
// the device-pixel-ratio, and keep the backing store matched to the element's
// CSS size via a ResizeObserver (drawing coordinates stay in CSS pixels).
export function fitCanvas2d(
  el: HTMLCanvasElement,
  onResize?: (w: number, h: number) => void,
  maxDpr = 2,
): { ctx: CanvasRenderingContext2D; stop: () => void } | null {
  const ctx = el.getContext("2d");
  if (!ctx) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const ro = new ResizeObserver(() => {
    const r = el.getBoundingClientRect();
    el.width = Math.max(1, Math.round(r.width * dpr));
    el.height = Math.max(1, Math.round(r.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    onResize?.(r.width, r.height);
  });
  ro.observe(el);
  return { ctx, stop: () => ro.disconnect() };
}
