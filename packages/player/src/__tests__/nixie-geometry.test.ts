// The nixie viz's geometry, which is pure arithmetic and therefore checkable
// without a GPU — the half of the old three.js scene that could only be verified
// by looking at it.
import { GLYPH_VIEWBOX, glyphPath, nixieCathodes } from "@glowbox/nixie";
import { describe, expect, test } from "vitest";

import {
  box,
  cylinder,
  hexGrille,
  lathe,
  mergeMeshes,
  type Mesh,
  pathToPolylines,
  tubeFromPolyline,
} from "../nixie-geometry";

/** Every index addresses a real vertex, and every normal is unit length. */
function expectWellFormed(m: Mesh) {
  const vertices = m.positions.length / 3;
  expect(m.normals.length).toBe(m.positions.length);
  expect(m.indices.length % 3).toBe(0);
  for (const i of m.indices) expect(i).toBeLessThan(vertices);
  for (let i = 0; i < vertices; i++) {
    const len = Math.hypot(m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2]);
    expect(len).toBeCloseTo(1, 4);
  }
  expect(Number.isFinite(m.positions.reduce((a, b) => a + b, 0))).toBe(true);
}

describe("pathToPolylines", () => {
  test("the glyph paths use only the grammar this parser implements", () => {
    // The parser is deliberately not a general SVG one. If a @glowbox/nixie bump
    // ever introduces relative commands or arcs, this fails rather than silently
    // dropping strokes off a numeral.
    const paths = [...nixieCathodes().map((c) => c.path), glyphPath(":") ?? ""];
    const used = new Set(paths.flatMap((d) => [...d.matchAll(/[A-Za-z]/g)].map((m) => m[0])));
    expect([...used].sort()).toEqual(["C", "L", "M", "Z"]);
  });

  test("a line splits into its points, a curve is flattened", () => {
    expect(pathToPolylines("M 0 0 L 10 0")).toEqual([
      [
        [0, 0],
        [10, 0],
      ],
    ]);
    const curved = pathToPolylines("M 0 0 C 0 10 10 10 10 0");
    expect(curved).toHaveLength(1);
    expect(curved[0].length).toBeGreaterThan(8);
    expect(curved[0][0]).toEqual([0, 0]);
    expect(curved[0][curved[0].length - 1]).toEqual([10, 0]);
  });

  test("each M starts a subpath and Z closes back to its start", () => {
    const subs = pathToPolylines("M 0 0 L 5 0 M 0 5 L 5 5 Z");
    expect(subs).toHaveLength(2);
    expect(subs[1][subs[1].length - 1]).toEqual([0, 5]);
  });

  test("every cathode yields at least one drawable stroke", () => {
    for (const c of nixieCathodes()) {
      const subs = pathToPolylines(c.path);
      expect(subs.length, `cathode ${c.symbol}`).toBeGreaterThan(0);
      for (const s of subs) expect(s.length).toBeGreaterThan(1);
    }
  });
});

describe("tubeFromPolyline", () => {
  test("a straight run becomes a closed tube of the requested radius", () => {
    const m = tubeFromPolyline(
      [
        [0, 0, 0],
        [0, 1, 0],
      ],
      0.1,
      6,
    )!;
    expect(m).toBeTruthy();
    expectWellFormed(m);
    expect(m.positions.length / 3).toBe(2 * 6);
    // Every vertex sits exactly `radius` from the centreline (the Y axis here).
    for (let i = 0; i < m.positions.length; i += 3) {
      expect(Math.hypot(m.positions[i], m.positions[i + 2])).toBeCloseTo(0.1, 5);
    }
  });

  test("a doubled point is dropped rather than left without a direction", () => {
    const m = tubeFromPolyline(
      [
        [0, 0, 0],
        [0, 0, 0],
        [0, 1, 0],
      ],
      0.1,
      6,
    )!;
    expect(m.positions.length / 3).toBe(2 * 6);
  });

  test("a degenerate polyline yields nothing instead of NaNs", () => {
    expect(tubeFromPolyline([[0, 0, 0]], 0.1)).toBeNull();
    expect(
      tubeFromPolyline(
        [
          [1, 1, 1],
          [1, 1, 1],
        ],
        0.1,
      ),
    ).toBeNull();
  });

  test("frames are transported, so a curve back on itself does not flip", () => {
    // A tight S-bend: with a Frenet frame the normal flips where the curvature
    // reverses, which twists the tube and creases its shading. Neighbouring rings
    // staying close together is what says that did not happen.
    const pts: [number, number, number][] = [];
    for (let i = 0; i <= 40; i++) {
      const t = (i / 40) * Math.PI * 2;
      pts.push([Math.sin(t), t * 0.2, 0]);
    }
    const m = tubeFromPolyline(pts, 0.05, 6)!;
    expectWellFormed(m);
    for (let ring = 1; ring < 41; ring++) {
      for (let j = 0; j < 6; j++) {
        const a = ((ring - 1) * 6 + j) * 3;
        const b = (ring * 6 + j) * 3;
        const step = Math.hypot(
          m.positions[b] - m.positions[a],
          m.positions[b + 1] - m.positions[a + 1],
          m.positions[b + 2] - m.positions[a + 2],
        );
        expect(step).toBeLessThan(0.5);
      }
    }
  });
});

