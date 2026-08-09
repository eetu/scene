// Geometry for the nixie viz, built from @glowbox/nixie's 2D data.
//
// This is the half of the old three.js scene that was pure maths: SVGLoader +
// CatmullRomCurve3 + TubeGeometry + LatheGeometry + CylinderGeometry +
// mergeGeometries. All of it is a few hundred lines of arithmetic, and none of it
// needs a renderer — so it lives here as pure functions over plain arrays, which
// also makes it the only part of the viz a node test can check.
//
// Everything is indexed triangles with positions + normals. No UVs: nothing in
// this scene is textured.

/** An indexed triangle mesh, ready to upload. */
export type Mesh = {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint16Array;
};

/** Unindexed line segments (the anode grille). Pairs of endpoints. */
export type Lines = { positions: Float32Array };

type V3 = [number, number, number];

// ---------------------------------------------------------------------------
// SVG path → polylines
// ---------------------------------------------------------------------------

/** Curve flattening: segments per cubic. The glyphs are ~2cm tall on screen, so
 *  16 is already past the point where more shows. */
const CUBIC_STEPS = 16;

/**
 * Flatten an SVG path into polylines, one per subpath.
 *
 * Deliberately not a general SVG parser: `@glowbox/nixie`'s glyphs use absolute
 * `M`/`L`/`C`/`Z` and nothing else (asserted in the unit tests), which is a
 * grammar small enough to read in one sitting. A closed subpath (`Z`) repeats its
 * first point so the caller can treat every subpath as an open polyline.
 */
export function pathToPolylines(d: string): [number, number][][] {
  const out: [number, number][][] = [];
  let cur: [number, number][] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;

  // Commands and numbers, in order. Numbers may be separated by spaces or commas
  // and may carry a sign or a decimal point.
  const tokens = d.match(/[MLCZmlcz]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  let i = 0;
  const num = () => Number(tokens[i++]);
  const flush = () => {
    if (cur.length > 1) out.push(cur);
    cur = [];
  };

  while (i < tokens.length) {
    const cmd = tokens[i++];
    switch (cmd) {
      case "M":
        flush();
        x = num();
        y = num();
        startX = x;
        startY = y;
        cur = [[x, y]];
        break;
      case "L":
        x = num();
        y = num();
        cur.push([x, y]);
        break;
      case "C": {
        const x1 = num();
        const y1 = num();
        const x2 = num();
        const y2 = num();
        const x3 = num();
        const y3 = num();
        for (let s = 1; s <= CUBIC_STEPS; s++) {
          const t = s / CUBIC_STEPS;
          const u = 1 - t;
          cur.push([
            u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
            u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
          ]);
        }
        x = x3;
        y = y3;
        break;
      }
      case "Z":
      case "z":
        if (cur.length) cur.push([startX, startY]);
        x = startX;
        y = startY;
        flush();
        break;
      default:
        // A command outside the grammar: skip it rather than mis-read its
        // arguments as the next command.
        break;
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Polyline → tube
// ---------------------------------------------------------------------------

/** Drop points closer than this (glyph units) — a flattened curve meeting a line
 *  can leave a duplicate, and a zero-length segment has no direction to frame. */
const MIN_SEG = 1e-4;

function dedupe(points: V3[]): V3[] {
  const out: V3[] = [];
  for (const p of points) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > MIN_SEG) out.push(p);
  }
  return out;
}

/**
 * Sweep a ring of `radial` vertices along `points` to make a tube of `radius`.
 *
 * Frames are parallel-transported rather than derived from a fixed up-vector:
 * a Frenet frame flips where a curve's curvature reverses (every numeral has such
 * a point), which twists the tube and creases the shading. Carrying the previous
 * frame forward and re-orthogonalising it cannot flip.
 *
 * Ends are left open, as the three.js `TubeGeometry` this replaces left them: the
 * wires are thinner than a pixel's worth of dark at the tube ends.
 */
export function tubeFromPolyline(points: V3[], radius: number, radial = 6): Mesh | null {
  const pts = dedupe(points);
  if (pts.length < 2) return null;

  const n = pts.length;
  const tangents: V3[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const t: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(t[0], t[1], t[2]) || 1;
    tangents.push([t[0] / len, t[1] / len, t[2] / len]);
  }

  // Seed the first frame from whichever axis is least parallel to the tangent.
  const t0 = tangents[0];
  const seed: V3 = Math.abs(t0[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let normal = orthonormal(seed, t0);
  let binormal = cross(t0, normal);

  const positions = new Float32Array(n * radial * 3);
  const normals = new Float32Array(n * radial * 3);
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      // Transport: project the previous normal onto the new tangent's plane.
      normal = orthonormal(normal, tangents[i]);
      binormal = cross(tangents[i], normal);
    }
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const cosA = Math.cos(a);
      const sinA = Math.sin(a);
      const nx = cosA * normal[0] + sinA * binormal[0];
      const ny = cosA * normal[1] + sinA * binormal[1];
      const nz = cosA * normal[2] + sinA * binormal[2];
      const o = (i * radial + j) * 3;
      positions[o] = pts[i][0] + nx * radius;
      positions[o + 1] = pts[i][1] + ny * radius;
      positions[o + 2] = pts[i][2] + nz * radius;
      normals[o] = nx;
      normals[o + 1] = ny;
      normals[o + 2] = nz;
    }
  }

  const indices = new Uint16Array((n - 1) * radial * 6);
  let k = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      const c = (i + 1) * radial + j;
      const dd = (i + 1) * radial + ((j + 1) % radial);
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = dd;
    }
  }
  return { positions, normals, indices };
}

