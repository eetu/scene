// Saving, against a fake folder handle.
//
// The File System Access API can't be driven from a test — but every write in
// this tool goes through one function that only needs a handle-shaped object, so
// the interesting behaviour (a rename moves rather than copies) is checkable.
import { toJson } from "@scene/player/sprite-file";
import { expect, test } from "vitest";

import { type Folder, saveSprite } from "../lib/files";

const SPRITE = {
  name: "newName",
  w: 2,
  h: 1,
  palette: { A: "#ff0000" },
  frames: [["A."]],
};

/** A directory handle backed by a Map, plus a log of what was removed. */
function fakeFolder(existing: string[] = []) {
  const files = new Map<string, string>(existing.map((f) => [f, "{}"]));
  const removed: string[] = [];
  const folder = {
    name: "sprites",
    handle: {
      name: "sprites",
      values: async function* () {},
      getFileHandle: async (name: string) => ({
        name,
        getFile: async () => new File([files.get(name) ?? ""], name),
        createWritable: async () => ({
          write: async (data: string) => void files.set(name, data),
          close: async () => {},
        }),
      }),
      removeEntry: async (name: string) => {
        if (!files.has(name)) throw new Error("no such file");
        files.delete(name);
        removed.push(name);
      },
    },
  } as unknown as Folder;
  return { folder, files, removed };
}

test("a plain save writes the file the sprite names", async () => {
  const { folder, files, removed } = fakeFolder();
  const res = await saveSprite(folder, SPRITE, "newName.json");
  expect(res).toEqual({ file: "newName.json", removed: null });
  expect(files.get("newName.json")).toBe(toJson(SPRITE));
  expect(removed).toEqual([]);
});

test("a rename MOVES: the new file is written and the old one is gone", async () => {
  const { folder, files, removed } = fakeFolder(["oldName.json"]);
  const res = await saveSprite(folder, SPRITE, "oldName.json");
  expect(res).toEqual({ file: "newName.json", removed: "oldName.json" });
  expect(files.has("oldName.json")).toBe(false);
  expect(files.get("newName.json")).toBe(toJson(SPRITE));
  expect(removed).toEqual(["oldName.json"]);
});

test("a sprite that was never on disk is written, not moved", async () => {
  const { folder, removed } = fakeFolder();
  const res = await saveSprite(folder, SPRITE, null);
  expect(res.removed).toBe(null);
  expect(removed).toEqual([]);
});

test("if the old file cannot be removed the save still stands", async () => {
  // The write lands first, so a failed removeEntry costs a stray file and never
  // the drawing. Reported as `removed: null` so the status line does not claim a
  // clean rename that did not happen.
  const { folder, files } = fakeFolder();
  const res = await saveSprite(folder, SPRITE, "missing.json");
  expect(res).toEqual({ file: "newName.json", removed: null });
  expect(files.get("newName.json")).toBe(toJson(SPRITE));
});
