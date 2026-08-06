// The ref-based queue: the play order is a list of opaque refs, and a host whose
// library lives server-side resolves them on demand.
//
// What matters here is that moving track data behind a resolver did NOT change
// the ordering guarantees the seeded shuffle rests on — shuffle permutes
// *indices*, so it is indifferent to where the tracks come from. These tests pin
// the resolver contract; queue.test.ts covers the permutation maths.
//
// `playRefs` ends in `playTrack`, which constructs the real audio graph — absent
// under node. It sets the queue bookkeeping *before* awaiting anything, so the
// helper below lets that engine failure through and asserts the state, rather
// than stubbing a whole Web Audio implementation. Engine behaviour itself is
// covered by the browser suite.
import { beforeEach, describe, expect, test, vi } from "vitest";

import { setPlayerHost, type QueueRef, type Track } from "../host";
import { cueRefs, playRefs, upcoming } from "../player.svelte";
import { playback } from "../state.svelte";

const TRACKS: Record<number, Track> = {
  1: { hash: "h1", filename: "one.mod", path: "A/one.mod", title: "One" },
  2: { hash: "h2", filename: "two.mod", path: "A/two.mod", title: "Two" },
  3: { hash: "h3", filename: "three.mod", path: "A/three.mod", title: "Three" },
};

let cache: Map<QueueRef, Track>;
let resolveTrack: ReturnType<typeof vi.fn>;

/** Queue without caring whether the audio engine could start. */
const queueOnly = (refs: QueueRef[], index: number) => playRefs(refs, index).catch(() => {});

/** A host that starts cold: nothing cached, every ref costs a resolve. */
function installHost() {
  cache = new Map();
  resolveTrack = vi.fn(async (ref: QueueRef) => {
    const t = TRACKS[Number(ref)] ?? null;
    if (t) cache.set(ref, t);
    return t;
  });
  setPlayerHost({
    appName: "test",
    fileUrl: (hash) => `/api/file/${hash}`,
    play: async () => ({ play_count: 1 }),
    putMeta: async () => {},
    peekTrack: (ref) => cache.get(ref) ?? null,
    resolveTrack,
  });
}

beforeEach(() => {
  installHost();
  playback.queueIndex = -1;
  playback.queueLength = 0;
  playback.shuffle = false;
  playback.error = null;
});

describe("ref queue", () => {
  test("playRefs sets the queue length and index without needing every track", async () => {
    await queueOnly([1, 2, 3], 1);
    expect(playback.queueLength).toBe(3);
    expect(playback.queueIndex).toBe(1);
    // Only the track actually being played was fetched — the whole point is that
    // a 91k-entry queue costs one resolve, not 91k.
    expect(resolveTrack).toHaveBeenCalledTimes(1);
    expect(resolveTrack).toHaveBeenCalledWith(2);
  });

  test("cueRefs seeds the cache with the track already in hand", () => {
    // The deep-link restore path: the id stream is long, but the one track being
    // cued is already known, so cueing must not hit the network at all.
    cueRefs([1, 2, 3], 2, TRACKS[3]);
    expect(playback.queueIndex).toBe(2);
    expect(playback.queueLength).toBe(3);
    expect(resolveTrack).not.toHaveBeenCalled();
    expect(playback.current?.hash).toBe("h3");
  });

  test("upcoming reads only hydrated entries rather than blocking", () => {
    // It feeds a visualiser from a $derived, so it can't await. An unhydrated
    // entry is skipped, and the window fills in as the cache warms.
    cueRefs([1, 2, 3], 0, TRACKS[1]);
    expect(upcoming(3).map((t) => t.hash)).toEqual(["h1"]);

    cache.set(2, TRACKS[2]);
    cache.set(3, TRACKS[3]);
    expect(upcoming(3).map((t) => t.hash)).toEqual(["h1", "h2", "h3"]);
  });

  test("a new queue drops the previous queue's cached entries", async () => {
    cueRefs([1, 2, 3], 0, TRACKS[1]);
    await queueOnly([3], 0);
    expect(playback.queueLength).toBe(1);
    // Re-queueing ref 3 must consult the host again rather than trusting a Track
    // cached under the old queue — the row may have changed underneath.
    expect(resolveTrack).toHaveBeenLastCalledWith(3);
  });

  test("an unresolvable ref surfaces an error instead of silently playing nothing", async () => {
    await queueOnly([999], 0);
    expect(playback.error).toBeTruthy();
  });
});