/** Concatenate meshes into one buffer set, offsetting each one's indices. */
export function mergeMeshes(parts: Mesh[]): Mesh | null {
  const kept = parts.filter((p) => p.indices.length > 0);
  if (!kept.length) return null;
  const vCount = kept.reduce((a, p) => a + p.positions.length, 0);
  const iCount = kept.reduce((a, p) => a + p.indices.length, 0);
  const positions = new Float32Array(vCount);
  const normals = new Float32Array(vCount);
  const indices = new Uint16Array(iCount);
  let vo = 0;
  let io = 0;
  for (const p of kept) {
    positions.set(p.positions, vo);
    normals.set(p.normals, vo);
    for (let i = 0; i < p.indices.length; i++) indices[io + i] = p.indices[i] + vo / 3;
    vo += p.positions.length;
    io += p.indices.length;
  }
  return { positions, normals, indices };
}

// ---------------------------------------------------------------------------
// Solids of revolution + boxes
// ---------------------------------------------------------------------------

/**
 * Revolve a profile (x = radius, y = height) about the Y axis.
 *
 * The glass envelope is one such surface — straight wall into a domed top, open
 * at the bottom where the metal base sits — so the whole tube is a single skin
 * with no seam for the shading to catch on.
 */
export function lathe(profile: [number, number][], radial: number): Mesh {
  const rows = profile.length;
  const cols = radial + 1; // duplicate seam column, so the ring closes exactly
  const positions = new Float32Array(rows * cols * 3);
  const normals = new Float32Array(rows * cols * 3);

  for (let r = 0; r < rows; r++) {
    // Profile normal: the segment tangent turned 90°, pointing outwards.
    const prev = profile[Math.max(0, r - 1)];
    const next = profile[Math.min(rows - 1, r + 1)];
    const tx = next[0] - prev[0];
    const ty = next[1] - prev[1];
    const tl = Math.hypot(tx, ty) || 1;
    const pnx = ty / tl;
    const pny = -tx / tl;
    for (let c = 0; c < cols; c++) {
      const a = (c / radial) * Math.PI * 2;
      const cosA = Math.cos(a);
      const sinA = Math.sin(a);
      const o = (r * cols + c) * 3;
      positions[o] = profile[r][0] * cosA;
      positions[o + 1] = profile[r][1];
      positions[o + 2] = profile[r][0] * sinA;
      normals[o] = pnx * cosA;
      normals[o + 1] = pny;
      normals[o + 2] = pnx * sinA;
    }
  }

  const indices = new Uint16Array((rows - 1) * radial * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < radial; c++) {
      const a = r * cols + c;
      const b = r * cols + c + 1;
      const cc = (r + 1) * cols + c;
      const d = (r + 1) * cols + c + 1;
      indices[k++] = a;
      indices[k++] = cc;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = cc;
      indices[k++] = d;
    }
  }
  return { positions, normals, indices };
}

/** A capped cylinder (the tube's metal base), centred on the origin. */
export function cylinder(rTop: number, rBottom: number, height: number, radial: number): Mesh {
  const h = height / 2;
  const wall = lathe(
    [
      [rBottom, -h],
      [rTop, h],
    ],
    radial,
  );
  return mergeMeshes([wall, disc(rTop, h, 1, radial), disc(rBottom, -h, -1, radial)]) ?? wall;
}

