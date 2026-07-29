// Field arithmetic for the queue face. Pure, so it can be checked without a canvas —
// the failure mode here is a title running into the status column or a clock that
// doesn't fit its drum, and both are arithmetic.
import { expect, test } from "vitest";

import type { Track } from "../host";
import {
  boardName,
  clock,
  departureLines,
  departureRows,
  ST_PLAYING,
  ST_QUEUED,
  STATUS_W,
  TIME_W,
  titleSpan,
} from "../departures";

const track = (over: Partial<Track> = {}): Track => ({
  hash: "h",
  filename: "song.it",
  ...over,
});

test("the clock always fills exactly the time field", () => {
  for (const sec of [0, 1, 59, 60, 61, 599, 3599, 3600, 5999, 99 * 60 + 59, 1e9]) {
    expect(clock(sec), `${sec}s`).toHaveLength(TIME_W);
  }
  // Absent or nonsense durations still occupy the field rather than collapsing it —
  // a short line would shift every column after it.
  for (const bad of [null, undefined, NaN, -1, Infinity]) {
    expect(clock(bad as number), String(bad)).toHaveLength(TIME_W);
  }
  expect(clock(61)).toBe("01:01");
  // Clamped, not wrapped: a 100-minute module should read as long, not as 40 minutes.
  expect(clock(100 * 60)).toBe("99:00");
});

test("fields never collide, at any board width", () => {
  for (const cols of [12, 16, 20, 27, 32, 48]) {
    const { x, w } = titleSpan(cols);
    expect(x, `${cols}: title starts inside the time field`).toBeGreaterThanOrEqual(TIME_W);
    expect(w, `${cols}: title has no width`).toBeGreaterThan(0);
    expect(x + w, `${cols}: title runs into the status column`).toBeLessThanOrEqual(
      cols - STATUS_W,
    );

    const rows = departureRows([track({ title: "A".repeat(80), duration: 61 })], cols, 3, 0);
    for (const line of departureLines(rows, cols)) {
      expect(line.length, `${cols}: line overflows the board`).toBeLessThanOrEqual(cols);
    }
  }
});

test("the top row is the one playing, and it is the one that ticks", () => {
  const list = [
    track({ title: "First", duration: 200 }),
    track({ title: "Second", duration: 100 }),
  ];
  const rows = departureRows(list, 27, 4, 42);
  expect(rows[0].status).toBe(ST_PLAYING);
  expect(rows[1].status).toBe(ST_QUEUED);
  // Row 0 shows elapsed, the rest their own duration — so exactly one field moves.
  expect(rows[0].time).toBe(clock(42));
  expect(rows[1].time).toBe(clock(100));
  // Empty slots stay blank rather than repeating the last track.
  expect(rows[2].title).toBe("");
  expect(rows[2].status).toBe(" ");
});

test("a name always survives to the board", () => {
  expect(boardName(track({ title: "Crystal Surface" }))).toBe("CRYSTAL SURFACE");
  // No title: the filename, with the module extension taken off.
  expect(boardName(track({ title: null, filename: "crystal surface.xm" }))).toBe("CRYSTAL SURFACE");
  // Nothing usable at all still yields something rather than an empty row.
  expect(boardName(track({ title: "", filename: "" }))).toBe("UNTITLED");
});

test("rows fill the board minus its header", () => {
  const many = Array.from({ length: 20 }, (_, i) => track({ title: `T${i}` }));
  for (const rows of [3, 6, 10]) {
    expect(departureRows(many, 27, rows, 0)).toHaveLength(rows - 1);
  }
});
