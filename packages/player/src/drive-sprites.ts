// The night drive's sprite sheet: loading the art, and baking it into an atlas.
//
// The art itself is NOT here. Each sprite is a file under ./sprites — rows of
// characters plus the palette those characters mean (see sprite-file.ts) —
// authored in dab (../dab) and imported below. Text rather than an image
// because that is what a sprite was on the machines this scene is dressed as,
// and because it keeps the art in the diff: a tweak to the car's roofline shows
// up in review as a changed line, not as "Bin 4kB -> 4kB".
//
// Everything is baked once at mount. Per frame the scene issues drawImage calls
// against the atlas, so the cost of a lamp post is the same whether it is six
// pixels or six hundred, and the pixels themselves are never recomputed.
import {
  cellColour,
  clipFrames,
  type Flip,
  flipRows,
  isPartRef,
  partNamed,
  type SpriteBody,
  type SpriteFile,
  variantNames,
} from "./sprite-file";

export type Rect = { x: number; y: number; w: number; h: number };

/**
 * One of a sprite's parts, ready to draw: the atlas key its pixels are under, the
 * offset it sits at, and whether it goes down before its parent's own grid.
 *
 * A part with its own pixels is baked under `parent/name`; a part that names
 * another sprite (`use`) is that sprite's own entry, so a wheel is baked once
 * however many cars are placed on it.
 */
export type Placed = {
  key: string;
  name: string;
  x: number;
  y: number;
  behind: boolean;
  frames: number;
};

