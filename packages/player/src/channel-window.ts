// Shared channel-windowing math for the pattern views. The grid shows a frozen
// row-number gutter plus channel columns; rather than a free scroll with a
// half-cut column at the edge, we show only WHOLE channels and page through them
// (chevrons / swipe). The visible columns FLEX to fill the width (no empty
// leftover), between slim static edge dividers that hold the chevrons. Both
// PatternView (locked) and PatternViewScroll (free) use this so they match.

/** Row-number gutter width (px) — frozen at the left of both views. */
export const ROWNUM_W = 30;
/** Minimum channel column width (px) — decides how many whole channels fit. */
export const CELL_W = 130;
/** Cap on the flexed column width — columns expand to fill only up to a natural
 *  tracker width; beyond this they DON'T stretch (a few channels on a wide pane
 *  keep their size and the extra stays plain surface, rather than ballooning). */
export const MAX_CELL_W = 160;
/** Slim edge divider reserved on each side when paging (holds the chevron). */
export const EDGE_W = 22;

export type ChannelWindow = {
  /** How many whole channels are shown (≥1). */
  visible: number;
  /** Offset clamped into range for the current width/count. */
  offset: number;
  /** Largest valid offset (0 when everything fits). */
  maxOffset: number;
  /** Actual (flexed) column width, px — columns stretch to fill the window. */
  colW: number;
  /** Width of the visible-channels viewport (visible × colW), px. */
  windowW: number;
  /** Left / right edge-divider widths (0 when everything fits — no dividers). */
  leftEdgeW: number;
  rightEdgeW: number;
  /** More channels hidden to the left / right (shows that side's chevron). */
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
  minCell = CELL_W,
  gutterW = ROWNUM_W,
): ChannelWindow {
  const avail = Math.max(0, containerW - gutterW);
  const fits = count === 0 || count <= Math.floor(avail / minCell);

  let visible: number;
  let colW: number;
  let windowW: number;
  let leftEdgeW: number;
  let rightEdgeW: number;
  if (fits) {
    // All channels show; stretch them to fill (capped), no edge dividers.
    visible = Math.max(1, count);
    colW = count > 0 ? Math.min(MAX_CELL_W, Math.floor(avail / count)) : minCell;
    windowW = visible * colW;
    leftEdgeW = 0;
    rightEdgeW = 0;
  } else {
    // Paging: reserve a slim edge on each side, then flex the visible columns to
    // fill the space between them — so there's no empty leftover on the right.
    const usable = Math.max(0, avail - 2 * EDGE_W);
    visible = Math.max(1, Math.floor(usable / minCell));
    colW = Math.min(MAX_CELL_W, Math.floor(usable / visible));
    windowW = visible * colW;
    leftEdgeW = EDGE_W;
    rightEdgeW = Math.max(EDGE_W, avail - EDGE_W - windowW); // = EDGE_W unless colW is capped
  }

  const maxOffset = Math.max(0, count - visible);
  const off = Math.min(Math.max(0, offset), maxOffset);
  return {
    visible,
    offset: off,
    maxOffset,
    colW,
    windowW,
    leftEdgeW,
    rightEdgeW,
    canLeft: off > 0,
    canRight: off < maxOffset,
  };
}
