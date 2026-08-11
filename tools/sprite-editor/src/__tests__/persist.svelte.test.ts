// What survives a reload. The dev server reloads on every source edit, so this
// is the path the tool takes constantly — and the one that can lose work.
import { expect, test } from "vitest";

import { clearDraft, recallDraft, recallFile, rememberDraft, rememberFile } from "../lib/persist";

const SPRITE = {
  name: "draft",
  w: 3,
  h: 2,
  palette: { A: "#ff0000" },
  frames: [["A..", ".A."]],
};

test("the open file is remembered, so a reload comes back to it", () => {
  rememberFile("car.json");
  expect(recallFile()).toBe("car.json");
  rememberFile(null);
  expect(recallFile()).toBe(null);
});

test("a draft round-trips through storage exactly", () => {
  clearDraft();
  expect(recallDraft()).toBe(null);
  rememberDraft(SPRITE, "draft.json");
  const back = recallDraft();
  expect(back?.file).toBe("draft.json");
  expect(back?.sprite).toEqual(SPRITE);
  clearDraft();
  expect(recallDraft()).toBe(null);
});

test("a draft written by an older format is dropped, not resurrected", () => {
  // Straight into storage, the shape a previous version might have left behind.
  localStorage.setItem(
    "sprite-editor:draft",
    JSON.stringify({ file: "old.json", sprite: JSON.stringify({ name: "old", w: 2 }) }),
  );
  expect(recallDraft()).toBe(null);
  clearDraft();
});

test("clearing after a save means the next reload is not unsaved work", () => {
  rememberDraft(SPRITE, "draft.json");
  expect(recallDraft()).not.toBe(null);
  clearDraft();
  expect(recallDraft()).toBe(null);
});
