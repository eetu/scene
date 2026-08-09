// The VIC-II's sixteen colours.
//
// Not a design choice — it's the whole palette a C64 had, fixed in silicon, and
// every C64 screen ever made is built from these and nothing else. Using them
// is most of what makes a picture read as a C64 rather than as pixel art.
//
// The values are Pepto's, measured from a PAL VIC-II's composite output rather
// than taken from a datasheet: the chip generates colour as a phase and
// amplitude on the colour carrier, so there is no canonical RGB triple to look
// up, and the naive conversions in circulation come out visibly wrong (the
// browns muddy, the greys not actually neutral). <https://www.pepto.de/projects/colorvic/>

/** Colour index, as poked into colour RAM. */
export type C64Color = number;

export const BLACK = 0;
export const WHITE = 1;
export const RED = 2;
export const CYAN = 3;
export const PURPLE = 4;
export const GREEN = 5;
export const BLUE = 6;
export const YELLOW = 7;
export const ORANGE = 8;
export const BROWN = 9;
export const LIGHT_RED = 10;
export const DARK_GREY = 11;
export const GREY = 12;
export const LIGHT_GREEN = 13;
export const LIGHT_BLUE = 14;
export const LIGHT_GREY = 15;

/** The palette, indexed by colour number. */
export const VIC_PALETTE: readonly string[] = [
  "#000000", // 0  black
  "#ffffff", // 1  white
  "#813338", // 2  red
  "#75cec8", // 3  cyan
  "#8e3c97", // 4  purple
  "#56ac4d", // 5  green
  "#2e2c9b", // 6  blue
  "#edf171", // 7  yellow
  "#8e5029", // 8  orange
  "#553800", // 9  brown
  "#c46c71", // 10 light red
  "#4a4a4a", // 11 dark grey
  "#7b7b7b", // 12 grey
  "#a9ff9f", // 13 light green
  "#706deb", // 14 light blue
  "#b2b2b2", // 15 light grey
];

/**
 * The colours a raster bar cycles through, dark to light.
 *
 * Ordered by luminance rather than by index, because a bar is read as a
 * gradient: stepping through the palette in numeric order gives a bar that
 * flickers between unrelated hues instead of one that appears to be lit.
 *
 * Black is deliberately not in it. A raster bar is a beam the display is
 * emitting — the music modulates its colour, not whether it exists — so a ramp
 * that bottoms out at the background makes a quiet passage look like the effect
 * has crashed rather than like it has gone dim.
 */
export const RASTER_RAMP: readonly C64Color[] = [
  BLUE, // luminance 57
  PURPLE, // 95
  LIGHT_BLUE, // 125
  LIGHT_GREY, // 178
  CYAN, // 179
  WHITE, // 255
];

/**
 * Fire, cold to white-hot.
 *
 * The VIC's warm colours happen to make a genuine blackbody ramp, which is why
 * every C64 fire routine looks the same: there was exactly one way to do it.
 * Ordered by luminance again — brown really is darker than red here.
 */
export const FIRE_RAMP: readonly C64Color[] = [
  BLACK, // 0
  BROWN, // 58
  RED, // 75
  ORANGE, // 94
  YELLOW, // 225
  WHITE, // 255
];
// Light red sits at luminance 135, between orange and yellow, and by luminance
// alone it belongs here. It is left out because it is a salmon pink: dropped
// into the middle of a fire it paints a distinctly pink band across the flames.
// Hue wins over luminance when the ramp is meant to be a temperature.

/**
 * A closed hue circle, for effects that cycle colour rather than brightness.
 *
 * It has to *wrap* — a plasma indexes it with a repeating field, so a ramp that
 * ran dark-to-light would snap back to black on every cycle and pulse like a
 * fault. These step around the wheel and meet themselves.
 */
export const HUE_WHEEL: readonly C64Color[] = [
  BLUE,
  PURPLE,
  RED,
  ORANGE,
  YELLOW,
  LIGHT_GREEN,
  CYAN,
  LIGHT_BLUE,
];

/**
 * A matched cool/warm pair, for an object whose surface is made of stripes.
 *
 * A 16-colour palette can't darken an arbitrary hue, so a striped object can't
 * be shaded stripe by stripe. Two ramps climbing from opposite ends of the wheel
 * can: alternate them and the stripes stay distinct while both still read as
 * lit by the same light.
 *
 * Two constraints, both learned the hard way. Neither bottoms out at black — a
 * stripe that reaches the background reads as a hole in the object rather than
 * as its dark side. And neither reaches white: if both ramps end at the same
 * colour then every stripe facing the viewer is that colour, and the near face
 * of the object — the part you look at — merges into one flat blob.
 */
export const COOL_RAMP: readonly C64Color[] = [BLUE, PURPLE, LIGHT_BLUE, CYAN];
export const WARM_RAMP: readonly C64Color[] = [BROWN, RED, ORANGE, YELLOW];

/** Distance, near to far — the greys plus white, for stars and vector balls. */
export const DEPTH_RAMP: readonly C64Color[] = [
  WHITE, // 255, nearest
  LIGHT_GREY, // 178
  GREY, // 123
  DARK_GREY, // 74, furthest
];

export const rgb = (c: C64Color): string => VIC_PALETTE[c & 0x0f];
