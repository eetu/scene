// Shared channel-windowing math for the pattern views. The grid shows a frozen
// row-number gutter plus fixed-width channel columns; rather than a free scroll
// with a half-cut column at the edge, we show only WHOLE channels that fit and
// page through them one at a time (chevrons / swipe). When paging is needed, a
// static edge divider frames the channels on BOTH sides (each holds its chevron
// when there are hidden channels that way). Both PatternView (locked) and
// PatternViewScroll (free) use this so they behave identically.

/** Row-number gutter width (px) — frozen at the left of both views. */
export const ROWNUM_W = 30;
/** Fixed channel column width (px) — one whole channel steps the window by this. */
export const CELL_W = 130;
/** Right edge-divider MINIMUM reserve when paging — holds the › chevron; the
 *  right edge grows past this to absorb the truncation remainder (so a whole
 *  column is never cut). */
export const PAGER_W = 24;
/** Left edge divider — a slim fixed frame, just wide enough for the ‹ chevron. */
export const LEFT_EDGE_W = 24;

export type ChannelWindow = {
  /** How many whole channels fit between the two edge dividers (≥1). */
  visible: number;
  /** Offset clamped into range for the current width/count. */
  offset: number;
  /** Largest valid offset (0 when everything fits). */
  maxOffset: number;
  /** Width of the visible-channels viewport (visible × CELL_W), px. */
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
  cellW = CELL_W,
  gutterW = ROWNUM_W,
): ChannelWindow {
  const avail = Math.max(0, containerW - gutterW);
  // Everything fits (or nothing to show) → no paging, no edge dividers.
  const fits = count === 0 || count <= Math.floor(avail / cellW);

  let visible: number;
  let windowW: number;
  let leftEdgeW: number;
  let rightEdgeW: number;
  if (fits) {
    visible = Math.max(1, count);
    windowW = count * cellW;
    leftEdgeW = 0;
    rightEdgeW = 0;
  } else {
    // Reserve a divider on BOTH sides so the frame is static as you page: a slim
    // left edge (just the chevron) + a wider right edge that absorbs the
    // truncation remainder too.
    const usable = Math.max(0, avail - LEFT_EDGE_W - PAGER_W);
    visible = Math.max(1, Math.floor(usable / cellW));
    windowW = visible * cellW;
    leftEdgeW = LEFT_EDGE_W;
    rightEdgeW = Math.max(0, avail - leftEdgeW - windowW); // ≥ PAGER_W in practice
  }

  const maxOffset = Math.max(0, count - visible);
  const off = Math.min(Math.max(0, offset), maxOffset);
  return {
    visible,
    offset: off,
    maxOffset,
    windowW,
    leftEdgeW,
    rightEdgeW,
    canLeft: off > 0,
    canRight: off < maxOffset,
  };
}
