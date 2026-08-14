// The sprite format, as a READER.
//
// A sprite is rows of characters plus the palette those characters mean. That is
// the whole format: it diffs as art (a changed pixel is a changed character on a
// line you can point at), it needs no decoder, and it is what a sprite was on the
// machines this art is dressed as. `.` is transparent everywhere and is never a
// palette key.
//
// A sprite may carry named PALETTE VARIANTS — alternate colours for some of its
// characters, so one drawing is recoloured without being redrawn — PARTS, an
// ordered list of child grids placed at offsets in its own coordinates, and
// CLIPS, named runs of frame indices so a strip that is an animation in one place
// and a set of states in another can say which it is.
//
// This file is deliberately only the four questions a consumer asks of a sprite:
// what colour is this cell, what looks does it have, what does this clip play, and
// what is placed on it. Editing sprites is ../dab's job — it owns the format, its
// validator and every operation on one (see its core/), and this used to be a copy
// of all of that. Two copies of a format that grows parts, paths and nesting is
// two readers that disagree; the scene only ever reads.
export type Flip = "h" | "v" | "hv";

/** A grid and everything that colours it — the shape a sprite and a part share. */
export type SpriteBody = {
  w: number;
  h: number;
  /** Character → `#rrggbb`, or `#rrggbbaa` for a translucent one. The car's glass
   *  is the case in hand: the seat behind the body shows through it. */
  palette: Record<string, string>;
  /** Named alternate colours, each overriding a subset of `palette` and
   *  inheriting the rest. */
  variants?: Record<string, Record<string, string>>;
  /** Named runs of frame indices. Repeats mean a hold; reversing is reading the
   *  list backwards, so there is no direction field and no duration — the clock
   *  belongs to whoever is playing it. */
  clips?: Record<string, number[]>;
  /** One entry per animation frame; each is `h` rows of `w` characters. */
  frames: string[][];
  /** Children, drawn in list order around this grid — see `Part`. */
  parts?: Part[];
};

/** Where a part sits on its parent, in the parent's own pixel coordinates. */
export type Placement = {
  /** Unique among its siblings: the key its state is held under. */
  name: string;
  x: number;
  y: number;
  /** Drawn before the parent's own grid rather than after — a seat behind a body,
   *  showing through the windows. */
  behind?: boolean;
  flip?: Flip;
};

/**
 * A part: a placement, plus either its own pixels or the name of a sprite in the
 * same folder to draw there.
 *
 * Inline for composition, which is intrinsic — a car's door is not a thing apart
 * from that car. `use` for reuse, which is a link — one wheel drawn once and
 * fixed once for every car in the folder.
 */
export type Part = Placement & (SpriteBody | { use: string });

export type SpriteFile = SpriteBody & { name: string };

export const TRANSPARENT = ".";

/** A part that names another sprite rather than carrying pixels. */
export const isPartRef = (p: Part): p is Placement & { use: string } => "use" in p;

/** A part that carries its own pixels — and is therefore a sprite. */
export const isPartBody = (p: Part): p is Placement & SpriteBody => !("use" in p);

/**
 * What a cell paints as: the variant's colour for that character if the named
 * variant has one, otherwise the palette's.
 *
 * This is the whole rule the format asks a consumer to implement.
 */
export function cellColour(s: SpriteBody, ch: string, variant?: string | null): string | null {
  if (ch === TRANSPARENT) return null;
  if (variant) {
    const alt = s.variants?.[variant]?.[ch];
    if (alt) return alt;
  }
  return s.palette[ch] ?? null;
}

/** The variant names a sprite offers, in declaration order. */
export const variantNames = (s: SpriteBody): string[] => Object.keys(s.variants ?? {});

/** A part's grid, mirrored. Baked rather than done per frame: a flip is free in
 *  this format, and it must look the same here as it does in the editor. */
export function flipRows(rows: string[], flip?: Flip): string[] {
  if (!flip) return rows;
  const v = flip === "v" || flip === "hv" ? [...rows].reverse() : rows;
  return flip === "h" || flip === "hv" ? v.map((r) => [...r].reverse().join("")) : v;
}

/** The frames a clip plays, in order, or null for a name the node has not got.
 *  No silent fallback to the whole strip: that hides a typo. */
export function clipFrames(node: SpriteBody, name: string): number[] | null {
  const clip = node.clips?.[name];
  return clip ? [...clip] : null;
}

/** A part by name, or null. */
export const partNamed = (node: SpriteBody, name: string): Part | null =>
  (node.parts ?? []).find((p) => p.name === name) ?? null;
