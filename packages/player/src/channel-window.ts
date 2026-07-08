// Shared channel-windowing math for the pattern views. The grid shows a frozen
// row-number gutter plus fixed-width channel columns; rather than a free scroll
// with a half-cut column at the edge, we show only WHOLE channels that fit and
// page through them one at a time (chevrons / swipe). The leftover width past the
// last whole column becomes a thick edge divider. Both PatternView (locked) and
// PatternViewScroll (free) use this so they behave identically.

/** Row-number gutter width (px) — frozen at the left of both views. */
export const ROWNUM_W = 30;
/** Fixed channel column width (px) — one whole channel steps the window by this. */
export const CELL_W = 130;

export type ChannelWindow = {
  /** How many whole channels fit right of the gutter (≥1). */
  visible: number;
  /** Offset clamped into range for the current width/count. */
  offset: number;
  /** Largest valid offset (0 when everything fits). */
  maxOffset: number;
  /** Width of the visible-channels viewport (visible × CELL_W), px. */
  windowW: number;
  /** Leftover px past the last whole column → the thick edge divider. */
  slack: number;
  /** More channels hidden to the left / right (drives the chevrons). */
  canLeft: boolean;
  canRight: boolean;
};

/** Compute the window for a container width, channel count and desired offset.
 *  The returned `offset` is clamped, so callers can store an unclamped offset and
 *  trust this for rendering (e.g. after a resize shrinks how many fit). */
export function channelWindow(
  containerW: number,
  count: number,
  offset: number,
  cellW = CELL_W,
  gutterW = ROWNUM_W,
): ChannelWindow {
  const avail = Math.max(0, containerW - gutterW);
  const visible = Math.max(1, Math.floor(avail / cellW));
  const maxOffset = Math.max(0, count - visible);
  const off = Math.min(Math.max(0, offset), maxOffset);
  const windowW = Math.min(visible, count) * cellW;
  // The thick edge divider only fills the leftover from *truncating* a partial
  // channel (paging active). When every channel already fits, the trailing space
  // is just empty surface — no giant divider.
  const fits = count <= visible;
  const slack = fits ? 0 : avail - windowW;
  return {
    visible,
    offset: off,
    maxOffset,
    windowW,
    slack,
    canLeft: off > 0,
    canRight: off < maxOffset,
  };
}
