// The play queue as an airport departures board.
//
// This is the split-flap's home ground: a Solari panel exists to show a list of things
// about to happen, one row each, in fixed columns. The queue IS that list, so the mode
// is not a costume — the board is doing its actual job with our data in it.
//
// Layout is pure and lives here so the field arithmetic can be tested without a canvas:
// given a width, a height and the upcoming tracks, produce the rows. The component owns
// the drums and the flaps.
import type { Track } from "./host";

/** Width of the time field — MM:SS. */
export const TIME_W = 5;
/** Column the time field starts at. */
export const TIME_X = 0;
/** Width of the status field (one glyph). */
export const STATUS_W = 1;

/** Status flags, on their own tiny drum. A short drum means a short wrap, which is why
 *  real boards gave their fastest-changing field dedicated modules. */
export const ST_PLAYING = "▶"; // ▶
export const ST_QUEUED = "·"; // ·
export const STATUS_DRUM = ` ${ST_PLAYING}${ST_QUEUED}`;

/** Header row, which sits above the zones so it can use the board's letter drum. */
export const HEADER = "TIME  DESTINATION";

export type DepRow = { time: string; title: string; status: string };

/** Where the title field sits, given the board width. */
export function titleSpan(cols: number): { x: number; w: number } {
  const x = TIME_X + TIME_W + 1; // one blank column after the time
  const w = Math.max(1, cols - x - STATUS_W - 1); // one blank column before the status
  return { x, w };
}

/** mm:ss, clamped — a duration the board can't fit is worse than one it rounds. */
export function clock(sec: number | null | undefined): string {
  if (sec == null || !isFinite(sec) || sec < 0) return "  :  ";
  const total = Math.floor(sec);
  const m = Math.min(99, Math.floor(total / 60));
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** A track's board name: title if it has one, else the filename without extension. */
export function boardName(t: Track): string {
  const raw = (t.title || t.filename || "").trim();
  return (raw.replace(/\.[a-z0-9]{2,4}$/i, "") || "UNTITLED").toUpperCase();
}

/**
 * The board's rows for a queue window.
 *
 * `elapsed` is the current track's playing position: the top row counts up while the
 * rest show their own durations, so exactly one digit module turns per second. That
 * ticking field is the cheapest motion a split-flap has and the most characteristic —
 * it is what a station board does all day.
 */
export function departureRows(
  tracks: Track[],
  cols: number,
  rows: number,
  elapsed: number,
): DepRow[] {
  const { w } = titleSpan(cols);
  const out: DepRow[] = [];
  const slots = Math.max(0, rows - 1); // one row is the header
  for (let i = 0; i < slots; i++) {
    const t = tracks[i];
    if (!t) {
      out.push({ time: "     ", title: "", status: " " });
      continue;
    }
    out.push({
      time: i === 0 ? clock(elapsed) : clock(t.duration ?? null),
      title: boardName(t).slice(0, w),
      status: i === 0 ? ST_PLAYING : ST_QUEUED,
    });
  }
  return out;
}

/** Render the rows as full board lines, so the caller can hand them to setText. */
export function departureLines(rows: DepRow[], cols: number): string[] {
  const { x, w } = titleSpan(cols);
  return rows.map((r) => {
    const line = new Array(cols).fill(" ");
    const put = (at: number, text: string) => {
      for (let i = 0; i < text.length && at + i < cols; i++) line[at + i] = text[i];
    };
    put(TIME_X, r.time.slice(0, TIME_W));
    put(x, r.title.slice(0, w));
    put(cols - STATUS_W, r.status);
    return line.join("").trimEnd();
  });
}
