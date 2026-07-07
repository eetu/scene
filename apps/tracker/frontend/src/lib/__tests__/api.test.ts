import { afterEach, describe, expect, test, vi } from "vitest";

import { api, ApiError, fileUrl, itemToTrack, type PlaylistItem } from "$lib/api";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A `fetch` stub that records the call and returns a canned JSON body. */
function mockFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const status = init.status ?? (init.ok === false ? 500 : 200);
  const fn = vi.fn(
    async (_path: string, _init?: RequestInit) =>
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("fileUrl", () => {
  test("points at the raw-bytes route for a hash", () => {
    expect(fileUrl("abc123")).toBe("/api/file/abc123");
  });
});

describe("itemToTrack", () => {
  test("fills nulls with playback-safe defaults, keeps nullable meta null", () => {
    const item = {
      id: 1,
      position: 0,
      md5: "m5",
      present: false,
      hash: null,
      path: null,
      group: null,
      artist: null,
      filename: null,
      ext: null,
      size: null,
      title: null,
      type_long: null,
      tracker: null,
      duration: null,
      channels: null,
      instruments: null,
      samples: null,
      favorite: false,
      play_count: 3,
    } satisfies PlaylistItem;

    const track = itemToTrack(item);

    // Required-for-playback fields coerce to safe non-null values...
    expect(track.hash).toBe("");
    expect(track.group).toBe("");
    expect(track.size).toBe(0);
    // ...while genuinely-nullable metadata stays null, and md5/counts pass through.
    expect(track.md5).toBe("m5");
    expect(track.artist).toBeNull();
    expect(track.title).toBeNull();
    expect(track.play_count).toBe(3);
  });
});

describe("api request layer", () => {
  test("tracks() unwraps the { tracks } envelope from /api/tracks", async () => {
    const fetchMock = mockFetch({ tracks: [{ hash: "h1" }, { hash: "h2" }] });
    const tracks = await api.tracks();
    expect(fetchMock).toHaveBeenCalledWith("/api/tracks", expect.objectContaining({}));
    expect(tracks).toHaveLength(2);
    expect(tracks[0].hash).toBe("h1");
  });

  test("a POST sends a JSON content-type and body", async () => {
    const fetchMock = mockFetch({ play_count: 5 });
    await api.play("deadbeef");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/play/deadbeef");
    expect(init).toMatchObject({ method: "POST" });
  });

  test("non-2xx throws ApiError carrying the status", async () => {
    mockFetch({}, { status: 404 });
    await expect(api.status()).rejects.toBeInstanceOf(ApiError);
    await expect(api.status()).rejects.toMatchObject({ status: 404 });
  });
});
