// Types for the generated maquette model (xwing.js is a verbatim artifact, kept
// out of prettier — see .prettierignore). draw() is a standalone canvas painter:
// software-projected, back-face-culled, painter-sorted triangles, centred in the
// given canvas.
export type Vec3 = [number, number, number];
export type Triangle = { p: [Vec3, Vec3, Vec3]; c: string };

export const triangles: Triangle[];

export function draw(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  opts?: {
    rotX?: number;
    rotY?: number;
    dist?: number;
    scale?: number;
    light?: [number, number, number];
  },
): void;
