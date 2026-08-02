// The words the composer left in the module.
//
// Tracker composers used the sample- and instrument-name slots as a text area — their
// handle, their group, greets, an email address, "written in 3 hours at 4am". It is the
// demoscene's oldest habit and the reason the archive's own enrichment pipeline reads
// those slots at all. Two visualisers show it (the split-flap board and the hi-fi's text
// face), so deciding what counts as a message lives here rather than in either of them.

import type { Track } from "./host";

/** Does this name look like a message rather than a sample filename? */
export function isProse(s: string): boolean {
  if (s.length < 3) return false;
  // "bd1.wav", "STRG-D1.WAV", "hihat closed 1" — the first two are inventory, the third is
  // still just a label. Prose has a space AND isn't a filename, or is long enough that it
  // can't be an instrument name.
  if (/\.(wav|raw|smp|iff|snd|aif+|pcm|spl|s3i|its)$/i.test(s.trim())) return false;
  return /\s/.test(s.trim()) || s.trim().length >= 12;
}

/**
 * A title card, then whatever the composer wrote in the sample slots.
 *
 * Falls back progressively so a module with no text still shows something rather than an
 * empty display: below two lines of prose the whole inventory goes up instead, because on
 * a sparse module the sample list IS the content.
 */
export function moduleLines(
  track: Track | null,
  instruments: string[],
  samples: string[],
): string[] {
  const head: string[] = [];
  if (track) head.push(String(track.title || track.filename));
  if (track?.artist) head.push(`BY ${track.artist}`);

  const slots = [...instruments, ...samples]
    .map((s) => (s ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  // De-dupe: trackers repeat the same padding line dozens of times to make a block of
  // text, and a display that shows the same line eight times reads as broken.
  const seen = new Set<string>();
  const uniq = slots.filter((s) => {
    const k = s.toUpperCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const prose = uniq.filter(isProse);
  const body = prose.length >= 2 ? prose : uniq;
  return [...head, "", ...body];
}