/** A flat disc at height `y`, facing `dir` (+1 up, -1 down). */
function disc(radius: number, y: number, dir: 1 | -1, radial: number): Mesh {
  const positions = new Float32Array((radial + 1) * 3);
  const normals = new Float32Array((radial + 1) * 3);
  normals[1] = dir;
  positions[1] = y;
  for (let c = 0; c < radial; c++) {
    const a = (c / radial) * Math.PI * 2;
    const o = (c + 1) * 3;
    positions[o] = Math.cos(a) * radius;
    positions[o + 1] = y;
    positions[o + 2] = Math.sin(a) * radius;
    normals[o + 1] = dir;
  }
  const indices = new Uint16Array(radial * 3);
  for (let c = 0; c < radial; c++) {
    const i = c * 3;
    indices[i] = 0;
    // Winding follows the facing, so back-face culling keeps both caps.
    indices[i + 1] = dir > 0 ? c + 1 : ((c + 1) % radial) + 1;
    indices[i + 2] = dir > 0 ? ((c + 1) % radial) + 1 : c + 1;
  }
  return { positions, normals, indices };
}

/** An axis-aligned box (the stand), centred on the origin. */
export function box(w: number, h: number, d: number): Mesh {
  const x = w / 2;
  const y = h / 2;
  const z = d / 2;
  const faces: [V3, V3, V3][] = [
    // [origin corner, edge u, edge v] per face, wound counter-clockwise from outside.
    [
      [-x, -y, z],
      [2 * x, 0, 0],
      [0, 2 * y, 0],
    ], // +Z
    [
      [x, -y, -z],
      [-2 * x, 0, 0],
      [0, 2 * y, 0],
    ], // -Z
    [
      [x, -y, z],
      [0, 0, -2 * z],
      [0, 2 * y, 0],
    ], // +X
    [
      [-x, -y, -z],
      [0, 0, 2 * z],
      [0, 2 * y, 0],
    ], // -X
    [
      [-x, y, z],
      [2 * x, 0, 0],
      [0, 0, -2 * z],
    ], // +Y
    [
      [-x, -y, -z],
      [2 * x, 0, 0],
      [0, 0, 2 * z],
    ], // -Y
  ];
  const positions = new Float32Array(6 * 4 * 3);
  const normals = new Float32Array(6 * 4 * 3);
  const indices = new Uint16Array(6 * 6);
  faces.forEach(([o, u, v], f) => {
    const n = normalise(cross(u, v));
    const corners: V3[] = [
      o,
      [o[0] + u[0], o[1] + u[1], o[2] + u[2]],
      [o[0] + u[0] + v[0], o[1] + u[1] + v[1], o[2] + u[2] + v[2]],
      [o[0] + v[0], o[1] + v[1], o[2] + v[2]],
    ];
    corners.forEach((c, i) => {
      const at = (f * 4 + i) * 3;
      positions[at] = c[0];
      positions[at + 1] = c[1];
      positions[at + 2] = c[2];
      normals[at] = n[0];
      normals[at + 1] = n[1];
      normals[at + 2] = n[2];
    });
    const b = f * 4;
    const i = f * 6;
    indices[i] = b;
    indices[i + 1] = b + 1;
    indices[i + 2] = b + 2;
    indices[i + 3] = b;
    indices[i + 4] = b + 2;
    indices[i + 5] = b + 3;
  });
  return { positions, normals, indices };
}

/** The honeycomb anode grille, as line segments in the plane z = 0. */
export function hexGrille(
  cells: { x: number; y: number }[],
  radius: number,
  toWorld: (x: number, y: number) => [number, number, number],
): Lines {
  const positions = new Float32Array(cells.length * 6 * 2 * 3);
  let k = 0;
  for (const c of cells) {
    const verts: V3[] = [];
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 6 + (i * Math.PI) / 3;
      verts.push(toWorld(c.x + radius * Math.cos(a), c.y + radius * Math.sin(a)));
    }
    for (let i = 0; i < 6; i++) {
      const p0 = verts[i];
      const p1 = verts[(i + 1) % 6];
      positions[k++] = p0[0];
      positions[k++] = p0[1];
      positions[k++] = p0[2];
      positions[k++] = p1[0];
      positions[k++] = p1[1];
      positions[k++] = p1[2];
    }
  }
  return { positions };
}

// ---------------------------------------------------------------------------

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalise(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** The part of `v` perpendicular to `axis`, normalised. */
function orthonormal(v: V3, axis: V3): V3 {
  const d = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
  const p: V3 = [v[0] - axis[0] * d, v[1] - axis[1] * d, v[2] - axis[2] * d];
  const l = Math.hypot(p[0], p[1], p[2]);
  // Degenerate only if `v` is parallel to the axis; any perpendicular will do.
  if (l < 1e-6) return normalise(cross(axis, Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  return [p[0] / l, p[1] / l, p[2] / l];
}
