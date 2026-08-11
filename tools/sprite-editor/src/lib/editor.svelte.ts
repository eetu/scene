// The editor's state: the sprite being drawn, what the tools are set to, and
// the undo stack.
//
// Undo holds whole sprites rather than inverse operations. A sprite is a
// handful of strings — the biggest one in the repo is 72×18 — so a hundred of
// them costs less than the machinery for undoing a flood fill correctly, and
// nothing can drift out of sync with the document.
import {
  addColour as addColourTo,
  addFrame as addFrameTo,
  blankSprite,
  cloneSprite,
  DEFAULT_TINTS,
  duplicateFrame as duplicateFrameIn,
  ellipsePoints,
  floodPoints,
  linePoints,
  moveFrame as moveFrameIn,
  readStamp,
  rectPoints,
  removeColour as removeColourFrom,
  removeFrame as removeFrameFrom,
  renameChar as renameCharIn,
  resizeSprite,
  setColour as setColourIn,
  setPixels,
  shapePoints,
  type SpriteFile,
  type Stamp,
  stampCells,
  TRANSPARENT,
} from "@scene/player/sprite-file";
import { SvelteSet } from "svelte/reactivity";

export type Tool = "pencil" | "eraser" | "fill" | "picker" | "line" | "rect" | "ellipse" | "select";

/** The rail, in order. `key` is the single-press shortcut, as in nib. */
export const TOOLS: { id: Tool; label: string; key: string; hint: string }[] = [
  { id: "pencil", label: "Pencil", key: "b", hint: "Draw with the selected colour" },
  { id: "eraser", label: "Eraser", key: "e", hint: "Paint transparent" },
  { id: "fill", label: "Fill", key: "g", hint: "Flood the connected run" },
  { id: "picker", label: "Picker", key: "i", hint: "Take the colour under the cursor" },
  { id: "line", label: "Line", key: "l", hint: "Drag a straight run" },
  { id: "rect", label: "Rect", key: "r", hint: "Drag a box — hold Shift to fill" },
  { id: "ellipse", label: "Ellipse", key: "o", hint: "Drag a box — hold Shift to fill" },
  {
    id: "select",
    label: "Select",
    key: "m",
    hint: "Click a shape or drag a box, then drag it — arrows nudge, ⌘C/X/V, ⌫ clears",
  },
];

const MAX_UNDO = 200;

export const editor = $state({
  sprite: blankSprite("untitled", 16, 16) as SpriteFile,
  /** The file this came from, so Save knows whether it is a new sprite. */
  file: null as string | null,
  dirty: false,
  frame: 0,
  tool: "pencil" as Tool,
  /** Palette character the pencil paints; `.` means transparent. */
  ink: TRANSPARENT,
  grid: true,
  onion: true,
  playing: false,
  fps: 6,
  /** The play head, driven by the preview and read by the frame strip, so both
   *  show the same frame instead of each running its own clock. */
  playhead: 0,
  /** Which tint the neon cells are shown in — a tinted sprite bakes once per
   *  tint, so the editor has to be able to look at each of them. */
  tint: 0,
  status: "" as string,
});

let undo: SpriteFile[] = [];
let redo: SpriteFile[] = [];

export const canUndo = () => undo.length > 0;
export const canRedo = () => redo.length > 0;
/** Rune-visible counts, so the toolbar's disabled state actually updates. */
export const history = $state({ undo: 0, redo: 0 });

const syncHistory = () => {
  history.undo = undo.length;
  history.redo = redo.length;
};

/** Snapshot before a change. Every mutation below goes through this. */
function commit(next: SpriteFile) {
  undo.push(cloneSprite(editor.sprite));
  if (undo.length > MAX_UNDO) undo = undo.slice(-MAX_UNDO);
  redo = [];
  editor.sprite = next;
  editor.dirty = true;
  syncHistory();
}

export function undoEdit() {
  const prev = undo.pop();
  if (!prev) return;
  redo.push(cloneSprite(editor.sprite));
  editor.sprite = prev;
  editor.dirty = true;
  editor.frame = Math.min(editor.frame, prev.frames.length - 1);
  syncHistory();
}

export function redoEdit() {
  const next = redo.pop();
  if (!next) return;
  undo.push(cloneSprite(editor.sprite));
  editor.sprite = next;
  editor.dirty = true;
  editor.frame = Math.min(editor.frame, next.frames.length - 1);
  syncHistory();
}

export function loadSprite(sprite: SpriteFile, file: string | null) {
  editor.sprite = sprite;
  editor.file = file;
  editor.frame = 0;
  editor.dirty = false;
  editor.ink = Object.keys(sprite.palette)[0] ?? TRANSPARENT;
  undo = [];
  redo = [];
  syncHistory();
}

export function newSprite(name: string, w: number, h: number) {
  loadSprite(blankSprite(name, w, h), null);
}

// ---------- drawing ----------

/** What a tool paints with — the eraser is a pencil loaded with transparent. */
const inkFor = (tool: Tool): string => (tool === "eraser" ? TRANSPARENT : editor.ink);

