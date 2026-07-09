// Minimal WebGL renderer for the precompiled X-wing geometry (xwing.geometry.ts).
// No three.js — a single Lambert program with a depth buffer, so the model draws
// glitch-free and LIVE: rotation, dolly (comes nearer on pause), and the baked
// emissive engine glow are all real 3D, driven per frame by the Starfield viz.
// Renders to its own transparent offscreen canvas which the caller composites.
import { xwing } from "./models/xwing.geometry";

export type ShipPose = {
  rotX: number; // pitch
  rotY: number; // yaw
  rotZ: number; // lengthwise roll (intrinsic — about the ship's fore-aft axis)
  dist: number; // camera distance (smaller = nearer/bigger)
  fov: number; // vertical field of view (radians)
  scale: number; // model scale (unit-radius geometry → ~1)
  engine: number; // 0..1 extra engine-glow intensity (pulses with the beat)
  light: [number, number, number]; // key-light direction (view space, will be normalized)
};

export type XwingRenderer = {
  canvas: HTMLCanvasElement;
  render: (pose: ShipPose) => void;
  dispose: () => void;
};

// --- tiny column-major mat4 -------------------------------------------------
type M4 = Float32Array;
const m4 = (): M4 => new Float32Array(16);
function ident(o: M4): M4 {
  o.fill(0);
  o[0] = o[5] = o[10] = o[15] = 1;
  return o;
}
function multiply(o: M4, a: M4, b: M4): M4 {
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}
function perspective(o: M4, fov: number, aspect: number, near: number, far: number): M4 {
  const f = 1 / Math.tan(fov / 2);
  o.fill(0);
  o[0] = f / aspect;
  o[5] = f;
  o[10] = (far + near) / (near - far);
  o[11] = -1;
  o[14] = (2 * far * near) / (near - far);
  return o;
}
// Single-axis rotations (column-major). render() composes them as Rx·Ry·Rz, so
// the Z-roll is INTRINSIC (innermost) — a roll about the model's own fore-aft
// (lengthwise) axis, not a flat screen-plane spin of the sprite.
function rotX(o: M4, a: number): M4 {
  ident(o);
  const c = Math.cos(a),
    s = Math.sin(a);
  o[5] = c;
  o[6] = s;
  o[9] = -s;
  o[10] = c;
  return o;
}
function rotY(o: M4, a: number): M4 {
  ident(o);
  const c = Math.cos(a),
    s = Math.sin(a);
  o[0] = c;
  o[2] = -s;
  o[8] = s;
  o[10] = c;
  return o;
}
function rotZ(o: M4, a: number): M4 {
  ident(o);
  const c = Math.cos(a),
    s = Math.sin(a);
  o[0] = c;
  o[1] = s;
  o[4] = -s;
  o[5] = c;
  return o;
}

const VERT = `
  attribute vec3 aPos;
  attribute vec3 aNormal;
  attribute vec3 aColor;
  attribute vec3 aEmissive;
  uniform mat4 uMVP;
  uniform mat4 uRot; // model+view rotation (for normals → view space)
  varying vec3 vNormal;
  varying vec3 vColor;
  varying vec3 vEmissive;
  void main() {
    vNormal = normalize((uRot * vec4(aNormal, 0.0)).xyz);
    vColor = aColor;
    vEmissive = aEmissive;
    gl_Position = uMVP * vec4(aPos, 1.0);
  }
`;
const FRAG = `
  precision highp float;
  varying vec3 vNormal;
  varying vec3 vColor;
  varying vec3 vEmissive;
  uniform vec3 uLight;   // normalized key-light direction (view space)
  uniform float uEngine; // extra engine-glow intensity
  void main() {
    vec3 N = normalize(vNormal);
    float diff = max(dot(N, uLight), 0.0);
    // Rim toward the camera so the silhouette reads against the nebula.
    float rim = pow(1.0 - max(N.z, 0.0), 2.5);
    vec3 col = vColor * (0.32 + 0.9 * diff) + vColor * rim * 0.35;
    col += vEmissive * (1.6 + 2.2 * uEngine); // baked engine exhaust, pulsing
    col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2)); // linear → sRGB for compositing
    gl_FragColor = vec4(col, 1.0);
  }
`;

/** Build a renderer that draws the X-wing to a `size`×`size` transparent canvas.
 *  Returns null if WebGL / program setup fails (caller falls back). */
