// The night drive's sprite sheet: loading the art, and baking it into an atlas.
//
// The art itself is NOT here. Each sprite is a file under ./sprites — rows of
// characters plus the palette those characters mean (see sprite-file.ts) —
// authored in tools/sprite-editor and imported below. Text rather than an image
// because that is what a sprite was on the machines this scene is dressed as,
// and because it keeps the art in the diff: a tweak to the car's roofline shows
// up in review as a changed line, not as "Bin 4kB -> 4kB".
//
// Everything is baked once at mount. Per frame the scene issues drawImage calls
// against the atlas, so the cost of a lamp post is the same whether it is six
// pixels or six hundred, and the pixels themselves are never recomputed.
import { DEFAULT_TINTS, neonColour, type SpriteFile } from "./sprite-file";

export type Rect = { x: number; y: number; w: number; h: number };

export type Atlas = {
  canvas: HTMLCanvasElement;
  rect(name: string, frame?: number, tint?: number): Rect | null;
  /** Frames a sprite has, for callers stepping an animation. */
  frames(name: string): number;
};

/**
 * The sheet: every sprite file in ./sprites, keyed by the name inside it.
 *
 * Globbed rather than listed, so the folder IS the registry — adding a sprite is
 * one file and no code, and renaming one in the editor (which moves the file)
 * does not leave a dangling import behind. What a rename *can* still break is a
 * name the scene asks for by hand; those are the constants below, and a test
 * asserts the sheet still has every one of them.
 */
const FILES = import.meta.glob<SpriteFile>("./sprites/*.json", { eager: true, import: "default" });

export const SPRITES: Record<string, SpriteFile> = Object.fromEntries(
  Object.values(FILES).map((sprite) => [sprite.name, sprite]),
);

/**
 * Sign sprites, in the order the city picks from them.
 *
 * The boxes came first; the kana columns, the hanging noodle banner and the heart
 * are what make the skyline read as the neo-oriental city this scene is dressed
 * as rather than as a generic downtown with two tube colours.
 */
export const SIGN_NAMES = [
  "signBar",
  "signArrow",
  "signBlock",
  "signKanaTall",
  "signKanaHang",
  "signKanaWide",
  "signKanaHotel",
  "signKanaShort",
  "signKanaMilk",
  "signHeart",
] as const;

/** What each sign measures — the city's fit test needs the sizes and must not
 *  reach for the atlas to get them: a kana column is three times the height of a
 *  box sign, and a tower too short for one has to pick something else. */
export const SIGN_SIZES: ReadonlyArray<{ w: number; h: number }> = SIGN_NAMES.map((n) => ({
  w: SPRITES[n].w,
  h: SPRITES[n].h,
}));
export const CROWN_NAMES = ["crownTank", "crownStep", "crownMast"] as const;

export const CAR_W = SPRITES.car.w;
export const CAR_H = SPRITES.car.h;
/** Rim origins in the car's own sprite coordinates: where the spokes go. */
export const CAR_WHEELS: ReadonlyArray<readonly [number, number]> = [
  [11, 11],
  [52, 11],
];

/**
 * Bake every sprite, tint and frame into one canvas.
 *
 * Shelf packing, left to right and wrapping at a fixed width: an atlas this
 * small does not need a real packer, and a stable layout means a frame's rect
 * is the same every run, which is what makes the sheet worth looking at when
 * something draws wrong.
 */
export function bakeAtlas(defs: Record<string, SpriteFile> = SPRITES): Atlas {
  const MAX_ROW = 256;
  type Placed = { rect: Rect; sprite: SpriteFile; frame: number; neon: string };
  const placed: { key: string; entry: Placed }[] = [];
  let penX = 0;
  let penY = 0;
  let shelfH = 0;

  for (const [name, sprite] of Object.entries(defs)) {
    const tints = sprite.tints?.length ? sprite.tints : [DEFAULT_TINTS[0]];
    for (let t = 0; t < tints.length; t++) {
      for (let f = 0; f < sprite.frames.length; f++) {
        if (penX + sprite.w > MAX_ROW) {
          penX = 0;
          penY += shelfH + 1;
          shelfH = 0;
        }
        placed.push({
          key: `${name}/${f}/${t}`,
          entry: {
            rect: { x: penX, y: penY, w: sprite.w, h: sprite.h },
            sprite,
            frame: f,
            neon: tints[t],
          },
        });
        penX += sprite.w + 1;
        shelfH = Math.max(shelfH, sprite.h);
      }
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = MAX_ROW;
  canvas.height = penY + shelfH + 1;
  const ctx = canvas.getContext("2d");
  const index = new Map<string, Rect>();
  const counts = new Map<string, number>();
  for (const [name, sprite] of Object.entries(defs)) counts.set(name, sprite.frames.length);

  for (const { key, entry } of placed) {
    index.set(key, entry.rect);
    if (!ctx) continue;
    const rows = entry.sprite.frames[entry.frame];
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y];
      for (let x = 0; x < row.length; x++) {
        const ch = row[x];
        // Neon takes the tint being baked; everything else its own palette.
        const colour =
          ch === "N" || ch === "n" ? neonColour(entry.neon, ch) : entry.sprite.palette[ch];
        if (!colour) continue;
        ctx.fillStyle = colour;
        ctx.fillRect(entry.rect.x + x, entry.rect.y + y, 1, 1);
      }
    }
  }

  return {
    canvas,
    rect: (name, frame = 0, tint = 0) => index.get(`${name}/${frame}/${tint}`) ?? null,
    frames: (name) => counts.get(name) ?? 0,
  };
}

/** Blit one sprite. Coordinates are rounded: a sprite landing between two
 *  buffer pixels is the one way to lose the pixel grid this scene is built on. */
export function drawSprite(
  ctx: CanvasRenderingContext2D,
  atlas: Atlas,
  name: string,
  x: number,
  y: number,
  frame = 0,
  tint = 0,
): void {
  const r = atlas.rect(name, frame, tint);
  if (!r) return;
  ctx.drawImage(atlas.canvas, r.x, r.y, r.w, r.h, Math.round(x), Math.round(y), r.w, r.h);
}