const withFrame = (rows: string[]): SpriteFile => ({
  ...editor.sprite,
  frames: editor.sprite.frames.map((f, i) => (i === editor.frame ? rows : f)),
});

/** The pixels a drag would paint, for the live preview and for the commit. */
export function strokePoints(
  tool: Tool,
  from: { x: number; y: number },
  to: { x: number; y: number },
  filled: boolean,
): [number, number][] {
  switch (tool) {
    case "line":
      return linePoints(from.x, from.y, to.x, to.y);
    case "rect":
      return rectPoints(from.x, from.y, to.x, to.y, filled);
    case "ellipse":
      return ellipsePoints(from.x, from.y, to.x, to.y, filled);
    default:
      return linePoints(from.x, from.y, to.x, to.y);
  }
}

/**
 * Paint a stroke. `fresh` starts a new undo step; the rest of a drag folds into
 * it, so dragging the pencil across the sprite is one undo and not two hundred.
 */
export function paint(points: Iterable<readonly [number, number]>, fresh: boolean) {
  const rows = editor.sprite.frames[editor.frame];
  const next = setPixels(rows, points, inkFor(editor.tool));
  if (next === rows) return;
  if (fresh) commit(withFrame(next));
  else {
    editor.sprite = withFrame(next);
    editor.dirty = true;
  }
}

export function fillAt(x: number, y: number) {
  const rows = editor.sprite.frames[editor.frame];
  paint(floodPoints(rows, x, y), true);
}

export function pickAt(x: number, y: number) {
  const ch = editor.sprite.frames[editor.frame]?.[y]?.[x];
  if (ch) editor.ink = ch;
}

// ---------- selection ----------
//
// A selection is a set of cells, not a rectangle: clicking a shape selects the
// connected run under the cursor, which is rarely box-shaped. The bounds come
// along for the marquee to draw and for a paste to know where the block sits.
//
// Moving is a LIFT and a PUT-DOWN. On the first pixel of travel the selected
// cells are cleared from the frame and kept as a stamp; every later step puts
// that stamp down on the cleared frame at a new offset. So the undo stack gets
// one entry for a whole drag — the state before the block moved — and the frame
// is never a half-moved mess.

const key = (x: number, y: number) => `${x},${y}`;

export const selection = $state({
  /** "x,y" of every selected cell. Empty means no selection. */
  cells: new SvelteSet<string>(),
  x0: 0,
  y0: 0,
  x1: 0,
  y1: 0,
  /** Ticks up on every fresh selection: the canvas flashes what just got picked,
   *  because a one-pixel dashed outline is easy to miss on a dense sprite. */
  flash: 0,
});

/** The lifted block mid-move, and the frame it was lifted out of. */
let float: { stamp: Stamp; base: string[]; x: number; y: number } | null = null;
export const clipboard = $state({ stamp: null as Stamp | null });

export const hasSelection = () => selection.cells.size > 0;
export const isSelected = (x: number, y: number) => selection.cells.has(key(x, y));

function setSelection(points: Iterable<readonly [number, number]>) {
  const cells = new SvelteSet<string>();
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    cells.add(key(x, y));
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  selection.cells = cells;
  if (cells.size) {
    selection.x0 = x0;
    selection.y0 = y0;
    selection.x1 = x1;
    selection.y1 = y1;
    selection.flash++;
  }
}

/**
 * Clicking picks the whole connected SHAPE under it, whatever colours are in it:
 * what you point at is an object, not a colour. Fill's one-character rule would
 * hand back a highlight and leave the body it sits on behind.
 *
 * A click on empty space drops the selection instead of selecting the emptiness.
 * Nobody clicks the background meaning "select that", and every editor with a
 * marquee already reads a click on nothing as "never mind".
 */
export function selectShapeAt(x: number, y: number) {
  dropFloat();
  const pts = shapePoints(editor.sprite.frames[editor.frame], x, y);
  if (!pts.length) {
    selection.cells = new SvelteSet();
    return;
  }
  setSelection(pts);
}

export function selectBox(
  from: { x: number; y: number },
  to: { x: number; y: number },
  opaqueOnly = false,
) {
  dropFloat();
  const rows = editor.sprite.frames[editor.frame];
  const pts = rectPoints(from.x, from.y, to.x, to.y, true).filter(
    ([x, y]) => !opaqueOnly || (rows[y]?.[x] ?? TRANSPARENT) !== TRANSPARENT,
  );
  setSelection(pts);
}

export function selectAll() {
  dropFloat();
  const { w, h } = editor.sprite;
  setSelection(rectPoints(0, 0, w - 1, h - 1, true));
}

export function clearSelection() {
  dropFloat();
  selection.cells = new SvelteSet();
}

/** Let go of the block being moved. The pixels are already in the frame — the
 *  float only exists so the NEXT step can move them again without stacking a
 *  fresh undo entry per pixel of travel. */
function dropFloat() {
  float = null;
}

