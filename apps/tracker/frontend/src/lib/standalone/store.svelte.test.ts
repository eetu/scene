// Browser test (real chromium — needs crypto.subtle + IndexedDB + object URLs)
// for the backend-less store: dropping bytes yields a track with a playable blob
// URL, identical content dedupes, and clearAll empties everything.
import { describe, expect, it } from "vitest";

import { ApiError } from "$lib/api";

import {
  addFiles,
  addFsEntries,
  clearAll,
  objectUrl,
  remove,
  rename,
  tracks,
} from "./store.svelte";

// Distinct bytes per call so content-hash dedupe doesn't collapse fixtures.
let seq = 0;
function modFile(name: string, relPath?: string): File {
  const f = new File([new Uint8Array([++seq, 2, 3, 4, 5])], name.split("/").pop() ?? name);
  if (relPath) Object.defineProperty(f, "webkitRelativePath", { value: relPath });
  return f;
}

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

  it("derives group/artist from a folder pick, stripping the picked-root folder", async () => {
    await clearAll();

    // A webkitdirectory pick carries the picked folder as the first segment — it
    // is the import root (like TRACKER_ROOT) and must be stripped.
    await addFiles([modFile("x.mod", "Picked/Future Crew/Purple Motion/x.mod")]);
    expect(tracks[0].path).toBe("Future Crew/Purple Motion/x.mod");
    expect(tracks[0].group).toBe("Future Crew");
    expect(tracks[0].artist).toBe("Purple Motion");

    // A flat picked folder (song directly inside) → groupless, like the backend
    // treats a file directly under TRACKER_ROOT.
    await addFiles([modFile("y.mod", "Picked/y.mod")]);
    const y = tracks.find((t) => t.filename === "y.mod")!;
    expect(y.path).toBe("y.mod");
    expect(y.group).toBe("");
    expect(y.artist).toBeNull();

    // A loose file (plain picker, no relative path) → groupless.
    await addFiles([modFile("z.mod")]);
    const z = tracks.find((t) => t.filename === "z.mod")!;
    expect(z.group).toBe("");

    await clearAll();
  });

  it("renames / moves a track (pure catalog edit) with backend-mirrored rules", async () => {
    await clearAll();
    await addFiles([modFile("a.mod", "Root/Grp/Art/a.mod")]);
    const from = tracks[0].path;

    const res = rename({ from, group: "NewGrp", artist: "NewArt", filename: "a.mod" });
    expect(res.path).toBe("NewGrp/NewArt/a.mod");
    expect(tracks[0].group).toBe("NewGrp");
    expect(tracks[0].artist).toBe("NewArt");

    // Blank group → groupless (no leading segment in the path).
    const g = rename({ from: tracks[0].path, group: "", artist: null, filename: "a.mod" });
    expect(g.path).toBe("a.mod");
    expect(tracks[0].group).toBe("");
    expect(tracks[0].artist).toBeNull();

    // A filename without a module extension is rejected (400).
    expect(() =>
      rename({ from: tracks[0].path, group: "G", artist: null, filename: "a.txt" }),
    ).toThrow(ApiError);

    // Collision with a different track's path → 409.
    await addFiles([modFile("b.mod", "Root/G/b.mod")]);
    const b = tracks.find((t) => t.filename === "b.mod")!;
    try {
      rename({ from: b.path, group: "", artist: null, filename: "a.mod" });
      throw new Error("expected a conflict");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(409);
    }

    await clearAll();
  });

  it("recurses a dropped directory (FileSystem entries), root-stripping fullPath", async () => {
    await clearAll();

    // Minimal FileSystemEntry mocks: a dropped folder "Drop" containing a nested
    // Grp/Art dir with a module. readEntries yields its batch once, then [].
    const fileEntry = (name: string, fullPath: string): FileSystemEntry =>
      ({
        isFile: true,
        isDirectory: false,
        name,
        fullPath,
        file: (res: (f: File) => void) => res(modFile(name)),
      }) as unknown as FileSystemEntry;
    const dirEntry = (name: string, fullPath: string, kids: FileSystemEntry[]): FileSystemEntry => {
      let drained = false;
      return {
        isFile: false,
        isDirectory: true,
        name,
        fullPath,
        createReader: () => ({
          readEntries: (res: (e: FileSystemEntry[]) => void) => {
            const out = drained ? [] : kids;
            drained = true;
            res(out);
          },
        }),
      } as unknown as FileSystemEntry;
    };

    const tree = dirEntry("Drop", "/Drop", [
      dirEntry("Grp", "/Drop/Grp", [
        dirEntry("Art", "/Drop/Grp/Art", [fileEntry("deep.mod", "/Drop/Grp/Art/deep.mod")]),
      ]),
    ]);
    const added = await addFsEntries([tree]);
    expect(added).toBe(1);
    // "Drop" (the dropped root) is stripped → Grp/Art/deep.mod.
    expect(tracks[0].path).toBe("Grp/Art/deep.mod");
    expect(tracks[0].group).toBe("Grp");
    expect(tracks[0].artist).toBe("Art");

    await clearAll();
  });

  it("removes a single track (bytes + catalog row)", async () => {
    await clearAll();
    await addFiles([modFile("keep.mod"), modFile("drop.mod")]);
    const drop = tracks.find((t) => t.filename === "drop.mod")!;
    await remove(drop.hash);
    expect(tracks.some((t) => t.filename === "drop.mod")).toBe(false);
    expect(tracks.some((t) => t.filename === "keep.mod")).toBe(true);
    expect(objectUrl(drop.hash)).toBe("");
    await clearAll();
  });
});
