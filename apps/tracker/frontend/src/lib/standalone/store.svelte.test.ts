// Browser test (real chromium — needs crypto.subtle + IndexedDB + object URLs)
// for the backend-less store: dropping bytes yields a track with a playable blob
// URL, identical content dedupes, and clearAll empties everything.
import { describe, expect, it } from "vitest";

import { addFiles, clearAll, objectUrl, tracks } from "./store.svelte";

describe("standalone store", () => {
  it("adds a dropped module, exposes a blob URL, dedupes by content, and clears", async () => {
    await clearAll();
    expect(tracks.length).toBe(0);

    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const added = await addFiles([new File([bytes], "song.mod")]);
    expect(added).toBe(1);
    expect(tracks.length).toBe(1);
    expect(tracks[0].filename).toBe("song.mod");
    expect(tracks[0].ext).toBe("mod");
    expect(objectUrl(tracks[0].hash)).toMatch(/^blob:/);

    // Same bytes under a different name → deduped (no new track).
    expect(await addFiles([new File([bytes], "dupe.mod")])).toBe(0);
    expect(tracks.length).toBe(1);

    // A non-module extension is ignored.
    expect(await addFiles([new File([bytes], "readme.txt")])).toBe(0);

    await clearAll();
    expect(tracks.length).toBe(0);
  });
});
