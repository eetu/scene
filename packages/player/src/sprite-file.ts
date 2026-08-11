// The sprite file format, and every operation that edits one.
//
// A sprite is rows of characters plus the palette those characters mean. That
// is the whole format: it diffs as art (a changed pixel is a changed character
// on a line you can point at), it needs no decoder, and it is the same shape
// the machines this art is dressed as used. `.` is transparent everywhere and
// is never a palette entry.
//
// Everything here is pure and string-in/string-out, so the editor's undo stack
// is a list of sprites rather than a list of inverse operations, and every tool
// is testable without a canvas.

export type SpriteFile = {
  name: string;
  w: number;
  h: number;
  /** Character → `#rrggbb`. Order is the palette's order in the editor. */
  palette: Record<string, string>;
  /**
   * Optional recolour targets. `N` (bright) and `n` (dim) are baked once per
   * entry, so one tube sprite can be magenta on one building and cyan on the
   * next without a filter pass at runtime.
   */
  tints?: string[];
  /** One entry per animation frame; each is `h` rows of `w` characters. */
  frames: string[][];
};

export const TRANSPARENT = ".";
/** Characters the tint pass owns — they take their colour from `tints`. */
export const NEON_CHARS = ["N", "n"] as const;

/** How dim the `n` half of a tube is against its `N` half. */
export const NEON_DIM = 0.42;

/**
 * The colour a neon cell bakes to.
 *
 * Lives here rather than in the renderer because the editor has to show what
 * the scene will bake — two copies of this number is two pictures that disagree.
 */
export function neonColour(hex: string, ch: string): string {
  if (ch !== "n") return hex;
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) * NEON_DIM;
  const g = ((n >> 8) & 255) * NEON_DIM;
  const b = (n & 255) * NEON_DIM;
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

/** The tints a sprite gets when it is first made tintable: the scene's two. */
export const DEFAULT_TINTS = ["#ff3bd4", "#39f6ff"];

/** What a cell paints as, given the sprite and which tint is being previewed. */
export function cellColour(s: SpriteFile, ch: string, tint = 0): string | null {
  if (ch === TRANSPARENT) return null;
  if (ch === "N" || ch === "n") {
    return neonColour(s.tints?.[tint] ?? s.tints?.[0] ?? DEFAULT_TINTS[0], ch);
  }
  return s.palette[ch] ?? null;
}

export const blankFrame = (w: number, h: number): string[] =>
  Array.from({ length: h }, () => TRANSPARENT.repeat(w));

export function blankSprite(name: string, w: number, h: number): SpriteFile {
  return { name, w, h, palette: {}, frames: [blankFrame(w, h)] };
}

/** Deep copy. Rows are strings, so only the arrays need cloning. */
export const cloneSprite = (s: SpriteFile): SpriteFile => ({
  ...s,
  palette: { ...s.palette },
  tints: s.tints ? [...s.tints] : undefined,
  frames: s.frames.map((f) => [...f]),
});

/**
 * Everything wrong with a sprite, as sentences.
 *
 * Returned as a list rather than thrown: a file dragged in from somewhere else
 * is usually wrong in one small way, and the editor can show all of them at
 * once instead of one per reload.
 */