/**
 * Shift the selection by a whole number of cells. The first call in a run lifts
 * and takes the single undo snapshot; the rest ride on it.
 */
export function nudgeSelection(dx: number, dy: number) {
  if (!hasSelection() || (dx === 0 && dy === 0)) return;
  const rows = editor.sprite.frames[editor.frame];
  if (!float) {
    const pts = [...selection.cells].map((k) => k.split(",").map(Number) as [number, number]);
    const stamp = readStamp(rows, pts);
    const base = setPixels(rows, pts, TRANSPARENT);
    commit(withFrame(base));
    float = { stamp, base, x: selection.x0, y: selection.y0 };
  }
  float.x += dx;
  float.y += dy;
  editor.sprite = withFrame(stampCells(float.base, float.stamp, float.x, float.y));
  editor.dirty = true;
  // The marquee travels with the pixels.
  const moved = [...selection.cells].map((k) => {
    const [x, y] = k.split(",").map(Number);
    return [x + dx, y + dy] as [number, number];
  });
  const flash = selection.flash;
  setSelection(moved);
  selection.flash = flash; // a move is not a fresh pick; don't re-flash it
}

/** Wipe the selected cells. */
export function deleteSelection() {
  if (!hasSelection()) return;
  dropFloat();
  const rows = editor.sprite.frames[editor.frame];
  const pts = [...selection.cells].map((k) => k.split(",").map(Number) as [number, number]);
  const next = setPixels(rows, pts, TRANSPARENT);
  if (next !== rows) commit(withFrame(next));
}

export function copySelection() {
  if (!hasSelection()) return;
  const rows = editor.sprite.frames[editor.frame];
  const pts = [...selection.cells].map((k) => k.split(",").map(Number) as [number, number]);
  clipboard.stamp = readStamp(rows, pts);
}

export function cutSelection() {
  copySelection();
  deleteSelection();
}

/** Put the clipboard down at the top-left of the current selection, or where it
 *  was cut from if nothing is selected, and select it — so a paste lands ready
 *  to be dragged into place. */
export function pasteClipboard(at?: { x: number; y: number }) {
  const stamp = clipboard.stamp;
  if (!stamp?.cells.length) return;
  dropFloat();
  const x = at?.x ?? (hasSelection() ? selection.x0 : 0);
  const y = at?.y ?? (hasSelection() ? selection.y0 : 0);
  const rows = editor.sprite.frames[editor.frame];
  commit(withFrame(stampCells(rows, stamp, x, y)));
  setSelection(stamp.cells.map((c) => [x + c.dx, y + c.dy] as [number, number]));
}

// ---------- document ----------

export function resize(w: number, h: number, centred: boolean) {
  if (w === editor.sprite.w && h === editor.sprite.h) return;
  commit(resizeSprite(editor.sprite, w, h, centred ? "center" : "topLeft"));
}

export function rename(name: string) {
  if (!name || name === editor.sprite.name) return;
  commit({ ...editor.sprite, name });
}

export function setTints(tints: string[] | undefined) {
  commit({ ...editor.sprite, tints: tints?.length ? tints : undefined });
  editor.tint = Math.min(editor.tint, Math.max(0, (tints?.length ?? 1) - 1));
}

/** Make a plain sprite tintable, so its N/n cells have something to bake as. */
export const makeTinted = () => setTints([...DEFAULT_TINTS]);

export function addTint(hex = DEFAULT_TINTS[0]) {
  setTints([...(editor.sprite.tints ?? []), hex]);
}

export function setTint(index: number, hex: string) {
  const tints = [...(editor.sprite.tints ?? [])];
  if (index < 0 || index >= tints.length) return;
  tints[index] = hex;
  setTints(tints);
}

export function removeTint(index: number) {
  const tints = (editor.sprite.tints ?? []).filter((_, i) => i !== index);
  setTints(tints.length ? tints : undefined);
}

export const addFrame = () => commit(addFrameTo(editor.sprite, editor.frame));
export const duplicateFrame = () => commit(duplicateFrameIn(editor.sprite, editor.frame));
export function removeFrame() {
  const next = removeFrameFrom(editor.sprite, editor.frame);
  if (next === editor.sprite) return;
  commit(next);
  editor.frame = Math.min(editor.frame, next.frames.length - 1);
}
export function moveFrame(from: number, to: number) {
  const next = moveFrameIn(editor.sprite, from, to);
  if (next === editor.sprite) return;
  commit(next);
  editor.frame = to;
}

export const addColour = (hex: string) => commit(addColourTo(editor.sprite, hex));
export function removeColour(ch: string) {
  commit(removeColourFrom(editor.sprite, ch));
  if (editor.ink === ch) editor.ink = TRANSPARENT;
}
export const setColour = (ch: string, hex: string) => commit(setColourIn(editor.sprite, ch, hex));
export function renameChar(from: string, to: string) {
  const next = renameCharIn(editor.sprite, from, to);
  if (next === editor.sprite) return;
  commit(next);
  if (editor.ink === from) editor.ink = to;
}
