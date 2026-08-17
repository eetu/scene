// A one-bit film, for the flip-dot board to play.
//
// Every other face of that board is generated from the music (see flip-modes.ts).
// This one is not: it is a fixed clip of silhouettes, which only makes sense against
// the tune it was cut for — so it is matched to the track by name and driven off the
// playhead, and the board goes back to its own modes for everything else.
//
// The point of the exercise is that a flip-dot board is a one-bit display with a
// mechanical settling time, which is exactly the thing shadow animation was made for.
// A reel plays at the board's own rate; the driver sweep is not an obstacle to work
// around, it is the reason to do this on this display rather than on a canvas.
//
// Clips are BUILT, not shipped: see assets/build-reel.py and assets/README.md. The
// registry is a glob, so a folder with nothing in it is simply no clips — never a
// build error, and never a video in the repository.

/** A decoded clip: frames of packed bits, ready to sample. */
export type Reel = {
  /** The clip's id — its filename without extension, which is also what a track
   *  title is matched against. */
  id: string;
  cols: number;
  rows: number;
  /** Frames a second the clip was baked at. */
  fps: number;
  count: number;
  /** `count * ceil(cols * rows / 8)` bytes, MSB first, row-major. */
  bits: Uint8Array;
};

const MAGIC = 0x5245454c; // "REEL"
const VERSION = 1;
const HEADER = 12;

/** How wide a packed frame is, in bytes. */
export const frameBytes = (cols: number, rows: number): number => Math.ceil((cols * rows) / 8);

/**
 * Read a built clip.
 *
 * The file is a header and then one XOR-delta per frame, run-length encoded in BITS:
 * alternating runs of unchanged and flipped, starting with unchanged, each a LEB128
 * varint. Silhouette animation is mostly a still field with a moving edge, so the
 * deltas are long runs of nothing — which is the whole reason the format is deltas
 * and not frames.
 *
 * Decoded to packed frames in memory rather than kept as deltas: a clip is a few
 * hundred kilobytes either way, and holding whole frames means seeking is an index
 * rather than a replay from the last keyframe. The playhead moves in both directions.
 */
export function decodeReel(id: string, buf: ArrayBuffer): Reel | null {
  if (buf.byteLength < HEADER) return null;
  const head = new DataView(buf);
  if (head.getUint32(0, false) !== MAGIC || head.getUint8(4) !== VERSION) return null;
  const cols = head.getUint8(5);
  const rows = head.getUint8(6);
  const fps = head.getUint8(7);
  const count = head.getUint32(8, true);
  if (!cols || !rows || !fps || !count) return null;

  const stride = frameBytes(cols, rows);
  const total = cols * rows;
  const bits = new Uint8Array(count * stride);
  const src = new Uint8Array(buf, HEADER);
  let p = 0;

  for (let f = 0; f < count; f++) {
    const at = f * stride;
    // Each frame starts as its predecessor and is flipped where the delta says so.
    if (f > 0) bits.copyWithin(at, at - stride, at);
    let bit = 0;
    let flip = false; // runs alternate, and the first is unchanged
    while (bit < total) {
      let run = 0;
      let shift = 0;
      for (;;) {
        if (p >= src.length) return null; // truncated: a half-decoded reel is not a reel
        const b = src[p++];
        run |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
      if (flip) {
        const end = Math.min(total, bit + run);
        for (let i = bit; i < end; i++) bits[at + (i >> 3)] ^= 0x80 >> (i & 7);
      }
      bit += run;
      flip = !flip;
    }
  }
  return { id, cols, rows, fps, count, bits };
}

/** Is this dot of this frame lit? Out of range is dark rather than a throw: the
 *  board's geometry is the pane's, and a clip is whatever it was baked at. */
export function reelDot(reel: Reel, frame: number, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= reel.cols || y >= reel.rows) return false;
  if (frame < 0 || frame >= reel.count) return false;
  const i = y * reel.cols + x;
  return (reel.bits[frame * frameBytes(reel.cols, reel.rows) + (i >> 3)] & (0x80 >> (i & 7))) !== 0;
}

/** Which frame is showing at this point in the tune, held at the ends. A clip and a
 *  tune are never quite the same length, and a reel that ran out mid-song would read
 *  as the board having crashed. */
export const reelFrameAt = (reel: Reel, seconds: number): number =>
  Math.max(0, Math.min(reel.count - 1, Math.round(seconds * reel.fps)));

/**
 * Draw a frame onto a board of a different shape.
 *
 * Fitted and centred rather than stretched: the board's rows follow the pane's
 * aspect, so on a wide pane a stretched 4:3 clip is a smear. What falls outside the
 * fitted rectangle stays dark, which on a flip-dot board is a letterbox of unlit
 * discs — the same thing the hardware would do.
 *
 * Each board dot takes the MAJORITY of the source cell it covers, not a nearest
 * sample: downscaling a silhouette by a point sample turns an eyelash into a
 * flickering dot, and on a board with a settling time flicker is the one artefact
 * that never resolves.
 */
export function sampleReel(
  reel: Reel,
  frame: number,
  cols: number,
  rows: number,
  out: Uint8Array,
): void {
  out.fill(0);
  if (!cols || !rows) return;
  const scale = Math.min(cols / reel.cols, rows / reel.rows);
  const w = Math.max(1, Math.round(reel.cols * scale));
  const h = Math.max(1, Math.round(reel.rows * scale));
  const ox = Math.floor((cols - w) / 2);
  const oy = Math.floor((rows - h) / 2);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y * reel.rows) / h);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * reel.rows) / h));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * reel.cols) / w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * reel.cols) / w));
      let lit = 0;
      let seen = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          seen++;
          if (reelDot(reel, frame, sx, sy)) lit++;
        }
      }
      if (seen && lit * 2 >= seen) out[(oy + y) * cols + ox + x] = 1;
    }
  }
}

