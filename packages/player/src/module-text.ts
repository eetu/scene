// The words the composer left in the module.
//
// Tracker composers used the sample- and instrument-name slots as a text area — their
// handle, their group, greets, an email address, "written in 3 hours at 4am". It is the
// demoscene's oldest habit and the reason the archive's own enrichment pipeline reads
// those slots at all. Two visualisers show it (the split-flap board and the hi-fi's text
// face), so deciding what counts as a message lives here rather than in either of them.

import type { Track, TrackNote } from "./host";

/** Does this name look like a message rather than a sample filename? */
export function isProse(s: string): boolean {
  if (s.length < 3) return false;
  // "bd1.wav", "STRG-D1.WAV", "hihat closed 1" — the first two are inventory, the third is
  // still just a label. Prose has a space AND isn't a filename, or is long enough that it
  // can't be an instrument name.
  if (/\.(wav|raw|smp|iff|snd|aif+|pcm|spl|s3i|its)$/i.test(s.trim())) return false;
  return /\s/.test(s.trim()) || s.trim().length >= 12;
}

/** Wrap prose into display-width lines, breaking on spaces.
 *
 * Sample slots arrive pre-chunked at 22-odd characters — that's the shape both text
 * visualisers were built around. A STIL comment is one long paragraph, so it has to be
 * broken the same way or it scrolls as a single unreadable line. */
function wrap(text: string, width = 28): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}

/** The curator's writing about a tune, as display lines.
 *
 * The cover-song credit reads as one line ("COVER OF <title> BY <artist>") because that's
 * what it means; a bare TITLE next to the tune's own title would just look like a
 * contradiction. */
function noteLines(notes: TrackNote[]): string[] {
  const out: string[] = [];
  for (const n of notes) {
    const cover =
      n.title && (n.artist ? `COVER OF ${n.title} BY ${n.artist}` : `COVER OF ${n.title}`);
    if (cover) out.push(...wrap(cover));
    if (n.comment) out.push(...wrap(n.comment));
  }
  return out;
}

/**
 * A title card, then whatever the composer wrote in the sample slots.
 *
 * Falls back progressively so a module with no text still shows something rather than an
 * empty display: below two lines of prose the whole inventory goes up instead, because on
 * a sparse module the sample list IS the content.
 *
 * A SID has no sample slots at all, so for those the body is HVSC's STIL commentary — the
 * same habit, a different place to keep it. Notes come first when present: they're written
 * about this tune, where a sample name is at best incidentally about it.
 */
export function moduleLines(
  track: Track | null,
  instruments: string[],
  samples: string[],
  notes: TrackNote[] = [],
): string[] {
  const head: string[] = [];
  if (track) head.push(String(track.title || track.filename));
  if (track?.artist) head.push(`BY ${track.artist}`);

  const written = noteLines(notes);
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
  return [...head, "", ...written, ...(written.length && body.length ? [""] : []), ...body];
}
