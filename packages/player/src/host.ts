// The seam between the app-agnostic player engine (player.svelte.ts) and the
// host app. The engine only needs a Track-shaped object plus a few hooks; each
// app injects its own implementation once at startup via `setPlayerHost`.

/** The minimal track shape the player reads/mutates. Each app's richer track
 *  type (tracker's library entry, party's production primary) is structurally
 *  assignable to this. Identity for queueing is `path ?? hash` (tracker has
 *  duplicate-content modules at different paths; party is hash-only). */
export type Track = {
  hash: string;
  filename: string;
  path?: string;
  /** Lowercase file extension, when the host tracks one. Picks the decoder. */
  ext?: string;
  /** Which subtune of a multi-tune file to play (0-based). SID only. */
  subsong?: number;
  /** The host's own row id, when it has one (tracker's `files.id`). Carried so
   *  the app can match the playing track against a queue of ids without holding
   *  the rows. Absent for hosts that queue tracks directly (party). */
  id?: number;
  title?: string | null;
  group?: string | null;
  artist?: string | null;
  duration?: number | null;
  type_long?: string | null;
  tracker?: string | null;
  channels?: number | null;
  instruments?: number | null;
  samples?: number | null;
  play_count?: number;
};

/** Metadata written back to the backend cache after a parse (per app's /api/meta). */
export type MetaIn = {
  title?: string | null;
  type_long?: string | null;
  tracker?: string | null;
  duration?: number | null;
  channels?: number | null;
  instruments?: number | null;
  samples?: number | null;
  n_orders?: number | null;
  n_patterns?: number | null;
};

/** An entry in the play queue. Apps that hold their whole track list in memory
 *  (party) queue the tracks themselves; apps whose library lives server-side
 *  (tracker, once HVSC makes the index too big to ship) queue opaque ids and
 *  resolve them on demand. */
export type QueueRef = number | string;

export type PlayerHost = {
  /** Used as the Now-Playing artist fallback. */
  appName: string;
  /** URL for a module's raw bytes by content hash. */
  fileUrl: (hash: string) => string;
  /** Record a play once listened past the threshold; returns the new total. */
  play: (hash: string) => Promise<{ play_count: number }>;
  /** Persist parsed metadata (best-effort cache write). */
  putMeta: (hash: string, meta: MetaIn) => Promise<void>;
  /** Synchronously read an already-known track for a queue ref, or null when it
   *  hasn't been hydrated yet. Callers that can't await (the upcoming-tracks
   *  window feeding a visualiser) use this and simply show fewer entries.
   *  Only needed by hosts that queue ids rather than tracks. */
  peekTrack?: (ref: QueueRef) => Track | null;
  /** Resolve a queue ref to a track, fetching if it isn't cached. Only needed by
   *  hosts that queue ids rather than tracks. */
  resolveTrack?: (ref: QueueRef) => Promise<Track | null>;
  /** How long to actually play a track, when that differs from its stated
   *  `duration`. A SID carries no length in the file, so tracker plays an
   *  unknown-length one for a configured window rather than not at all; the
   *  track's own `duration` stays null so nothing claims a length it doesn't
   *  know. Absent → `duration ?? 0`, which is right for every other format. */
  playLength?: (t: Track) => number;
  /** Where the app serves the C64 system ROMs, for the SID decoder. Absent →
   *  libsidplayfp's built-in images (most tunes still play; a BASIC-driven RSID
   *  does not). */
  romBase?: () => string;
  /** Where the app serves visualiser reels — one-bit films a track can bring with it
   *  (see reel.ts and assets/README.md). `<base>` lists their ids, `<base>/<id>` is the
   *  clip. Absent means no reels, which is the normal state: like the ROMs, a clip lives
   *  on the operator's mount and is never bundled, so a build-time asset would be the
   *  one thing it must not be. */
  reelBase?: () => string;
  /** Curator notes about a tune, for the text visualisers.
   *
   *  A SID has no sample or instrument slots, so it has none of the text a
   *  tracker composer leaves in a module — the split-flap board and the hi-fi's
   *  text face would show a bare title card. HVSC's STIL is the equivalent
   *  writing for C64 music, and this is where it comes from. Absent, or
   *  resolving to `[]`, simply means no notes. */
  trackNotes?: (t: Track) => Promise<TrackNote[]>;
};

/** One curator note. `subsong` is -1 when it applies to the whole file.
 *
 *  `title`/`artist` name the **original this tune covers**, not the tune's own
 *  title and author (`name`/`author`) — HVSC keeps those apart and so do we. */
export type TrackNote = {
  subsong: number;
  comment: string | null;
  title: string | null;
  artist: string | null;
  name: string | null;
  author: string | null;
};

let current: PlayerHost | null = null;

/** Register the host. Call once at app init (e.g. a side-effect import in the
 *  root layout) before any playback. */
export function setPlayerHost(h: PlayerHost): void {
  current = h;
}

export function host(): PlayerHost {
  if (!current) {
    throw new Error("@scene/player: host not set — call setPlayerHost() at app init");
  }
  return current;
}
