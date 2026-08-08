// The app's accent (--accent), as the visualisers read it off the live theme.

export type RGB = [number, number, number];

/** The accent as the raw CSS string (hex), read from `el`'s computed style. */
export function accentHex(el: Element = document.documentElement, fallback = "#f78f08"): string {
  return getComputedStyle(el).getPropertyValue("--accent").trim() || fallback;
}

export function parseHex(s: string): RGB {
  const t = s.trim();
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(t);
  if (m) {
    const h = m[1].length === 3 ? m[1].replace(/./g, (ch) => ch + ch) : m[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = /rgba?\(([^)]+)\)/i.exec(t);
  if (rgb) {
    const n = rgb[1].split(",").map((v) => parseFloat(v));
    return [n[0] || 0, n[1] || 0, n[2] || 0];
  }
  return [247, 143, 8]; // the family's warm orange
}

/** The accent parsed to an RGB triple (SSR-safe: falls back to the orange). */
export function accentColor(): RGB {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
    return [247, 143, 8];
  }
  return parseHex(getComputedStyle(document.documentElement).getPropertyValue("--accent"));
}