export function validateSprite(s: unknown): string[] {
  const errors: string[] = [];
  const sp = s as Partial<SpriteFile>;
  if (!sp || typeof sp !== "object") return ["not an object"];
  if (typeof sp.name !== "string" || !sp.name) errors.push("name is missing");
  if (!Number.isInteger(sp.w) || (sp.w ?? 0) < 1) errors.push("w must be a positive integer");
  if (!Number.isInteger(sp.h) || (sp.h ?? 0) < 1) errors.push("h must be a positive integer");
  if (!sp.palette || typeof sp.palette !== "object") errors.push("palette is missing");
  else {
    for (const [ch, hex] of Object.entries(sp.palette)) {
      if (ch.length !== 1) errors.push(`palette key ${JSON.stringify(ch)} is not one character`);
      if (ch === TRANSPARENT) errors.push("`.` is transparent and cannot carry a colour");
      if (!/^#[0-9a-fA-F]{6}$/.test(hex)) errors.push(`${ch} is not a #rrggbb colour: ${hex}`);
    }
  }
  if (!Array.isArray(sp.frames) || sp.frames.length === 0) errors.push("frames is empty");
  else {
    const known = new Set([...Object.keys(sp.palette ?? {}), TRANSPARENT, ...NEON_CHARS]);
    sp.frames.forEach((frame, fi) => {
      if (!Array.isArray(frame) || frame.length !== sp.h) {
        errors.push(
          `frame ${fi} has ${Array.isArray(frame) ? frame.length : "?"} rows, expected ${sp.h}`,
        );
        return;
      }
      frame.forEach((row, ri) => {
        if (typeof row !== "string" || row.length !== sp.w) {
          errors.push(`frame ${fi} row ${ri} is ${row?.length ?? "?"} wide, expected ${sp.w}`);
          return;
        }
        for (const ch of row) {
          if (!known.has(ch)) errors.push(`frame ${fi} row ${ri} uses ${ch}, which has no colour`);
        }
      });
    });
  }
  return [...new Set(errors)];
}

// ---------- geometry ----------

export type Anchor = "topLeft" | "center";

/**
 * Resize the canvas — crop or pad, never scale.
 *
 * Pixel art has no meaningful resample: doubling a 72×18 car gives a blurry
 * 144×36 car or a blocky one, and neither is what "make it bigger" means when
 * the grid IS the drawing. Growing pads with transparent, shrinking crops.
 */
export function resizeSprite(
  s: SpriteFile,
  w: number,
  h: number,
  anchor: Anchor = "topLeft",
): SpriteFile {
  const dx = anchor === "center" ? Math.round((w - s.w) / 2) : 0;
  const dy = anchor === "center" ? Math.round((h - s.h) / 2) : 0;
  const frames = s.frames.map((frame) =>
    Array.from({ length: h }, (_, y) => {
      const src = frame[y - dy];
      let row = "";
      for (let x = 0; x < w; x++) {
        const sx = x - dx;
        row += src && sx >= 0 && sx < s.w ? src[sx] : TRANSPARENT;
      }
      return row;
    }),
  );
  return { ...s, w, h, frames };
}

export const getPixel = (frame: string[], x: number, y: number): string =>
  frame[y]?.[x] ?? TRANSPARENT;

export function setPixel(frame: string[], x: number, y: number, ch: string): string[] {
  if (y < 0 || y >= frame.length || x < 0 || x >= frame[y].length) return frame;
  if (frame[y][x] === ch) return frame;
  const out = [...frame];
  out[y] = out[y].slice(0, x) + ch + out[y].slice(x + 1);
  return out;
}

/** Apply one character to many pixels at once — every shape tool ends here. */
export function setPixels(
  frame: string[],
  points: Iterable<readonly [number, number]>,
  ch: string,
): string[] {
  const rows = frame.map((r) => r.split(""));
  let touched = false;
  for (const [x, y] of points) {
    if (y < 0 || y >= rows.length || x < 0 || x >= rows[y].length) continue;
    if (rows[y][x] === ch) continue;
    rows[y][x] = ch;
    touched = true;
  }
  return touched ? rows.map((r) => r.join("")) : frame;
}

// ---------- shapes ----------

/** Bresenham. Integer steps only — a float line rounds to an uneven stair. */
export function linePoints(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const pts: [number, number][] = [];
  let x = Math.round(x0);
  let y = Math.round(y0);
  const ex = Math.round(x1);
  const ey = Math.round(y1);
  const dx = Math.abs(ex - x);
  const dy = -Math.abs(ey - y);
  const sx = x < ex ? 1 : -1;
  const sy = y < ey ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    pts.push([x, y]);
    if (x === ex && y === ey) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return pts;
}

export function rectPoints(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  filled: boolean,
): [number, number][] {
  const xa = Math.min(x0, x1);
  const xb = Math.max(x0, x1);
  const ya = Math.min(y0, y1);
  const yb = Math.max(y0, y1);
  const pts: [number, number][] = [];
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      if (filled || y === ya || y === yb || x === xa || x === xb) pts.push([x, y]);
    }
  }
  return pts;
}

/** Midpoint ellipse inscribed in the dragged box, so a square drag is a circle. */
export function ellipsePoints(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  filled: boolean,
): [number, number][] {
  const xa = Math.min(x0, x1);
  const xb = Math.max(x0, x1);
  const ya = Math.min(y0, y1);
  const yb = Math.max(y0, y1);
  const cx = (xa + xb) / 2;
  const cy = (ya + yb) / 2;
  const rx = (xb - xa) / 2 + 0.001;
  const ry = (yb - ya) / 2 + 0.001;
  const pts: [number, number][] = [];
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      const d = nx * nx + ny * ny;
      if (filled ? d <= 1 : d <= 1 && !insideRing(x, y, cx, cy, rx, ry)) pts.push([x, y]);
    }
  }
  return pts;
}

/** True when every 4-neighbour is also inside — i.e. not on the outline. */
function insideRing(x: number, y: number, cx: number, cy: number, rx: number, ry: number): boolean {
  const inside = (px: number, py: number) => {
    const nx = (px - cx) / rx;
    const ny = (py - cy) / ry;
    return nx * nx + ny * ny <= 1;
  };
  return inside(x - 1, y) && inside(x + 1, y) && inside(x, y - 1) && inside(x, y + 1);
}