export function createXwingRenderer(size: number): XwingRenderer | null {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const gl = canvas.getContext("webgl", { antialias: true, alpha: true, premultipliedAlpha: true });
  if (!gl) return null;

  function compile(type: number, src: string): WebGLShader | null {
    const sh = gl!.createShader(type);
    if (!sh) return null;
    gl!.shaderSource(sh, src);
    gl!.compileShader(sh);
    if (!gl!.getShaderParameter(sh, gl!.COMPILE_STATUS)) {
      console.warn("xwing shader:", gl!.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  }
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn("xwing link:", gl.getProgramInfoLog(prog));
    return null;
  }
  gl.useProgram(prog);

  // Resolve per-vertex color + emissive from the material table (once).
  const n = xwing.vertexCount;
  const colors = new Float32Array(n * 3);
  const emissive = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const mat = xwing.materials[xwing.matIds[v]] ?? { color: [0.8, 0.8, 0.8], emissive: [0, 0, 0] };
    colors[v * 3] = mat.color[0];
    colors[v * 3 + 1] = mat.color[1];
    colors[v * 3 + 2] = mat.color[2];
    emissive[v * 3] = mat.emissive[0];
    emissive[v * 3 + 1] = mat.emissive[1];
    emissive[v * 3 + 2] = mat.emissive[2];
  }

  function attrib(name: string, data: Float32Array, sizePer: number) {
    const buf = gl!.createBuffer();
    gl!.bindBuffer(gl!.ARRAY_BUFFER, buf);
    gl!.bufferData(gl!.ARRAY_BUFFER, data, gl!.STATIC_DRAW);
    const loc = gl!.getAttribLocation(prog!, name);
    gl!.enableVertexAttribArray(loc);
    gl!.vertexAttribPointer(loc, sizePer, gl!.FLOAT, false, 0, 0);
    return buf;
  }
  const bufs = [
    attrib("aPos", xwing.positions, 3),
    attrib("aNormal", xwing.normals, 3),
    attrib("aColor", colors, 3),
    attrib("aEmissive", emissive, 3),
  ];
  const idxBuf = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, xwing.indices, gl.STATIC_DRAW);
  const idxType = xwing.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
  if (idxType === gl.UNSIGNED_INT) gl.getExtension("OES_element_index_uint");

  const uMVP = gl.getUniformLocation(prog, "uMVP");
  const uRot = gl.getUniformLocation(prog, "uRot");
  const uLight = gl.getUniformLocation(prog, "uLight");
  const uEngine = gl.getUniformLocation(prog, "uEngine");

  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);

  const proj = m4();
  const view = m4();
  const model = m4();
  const rot = m4();
  const rxM = m4();
  const ryM = m4();
  const rzM = m4();
  const tmp = m4();
  const vm = m4();
  const mvp = m4();

  function render(pose: ShipPose) {
    const g = gl!;
    g.viewport(0, 0, size, size);
    g.clearColor(0, 0, 0, 0);
    g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT);

    // rot = Rx · Ry · Rz  → Rz innermost = intrinsic lengthwise roll (about the
    // fuselage), then yaw, then pitch.
    rotX(rxM, pose.rotX);
    rotY(ryM, pose.rotY);
    rotZ(rzM, pose.rotZ);
    multiply(tmp, ryM, rzM);
    multiply(rot, rxM, tmp);
    // model = rot * scale
    ident(model);
    model[0] = model[5] = model[10] = pose.scale;
    multiply(model, rot, model); // rotate the scaled unit model
    // view = translate(0,0,-dist)
    ident(view);
    view[14] = -pose.dist;
    // Tight near/far bracketing the model (radius ≈ 1) → maximal depth-buffer
    // precision, so the telephoto lens sorts triangles cleanly with no z-fighting.
    perspective(proj, pose.fov, 1, Math.max(0.1, pose.dist - 2), pose.dist + 2);
    multiply(vm, view, model);
    multiply(mvp, proj, vm);

    g.uniformMatrix4fv(uMVP, false, mvp);
    g.uniformMatrix4fv(uRot, false, rot); // view has no rotation, so rot alone maps normals to view space
    const l = pose.light;
    const ln = Math.hypot(l[0], l[1], l[2]) || 1;
    g.uniform3f(uLight, l[0] / ln, l[1] / ln, l[2] / ln);
    g.uniform1f(uEngine, pose.engine);
    g.drawElements(g.TRIANGLES, xwing.indexCount, idxType, 0);
  }

  function dispose() {
    const g = gl!;
    for (const b of bufs) g.deleteBuffer(b);
    g.deleteBuffer(idxBuf);
    g.deleteProgram(prog);
    g.deleteShader(vs);
    g.deleteShader(fs);
    g.getExtension("WEBGL_lose_context")?.loseContext();
  }

  return { canvas, render, dispose };
}