/** Letters and digits only, folded to lower case: `Bad Apple!! (XM).xm` and
 *  `badapple` have to be the same thing, and a filename is not a clean string. */
export const reelKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Every name a track goes by.
 *
 * The tune's own title and filename, and then what the curator notes call it. That
 * second part is not decoration: a SID has no text of its own, and HVSC keeps the
 * ORIGINAL A TUNE COVERS in STIL's title/artist fields rather than in the tune's name
 * (see `TrackNote` in host.ts — the split-flap board reads the same fields to print
 * "COVER OF …"). A C64 cover of something is very often filed under the arranger's own
 * title, so the only place the thing it covers is written down is the notes.
 *
 * Comments are deliberately not included. They are prose, and matching a clip id
 * inside a paragraph is how a reel ends up playing over a tune that merely mentions it.
 */
export function trackNames(
  track: { title?: string | null; filename?: string | null } | null | undefined,
  notes: readonly { title: string | null; name: string | null }[] = [],
): (string | null | undefined)[] {
  return [track?.title, track?.filename, ...notes.flatMap((n) => [n.title, n.name])];
}

/**
 * The clip a track should play, if any.
 *
 * Matched on the id being IN the track's name rather than equal to it: a module is
 * called all sorts of things around the tune it covers, and the clip is named for the
 * tune. Two-way containment would match everything against a short id, so it is one
 * way only, and an id has to be at least a few characters to mean anything.
 */
export function reelIdFor(
  ids: readonly string[],
  ...names: (string | null | undefined)[]
): string | null {
  const hay = names.filter(Boolean).map((n) => reelKey(n as string));
  for (const id of ids) {
    const key = reelKey(id);
    if (key.length < 4) continue;
    if (hay.some((n) => n.includes(key))) return id;
  }
  return null;
}

/**
 * Built clips, by id.
 *
 * A glob rather than a list, so the folder is the registry: dropping a built clip in
 * is the whole installation step, and an empty folder resolves to no clips instead of
 * a build error. `?url` because these are binary and have to be emitted as assets
 * rather than parsed as modules.
 */
const REELS = import.meta.glob<string>("./assets/reels/*.bin", {
  eager: true,
  query: "?url",
  import: "default",
});

export const REEL_IDS: string[] = Object.keys(REELS)
  .map((path) => path.slice(path.lastIndexOf("/") + 1, -".bin".length))
  .sort();

const cache = new Map<string, Reel | null>();

/** Fetch and decode a clip, once. A clip that fails to decode is remembered as
 *  absent: retrying a broken file every track change is a network loop, not a fix. */
export async function loadReel(id: string): Promise<Reel | null> {
  const hit = cache.get(id);
  if (hit !== undefined) return hit;
  const url = REELS[`./assets/reels/${id}.bin`];
  if (!url) return null;
  try {
    const res = await fetch(url);
    const reel = res.ok ? decodeReel(id, await res.arrayBuffer()) : null;
    cache.set(id, reel);
    return reel;
  } catch {
    cache.set(id, null);
    return null;
  }
}

/**
 * Watch the transport and hold the clip the current track should be showing.
 *
 * Three displays play reels — the flip board, the LED cube, the deck's VFD — and each
 * one asked the same four questions: has the track changed, have its notes arrived, is
 * there a clip for it, and has the viewer waved it away. That is one behaviour, so it
 * lives here once; a display is left with `watch.reel` and its own idea of how to draw
 * a frame.
 *
 * Polled from the frame loop rather than being an effect, because every caller already
 * has one and a reel only ever changes on a track change.
 */
export type ReelWatch = {
  /** The clip to show, or null: no clip for this track, or the viewer dismissed it. */
  readonly reel: Reel | null;
  /** Look again. Cheap: a string compare unless something actually changed. */
  poll(): void;
  /** Hand the display back to whatever it shows normally, until the next track. */
  dismiss(): void;
  /** Take it back — for a display whose control can cycle round to the film again. */
  restore(): void;
  /** True once a clip has been found for this track, dismissed or not — so a display
   *  can offer a way back to it rather than stranding the viewer. */
  readonly found: boolean;
  stop(): void;
};

export function watchReel(playback: {
  current: { hash?: string; filename?: string; title?: string | null } | null;
  notes: readonly { title: string | null; name: string | null }[];
}): ReelWatch {
  let track: string | null = null;
  let noteCount = -1;
  let reel: Reel | null = null;
  let off = false;
  let stopped = false;

  return {
    get reel() {
      return off ? null : reel;
    },
    get found() {
      return reel !== null;
    },
    poll() {
      if (stopped) return;
      const t = playback.current;
      const key = t ? (t.hash ?? t.filename ?? "") : "";
      // The notes are fetched after the track loads, and for a SID they are where the
      // thing it covers is written down — so a match has to be looked for again when
      // they land, not once when the tune starts.
      const notes = playback.notes.length;
      if (key === track && notes === noteCount) return;
      const fresh = key !== track;
      track = key;
      noteCount = notes;
      if (fresh) {
        reel = null;
        off = false;
      } else if (reel) return; // already holding this track's clip
      if (!t || !REEL_IDS.length) return;
      const id = reelIdFor(REEL_IDS, ...trackNames(t, playback.notes));
      if (!id) return;
      void loadReel(id).then((r) => {
        // A track change while the fetch was in flight wins: the display belongs to
        // whatever is playing now, not to what was playing when this was asked for.
        if (!stopped && track === key) reel = r;
      });
    },
    dismiss() {
      off = true;
    },
    restore() {
      off = false;
    },
    stop() {
      stopped = true;
    },
  };
}
