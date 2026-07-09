// Author-time X-wing geometry extractor (run when data/model.glb changes).
//
//   node packages/player/scripts/gen-xwing.mjs
//
// Precompiles a glTF-binary (.glb) into ONE compact, bundle-ready geometry:
// every mesh baked into world space, merged, and keyed by a material table
// (linear baseColor + emissive). Emits packages/player/src/models/
// xwing.geometry.ts (base64 typed arrays — no runtime fetch, no three.js in the
// bundle). The runtime draws it with the tiny WebGL renderer in xwing-render.ts,
// so we get a real 3D model (engine glow, dolly, true rotation) for a few KB.
//
// Parsing is delegated to glTF-Transform (a DEV dependency, never bundled), so
// any re-export is handled robustly: KHR_mesh_quantization, EXT_meshopt_compression,
// Draco, KHR_materials_emissive_strength, interleaving, sparse accessors — the SDK
// decompresses + dequantizes and getWorldMatrix() bakes the node hierarchy.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dequantize } from "@gltf-transform/functions";
import { MeshoptDecoder } from "meshoptimizer";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const GLB = resolve(here, "../../../data/model.glb");
const OUT = resolve(here, "../src/models/xwing.geometry.ts");

// --- load + normalize (decompress meshopt/draco, then float-ify quantized) --
await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
const doc = await io.read(GLB);
await doc.transform(dequantize()); // KHR_mesh_quantization → plain float attributes
const root = doc.getRoot();

// Transform a world-matrix (column-major mat4) over a point / a direction.
const apply = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];
function applyDir(m, x, y, z) {
  const r = [
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z,
  ];
  const l = Math.hypot(r[0], r[1], r[2]) || 1;
  return [r[0] / l, r[1] / l, r[2] / l];
}

// --- material table (linear baseColor + emissive), deduped by Material -------
const materials = [];
const matIndex = new Map();
function materialId(mat) {
  if (!mat) {
    if (!matIndex.has(null)) {
      matIndex.set(null, materials.length);
      materials.push({ color: [0.8, 0.8, 0.8], emissive: [0, 0, 0] });
    }
    return matIndex.get(null);
  }
  if (matIndex.has(mat)) return matIndex.get(mat);
  const c = mat.getBaseColorFactor(); // [r,g,b,a] linear
  const e = mat.getEmissiveFactor(); // [r,g,b] linear
  const es = mat.getExtension("KHR_materials_emissive_strength")?.getEmissiveStrength() ?? 1;
  const round = (x) => Math.round(x * 1000) / 1000;
  const id = materials.length;
  matIndex.set(mat, id);
  materials.push({
    color: [round(c[0]), round(c[1]), round(c[2])],
    emissive: [round(e[0] * es), round(e[1] * es), round(e[2] * es)],
  });
  return id;
}

// --- bake every mesh instance into one merged, world-space geometry ---------
const positions = [];
const normals = [];
const matIds = [];
const indices = [];
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const world = node.getWorldMatrix(); // accounts for the full parent chain
  for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== 4) continue; // TRIANGLES only
    const pos = prim.getAttribute("POSITION")?.getArray();
    if (!pos) continue;
    const nrm = prim.getAttribute("NORMAL")?.getArray();
    const idxAcc = prim.getIndices();
    const count = pos.length / 3;
    const base = positions.length / 3;
    const mat = materialId(prim.getMaterial());
    for (let v = 0; v < count; v++) {
      const p = apply(world, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
      const d = nrm ? applyDir(world, nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]) : [0, 1, 0];
      positions.push(p[0], p[1], p[2]);
      normals.push(d[0], d[1], d[2]);
      matIds.push(mat);
    }
    if (idxAcc) {
      const idx = idxAcc.getArray();
      for (let k = 0; k < idx.length; k++) indices.push(base + idx[k]);
    } else {
      for (let k = 0; k < count; k++) indices.push(base + k);
    }
  }
}

// --- center at the bbox midpoint, scale to unit radius ----------------------
const lo = [Infinity, Infinity, Infinity];
const hi = [-Infinity, -Infinity, -Infinity];
for (let v = 0; v < positions.length / 3; v++)
  for (let a = 0; a < 3; a++) {
    lo[a] = Math.min(lo[a], positions[v * 3 + a]);
    hi[a] = Math.max(hi[a], positions[v * 3 + a]);
  }
const mid = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
let radius = 0;
for (let v = 0; v < positions.length / 3; v++) {
  const dx = positions[v * 3] - mid[0],
    dy = positions[v * 3 + 1] - mid[1],
    dz = positions[v * 3 + 2] - mid[2];
  radius = Math.max(radius, Math.hypot(dx, dy, dz));
}
for (let v = 0; v < positions.length / 3; v++)
  for (let a = 0; a < 3; a++) positions[v * 3 + a] = (positions[v * 3 + a] - mid[a]) / radius;

// --- emit .ts (base64 typed arrays; decoded on import) ----------------------
const b64 = (typed) =>
  Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString("base64");
const posArr = new Float32Array(positions);
const nrmArr = new Float32Array(normals);
const matArr = new Uint8Array(matIds);
const idxArr = positions.length / 3 > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
const idxKind = idxArr instanceof Uint32Array ? "Uint32Array" : "Uint16Array";

const ts = `// GENERATED by scripts/gen-xwing.mjs from data/model.glb — do not edit by hand.
// A precompiled, bundle-ready X-wing: every glb mesh baked into world space and
// merged, keyed by a material table (linear RGB + emissive). Drawn by the tiny
// WebGL renderer in xwing-render.ts. Regenerate after re-exporting the model.
/* eslint-disable */
const d = (s: string, C: any) => {
  const b = atob(s);
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return new C(u.buffer);
};
export type XwingMaterial = { color: [number, number, number]; emissive: [number, number, number] };
export const xwing = {
  vertexCount: ${posArr.length / 3},
  indexCount: ${idxArr.length},
  positions: d("${b64(posArr)}", Float32Array) as Float32Array,
  normals: d("${b64(nrmArr)}", Float32Array) as Float32Array,
  matIds: d("${b64(matArr)}", Uint8Array) as Uint8Array,
  indices: d("${b64(idxArr)}", ${idxKind}) as ${idxKind},
  materials: ${JSON.stringify(materials)} as XwingMaterial[],
};
`;
writeFileSync(OUT, ts);
console.log(
  `xwing.geometry.ts: ${posArr.length / 3} verts, ${idxArr.length / 3} tris, ${materials.length} materials, ${idxKind}, ~${Math.round(ts.length / 1024)}KB`,
);