export type Atlas = {
  canvas: HTMLCanvasElement;
  /**
   * Where a sprite's pixels are on the sheet.
   *
   * `key` names a sprite, or one of its inline parts as `parent/part`. `look` is
   * an index into the looks: 0 is the sprite's own palette, then its variants in
   * declaration order. The scene carries a number rather than a variant's name
   * because that is what its world model has — a sign is generated with
   * `hue: 0 | 1` long before anything knows a sheet exists.
   */
  rect(key: string, frame?: number, look?: number): Rect | null;
  /** Frames a sprite has, for callers stepping an animation. */
  frames(key: string): number;
  /** What is placed on a sprite, in draw order. Empty for a plain sprite. */
  parts(key: string): Placed[];
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

/**
 * Landmarks: real buildings, drawn as themselves.
 *
 * Every tower in this city is generated, which is what lets it run forever — and
 * what means none of it is anywhere. These three are the exception: Näsinneula,
 * Haukilahti's water tower and the Olympic stadium's tower, passing one at a time
 * every few minutes. Frame 0 is the building with its aircraft light lit, frame 1
 * the same building with the lamp dark; nothing else about them animates.
 */
export const LANDMARK_NAMES = ["nasinneula", "vesitorni", "stadion"] as const;

export const CAR_W = SPRITES.car.w;
export const CAR_H = SPRITES.car.h;

/**
 * Where the car's tyres meet the road, in its own coordinates.
 *
 * Read off the car's parts rather than written down here: the wheels are two
 * placements of the `wheel` sprite, and the middle of one is the contact patch —
 * which is what the skid marks, the tyre smoke and the snow rut are all actually
 * asking for. It used to be a pair of hardcoded rim origins, and the art moving
 * three pixels was a silent bug in three effects.
 */
export const CAR_CONTACTS: number[] = (SPRITES.car.parts ?? [])
  .filter((p) => isPartRef(p) && p.use === "wheel")
  .map((p) => p.x + (SPRITES.wheel.w >> 1));

/**
 * The pop-up headlights coming up, as the frames the sprite says are that move.
 *
 * The lamp part carries `open` and `close` clips over its three frames, so the
 * order is the art's to state and not the scene's to assume.
 */
export const LAMP_RAISE: number[] = (() => {
  const lamp = partNamed(SPRITES.car, "lights");
  return (lamp && !isPartRef(lamp) && clipFrames(lamp, "open")) || [0];
})();

/**
 * Bake every sprite, part, look and frame into one canvas.
 *
 * A sprite's LOOKS are its own palette followed by each of its variants, so a
 * tube sprite is baked once magenta and once cyan and the scene picks between two
 * rects rather than recolouring anything per frame. Its PARTS are baked as
 * grids of their own under `parent/part`, because that is what they are — a
 * subject that is not one grid, said without multiplying its frame strip by every
 * combination of its doors, lamps and wheels. A part that names another sprite
 * (`use`) is not baked again; it is that sprite's own entry.
 *
 * Shelf packing, left to right and wrapping at a fixed width: an atlas this
 * small does not need a real packer, and a stable layout means a frame's rect
 * is the same every run, which is what makes the sheet worth looking at when
 * something draws wrong.
 */
export function bakeAtlas(defs: Record<string, SpriteFile> = SPRITES): Atlas {
  const MAX_ROW = 256;
  type Cell = { rect: Rect; body: SpriteBody; frame: number; variant: string | null; flip?: Flip };
  const cells: { key: string; entry: Cell }[] = [];
  const counts = new Map<string, number>();
  const placements = new Map<string, Placed[]>();
  let penX = 0;
  let penY = 0;
  let shelfH = 0;

  /** One grid — a sprite or an inline part — and then whatever is placed on it. */
  const walk = (key: string, body: SpriteBody, flip?: Flip) => {
    counts.set(key, body.frames.length);
    // Index 0 is the palette itself — `null`, i.e. no variant selected.
    const looks: (string | null)[] = [null, ...variantNames(body)];
    for (let t = 0; t < looks.length; t++) {
      for (let f = 0; f < body.frames.length; f++) {
        if (penX + body.w > MAX_ROW) {
          penX = 0;
          penY += shelfH + 1;
          shelfH = 0;
        }
        cells.push({
          key: `${key}/${f}/${t}`,
          entry: {
            rect: { x: penX, y: penY, w: body.w, h: body.h },
            body,
            frame: f,
            variant: looks[t],
            flip,
          },
        });
        penX += body.w + 1;
        shelfH = Math.max(shelfH, body.h);
      }
    }
    const placed: Placed[] = [];
    for (const p of body.parts ?? []) {
      const childKey = isPartRef(p) ? p.use : `${key}/${p.name}`;
      if (!isPartRef(p)) walk(childKey, p, p.flip);
      placed.push({
        key: childKey,
        name: p.name,
        x: p.x,
        y: p.y,
        behind: p.behind === true,
        // A `use` part's frame count is the referenced sprite's, which may not have
        // been walked yet — so it is read off the definition, not off `counts`.
        frames: isPartRef(p) ? (defs[p.use]?.frames.length ?? 0) : p.frames.length,
      });
    }
    if (placed.length) placements.set(key, placed);
  };

  for (const [name, sprite] of Object.entries(defs)) walk(name, sprite);

  const canvas = document.createElement("canvas");
  canvas.width = MAX_ROW;
  canvas.height = penY + shelfH + 1;
  const ctx = canvas.getContext("2d");
  const index = new Map<string, Rect>();

  for (const { key, entry } of cells) {
    index.set(key, entry.rect);
    if (!ctx) continue;
    const rows = flipRows(entry.body.frames[entry.frame], entry.flip);
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y];
      for (let x = 0; x < row.length; x++) {
        const colour = cellColour(entry.body, row[x], entry.variant);
        if (!colour) continue;
        ctx.fillStyle = colour;
        ctx.fillRect(entry.rect.x + x, entry.rect.y + y, 1, 1);
      }
    }
  }

  return {
    canvas,
    rect: (key, frame = 0, look = 0) => index.get(`${key}/${frame}/${look}`) ?? null,
    frames: (key) => counts.get(key) ?? 0,
    parts: (key) => placements.get(key) ?? [],
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
  look = 0,
): void {
  const r = atlas.rect(name, frame, look);
  if (!r) return;
  ctx.drawImage(atlas.canvas, r.x, r.y, r.w, r.h, Math.round(x), Math.round(y), r.w, r.h);
}
