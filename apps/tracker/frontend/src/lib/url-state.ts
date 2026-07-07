// Pure helpers for the bookmarkable-song URL state (?t=<hash>&pos=<sec>).
// Kept side-effect-free so the parsing/formatting is node-unit-testable; the
// wiring (reading page.url, writing history, clipboard) stays in +page.svelte,
// and the browser-integration behaviour is covered by e2e/url-state.spec.ts.

/** Parse a shared start position (?pos=) into whole seconds, clamped to ≥ 0.
 *  Junk / missing / negative → 0. */
export function parsePos(param: string | null): number {
  return Math.max(0, Math.floor(Number(param) || 0));
}

/** Build a deep-link to a track at a position — the YouTube-style copy-link URL
 *  (?t=<hash>&pos=<sec>), preserving the rest of `href`. */
export function buildShareUrl(href: string, hash: string, positionSec: number): string {
  const u = new URL(href);
  u.searchParams.set("t", hash);
  u.searchParams.set("pos", String(Math.max(0, Math.floor(positionSec))));
  return u.toString();
}
