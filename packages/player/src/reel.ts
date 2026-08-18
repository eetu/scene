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
// Clips are BUILT, not shipped, and they live on the operator's mount beside the music
// and the C64 ROMs rather than in the bundle: see assets/build-reel.py and
// assets/README.md. The app says where they are served from and this asks, so a
// repository and an image can both be free of them and the easter egg still works.
import { host } from "./host";

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
const VERSION = 2;
const HEADER = 12;

/** How wide a packed frame is, in bytes. */
export const frameBytes = (cols: number, rows: number): number => Math.ceil((cols * rows) / 8);

/**
 * Read a built clip: a header, then gzipped packed frames.
 *
 * The frames are stored PLAIN — one bit per dot, row-major, MSB first — and the whole
 * run of them is gzipped. That is the opposite of the obvious design and it was measured,
 * because the obvious design lost. This started as XOR deltas run-length encoded in bits,
 * on the reasoning that silhouette animation is a still field with a moving edge; on a
 * 3:39 clip that came to 246 KB, and plain frames through gzip come to 112 KB. Nothing
 * about the reasoning was wrong except its conclusion: a general compressor already finds
 * the temporal redundancy — its window spans many frames, so a row that repeats across
 * dozens of them costs almost nothing — and hand-rolled RLE destroys exactly the
 * byte-level repetition it would have exploited. Gzipped against gzipped, the clever
 * format came out 17% BIGGER than plain frames (129 KB against 110 KB).
 *
 * gzip rather than brotli (86 KB) only because `DecompressionStream` does not offer
 * brotli; a `CompressionLayer` on the backend would get that back over the wire, and
 * would do it for every other asset too.
 *
 * Decompressed to whole frames in memory rather than streamed on demand: seeking is then
 * an index rather than a replay, and the playhead moves in both directions.
 */
export async function decodeReel(id: string, buf: ArrayBuffer): Promise<Reel | null> {
  if (buf.byteLength < HEADER) return null;
  const head = new DataView(buf);
  if (head.getUint32(0, false) !== MAGIC || head.getUint8(4) !== VERSION) return null;
  const cols = head.getUint8(5);
  const rows = head.getUint8(6);
  const fps = head.getUint8(7);
  const count = head.getUint32(8, true);
  if (!cols || !rows || !fps || !count) return null;

  const want = count * frameBytes(cols, rows);
  let bits: Uint8Array;
  try {
    const stream = new Blob([buf.slice(HEADER)])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    bits = new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null; // not gzip, or truncated mid-stream
  }
  // A short payload would draw as a corrupt frame that never resolves, which on these
  // displays looks like a hardware fault rather than a bad file.
  if (bits.length < want) return null;
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
 * An id this client could actually fetch: one path segment of letters, digits, `-` and
 * `_`, which is what the serving end accepts.
 *
 * Checked here as well because a match is worthless if the fetch cannot follow it, and
 * the two used to disagree: a macOS `._badapple.bin` sidecar listed as `._badapple`,
 * folded to the same key as the real clip, sorted ahead of it, WON the match, and then
 * 404'd on a dot the server rejects — so the real clip was never tried. The list is
 * filtered at the source now; this makes the client's own rule the same rule, rather
 * than trusting whatever it is handed.
 */
const fetchable = (id: string): boolean => /^[A-Za-z0-9_-]+$/.test(id);

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
    if (!fetchable(id)) continue;
    const key = reelKey(id);
    if (key.length < 4) continue;
    if (hay.some((n) => n.includes(key))) return id;
  }
  return null;
}

/**
 * The clips this machine has, from the app.
 *
 * Fetched rather than globbed at build time, and that is the whole point: a reel is
 * derived frames of somebody else's video, so it lives on the operator's mount beside the
 * music and the C64 ROMs and is never committed or baked into an image. A build-time glob
 * put the file in the bundle, which meant the easter egg worked on the machine that built
 * the clip and nowhere else — the image CI produces has no clip in it at all.
 *
 * So the host says where they are served from (`reelBase`, exactly like `romBase`) and
 * this asks. No host, no base, no reels — which is the normal state, and costs one fetch
 * that 404s at most once per session.
 */
let ids: Promise<string[]> | null = null;

/**
 * Where reels are served from, or null.
 *
 * `host()` THROWS when no host has been registered, and this is called from frame loops:
 * an app that never set one — or a consumer of this package that has no reels at all —
 * would take an exception per frame out of a piece of optional decoration. No host is no
 * reels, which is the same answer as no base.
 */
function reelBase(): string | null {
  try {
    return host().reelBase?.() ?? null;
  } catch {
    return null;
  }
}

export function reelIds(): Promise<string[]> {
  if (ids) return ids;
  const base = reelBase();
  if (!base) return (ids = Promise.resolve([]));
  ids = fetch(base)
    .then((r) => (r.ok ? r.json() : { reels: [] }))
    .then((j) => (Array.isArray(j?.reels) ? (j.reels as string[]) : []))
    .catch(() => []);
  return ids;
}

const cache = new Map<string, Reel | null>();

/** Fetch and decode a clip, once. A clip that fails to decode is remembered as
 *  absent: retrying a broken file every track change is a network loop, not a fix. */
export async function loadReel(id: string): Promise<Reel | null> {
  const hit = cache.get(id);
  if (hit !== undefined) return hit;
  const base = reelBase();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/${encodeURIComponent(id)}`);
    const reel = res.ok ? await decodeReel(id, await res.arrayBuffer()) : null;
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
      if (!t) return;
      // The id list is a fetch now, so matching is too. Both it and the clip resolve
      // against the track they were asked for: a change while either was in flight wins,
      // because the display belongs to whatever is playing now.
      const names = trackNames(t, playback.notes);
      void reelIds()
        .then((all) => {
          if (stopped || track !== key || !all.length) return null;
          const id = reelIdFor(all, ...names);
          return id ? loadReel(id) : null;
        })
        .then((r) => {
          if (!stopped && track === key && r) reel = r;
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