describe("solids", () => {
  test("mergeMeshes offsets indices into the combined buffer", () => {
    const one = tubeFromPolyline(
      [
        [0, 0, 0],
        [0, 1, 0],
      ],
      0.1,
      6,
    )!;
    const merged = mergeMeshes([one, one])!;
    expect(merged.positions.length).toBe(one.positions.length * 2);
    expect(merged.indices.length).toBe(one.indices.length * 2);
    expectWellFormed(merged);
    expect(Math.max(...merged.indices)).toBeGreaterThanOrEqual(one.positions.length / 3);
  });

  test("mergeMeshes of nothing is null, not an empty mesh", () => {
    expect(mergeMeshes([])).toBeNull();
  });

  test("a lathe revolves its profile about Y", () => {
    const m = lathe(
      [
        [1, -1],
        [1, 1],
      ],
      8,
    );
    expectWellFormed(m);
    for (let i = 0; i < m.positions.length; i += 3) {
      expect(Math.hypot(m.positions[i], m.positions[i + 2])).toBeCloseTo(1, 5);
      expect(Math.abs(m.positions[i + 1])).toBeCloseTo(1, 5);
    }
  });

  test("a cylinder is capped at both ends", () => {
    const m = cylinder(1, 1, 2, 12);
    expectWellFormed(m);
    const ys = new Set<number>();
    for (let i = 1; i < m.positions.length; i += 3) ys.add(Math.round(m.positions[i] * 1000));
    expect(ys.has(1000)).toBe(true);
    expect(ys.has(-1000)).toBe(true);
    // Wall plus two caps: more triangles than the wall alone would need.
    expect(m.indices.length / 3).toBeGreaterThan(12 * 2);
  });

  test("a box has six faces of axis-aligned normals", () => {
    const m = box(2, 4, 6);
    expectWellFormed(m);
    expect(m.indices.length / 3).toBe(12);
    const normals = new Set<string>();
    for (let i = 0; i < m.normals.length; i += 3) {
      normals.add([m.normals[i], m.normals[i + 1], m.normals[i + 2]].join(","));
    }
    expect(normals.size).toBe(6);
    // Half-extents match the requested size.
    let mx = 0;
    let my = 0;
    let mz = 0;
    for (let i = 0; i < m.positions.length; i += 3) {
      mx = Math.max(mx, Math.abs(m.positions[i]));
      my = Math.max(my, Math.abs(m.positions[i + 1]));
      mz = Math.max(mz, Math.abs(m.positions[i + 2]));
    }
    expect([mx, my, mz]).toEqual([1, 2, 3]);
  });

  test("the grille is one pair of endpoints per hexagon edge", () => {
    const cells = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    const lines = hexGrille(cells, 5, (x, y) => [x, y, 0]);
    expect(lines.positions.length).toBe(2 * 6 * 2 * 3);
  });
});

describe("the glyphs as built", () => {
  test("every numeral extrudes into wire that fits its viewBox", () => {
    const scale = 0.01;
    const toWorld = (x: number, y: number): [number, number, number] => [
      (x - GLYPH_VIEWBOX.width / 2) * scale,
      -(y - GLYPH_VIEWBOX.height / 2) * scale,
      0,
    ];
    for (const c of nixieCathodes()) {
      const parts = pathToPolylines(c.path)
        .map((p) =>
          tubeFromPolyline(
            p.map(([x, y]) => toWorld(x, y)),
            0.02,
          ),
        )
        .filter((m): m is Mesh => !!m);
      const merged = mergeMeshes(parts);
      expect(merged, `cathode ${c.symbol}`).toBeTruthy();
      expectWellFormed(merged!);
      // Within the glyph box, allowing for the wire's own radius.
      for (let i = 0; i < merged!.positions.length; i += 3) {
        expect(Math.abs(merged!.positions[i])).toBeLessThan(
          (GLYPH_VIEWBOX.width / 2) * scale + 0.03,
        );
        expect(Math.abs(merged!.positions[i + 1])).toBeLessThan(
          (GLYPH_VIEWBOX.height / 2) * scale + 0.03,
        );
      }
    }
  });
});