/** 4-connected flood fill from a seed, bounded by the frame. */
export function floodPoints(frame: string[], x: number, y: number): [number, number][] {
  const target = getPixel(frame, x, y);
  if (y < 0 || y >= frame.length || x < 0 || x >= frame[0].length) return [];
  const w = frame[0].length;
  const h = frame.length;
  const seen = new Uint8Array(w * h);
  const out: [number, number][] = [];
  const stack: [number, number][] = [[x, y]];
  while (stack.length) {
    const [px, py] = stack.pop()!;
    if (px < 0 || px >= w || py < 0 || py >= h) continue;
    if (seen[py * w + px]) continue;
    if (frame[py][px] !== target) continue;
    seen[py * w + px] = 1;
    out.push([px, py]);
    stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
  }
  return out;
}

// ---------- frames ----------

export const addFrame = (s: SpriteFile, after = s.frames.length - 1): SpriteFile => ({
  ...s,
  frames: [...s.frames.slice(0, after + 1), blankFrame(s.w, s.h), ...s.frames.slice(after + 1)],
});

export const duplicateFrame = (s: SpriteFile, index: number): SpriteFile => ({
  ...s,
  frames: [...s.frames.slice(0, index + 1), [...s.frames[index]], ...s.frames.slice(index + 1)],
});

export const removeFrame = (s: SpriteFile, index: number): SpriteFile =>
  s.frames.length <= 1 ? s : { ...s, frames: s.frames.filter((_, i) => i !== index) };

export function moveFrame(s: SpriteFile, from: number, to: number): SpriteFile {
  if (from === to || from < 0 || to < 0 || from >= s.frames.length || to >= s.frames.length)
    return s;
  const frames = [...s.frames];
  const [f] = frames.splice(from, 1);
  frames.splice(to, 0, f);
  return { ...s, frames };
}

// ---------- palette ----------

/** Characters a sprite may use, in a stable order, skipping the taken ones. */
export const PALETTE_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+*=#@%&$";

export function nextFreeChar(s: SpriteFile): string | null {
  const taken = new Set([...Object.keys(s.palette), TRANSPARENT]);
  for (const ch of PALETTE_CHARS) if (!taken.has(ch)) return ch;
  return null;
}

export function addColour(s: SpriteFile, hex: string): SpriteFile {
  const ch = nextFreeChar(s);
  if (!ch) return s;
  return { ...s, palette: { ...s.palette, [ch]: hex } };
}

/**
 * Drop a colour and erase every pixel that used it.
 *
 * The alternative — leaving the character in place with no colour — produces a
 * file that fails validation the moment it is reloaded, which is a worse
 * surprise than losing the pixels you asked to drop.
 */
export function removeColour(s: SpriteFile, ch: string): SpriteFile {
  const palette = { ...s.palette };
  delete palette[ch];
  const frames = s.frames.map((f) => f.map((row) => row.split(ch).join(TRANSPARENT)));
  return { ...s, palette, frames };
}

/** Move a colour to a different character, rewriting every pixel that used it. */
export function renameChar(s: SpriteFile, from: string, to: string): SpriteFile {
  if (from === to || to === TRANSPARENT || to.length !== 1 || s.palette[to]) return s;
  const palette: Record<string, string> = {};
  for (const [ch, hex] of Object.entries(s.palette)) palette[ch === from ? to : ch] = hex;
  const frames = s.frames.map((f) => f.map((row) => row.split(from).join(to)));
  return { ...s, palette, frames };
}

export const setColour = (s: SpriteFile, ch: string, hex: string): SpriteFile => ({
  ...s,
  palette: { ...s.palette, [ch]: hex },
});

/** Palette entries no frame uses — the editor offers to sweep these up. */
export function unusedChars(s: SpriteFile): string[] {
  const used = new Set<string>();
  for (const f of s.frames) for (const row of f) for (const ch of row) used.add(ch);
  return Object.keys(s.palette).filter((ch) => !used.has(ch));
}

// ---------- serialisation ----------

/**
 * Stable JSON: keys in a fixed order and one frame row per line.
 *
 * Written by hand rather than with JSON.stringify's indent, because the default
 * puts every row on its own heavily-indented line and the point of this format
 * is that a frame reads as a picture in the diff.
 */
export function toJson(s: SpriteFile): string {
  const pal = Object.entries(s.palette)
    .map(([ch, hex]) => `    ${JSON.stringify(ch)}: ${JSON.stringify(hex)}`)
    .join(",\n");
  const frames = s.frames
    .map((f) => `    [\n${f.map((row) => `      ${JSON.stringify(row)}`).join(",\n")}\n    ]`)
    .join(",\n");
  const tints = s.tints?.length ? `  "tints": ${JSON.stringify(s.tints)},\n` : "";
  return (
    `{\n` +
    `  "name": ${JSON.stringify(s.name)},\n` +
    `  "w": ${s.w},\n` +
    `  "h": ${s.h},\n` +
    `  "palette": {\n${pal}\n  },\n` +
    tints +
    `  "frames": [\n${frames}\n  ]\n` +
    `}\n`
  );
}

export function fromJson(text: string): { sprite: SpriteFile } | { errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { errors: [`not JSON: ${(e as Error).message}`] };
  }
  const errors = validateSprite(parsed);
  return errors.length ? { errors } : { sprite: parsed as SpriteFile };
}
