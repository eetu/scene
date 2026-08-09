// WebGL2 boilerplate for the object visualisers — the small slice of a 3D engine
// this app actually uses: a context, programs, indexed meshes, offscreen targets,
// a fullscreen triangle, and 4×4 matrices.
//
// Separate from ./gl (WebGL1, fullscreen-shader only) because these scenes draw
// real geometry with a depth buffer and post-process through framebuffers, which
// that helper deliberately does not do.

export type GL = WebGL2RenderingContext;

/** An uploaded mesh: a VAO plus the index count to draw. */
export type GpuMesh = { vao: WebGLVertexArrayObject; count: number; mode: number };

/** An offscreen colour target. Depth is optional — the post chain doesn't need it. */
export type Target = {
  fbo: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
  resize(width: number, height: number): void;
  destroy(): void;
};

/**
 * A WebGL2 context sized to the element.
 *
 * `preserveDrawingBuffer`: the CRT screen samples this canvas as a texture from
 * its own rAF, and Safari discards a drawing buffer as soon as it has composited
 * it — without this the screen reads an empty buffer and goes black there.
 */
export function createContext(
  canvas: HTMLCanvasElement,
  opts: { antialias?: boolean } = {},
): GL | null {
  const gl = canvas.getContext("webgl2", {
    antialias: opts.antialias ?? true,
    alpha: false,
    depth: true,
    preserveDrawingBuffer: true,
    powerPreference: "high-performance",
  });
  if (!gl) console.warn("nixie: WebGL2 unavailable");
  return gl;
}

export function createProgram(gl: GL, vert: string, frag: string, label: string) {
  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn(`${label} shader:`, gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  };
  const vs = compile(gl.VERTEX_SHADER, vert);
  const fs = compile(gl.FRAGMENT_SHADER, frag);
  if (!vs || !fs) return null;
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn(`${label} link:`, gl.getProgramInfoLog(prog));
    return null;
  }
  // Uniform locations are looked up once: `getUniformLocation` is a synchronous
  // driver call, and a per-frame lookup for every uniform of every object shows up
  // in a profile long before the draw calls do.
  const cache = new Map<string, WebGLUniformLocation | null>();
  return {
    prog,
    use: () => gl.useProgram(prog),
    loc: (name: string) => {
      if (!cache.has(name)) cache.set(name, gl.getUniformLocation(prog, name));
      return cache.get(name) ?? null;
    },
    destroy: () => gl.deleteProgram(prog),
  };
}

export type Program = NonNullable<ReturnType<typeof createProgram>>;

/** Upload an indexed position+normal mesh. Attribute 0 is position, 1 is normal. */
export function uploadMesh(
  gl: GL,
  mesh: { positions: Float32Array; normals: Float32Array; indices: Uint16Array },
): GpuMesh {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  bindAttrib(gl, 0, mesh.positions, 3);
  bindAttrib(gl, 1, mesh.normals, 3);
  const ibo = gl.createBuffer()!;
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, count: mesh.indices.length, mode: gl.TRIANGLES };
}

/** Upload unindexed line segments (positions only; attribute 0). */
export function uploadLines(gl: GL, lines: { positions: Float32Array }): GpuMesh {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  bindAttrib(gl, 0, lines.positions, 3);
  gl.bindVertexArray(null);
  return { vao, count: lines.positions.length / 3, mode: gl.LINES };
}

function bindAttrib(gl: GL, index: number, data: Float32Array, size: number) {
  const buf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(index);
  gl.vertexAttribPointer(index, size, gl.FLOAT, false, 0, 0);
}

export function drawMesh(gl: GL, m: GpuMesh) {
  gl.bindVertexArray(m.vao);
  if (m.mode === gl.LINES) gl.drawArrays(gl.LINES, 0, m.count);
  else gl.drawElements(m.mode, m.count, gl.UNSIGNED_SHORT, 0);
}

/**
 * An offscreen RGBA8 colour target.
 *
 * Deliberately 8-bit rather than a float target: a float framebuffer needs
 * `EXT_color_buffer_float`, and the bloom here thresholds before it blurs — so the
 * only thing the extra range would buy is a slightly softer knee on a highlight
 * that is already clipped to white.
 */
export function createTarget(gl: GL, width: number, height: number, depth = false): Target {
  const fbo = gl.createFramebuffer()!;
  const texture = gl.createTexture()!;
  let rbo: WebGLRenderbuffer | null = depth ? gl.createRenderbuffer() : null;

  const alloc = (w: number, h: number) => {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (rbo) {
      gl.bindRenderbuffer(gl.RENDERBUFFER, rbo);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rbo);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };
  alloc(width, height);

  const t: Target = {
    fbo,
    texture,
    width,
    height,
    resize(w, h) {
      if (w === t.width && h === t.height) return;
      t.width = w;
      t.height = h;
      alloc(w, h);
    },
    destroy() {
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(texture);
      if (rbo) gl.deleteRenderbuffer(rbo);
      rbo = null;
    },
  };
  return t;
}

/**
 * A multisampled colour+depth target that resolves into a plain [`Target`].
 *
 * The canvas's own `antialias` flag does nothing for a scene drawn into a
 * framebuffer, and this one is: the post chain needs the frame as a texture. Thin
 * geometry — and a nixie cathode is a wire a pixel or two across — crawls badly
 * without it, so the scene pass renders multisampled and is blitted down.
 */
export function createMsaaTarget(gl: GL, width: number, height: number, samples = 4) {
  const fbo = gl.createFramebuffer()!;
  const color = gl.createRenderbuffer()!;
  const depth = gl.createRenderbuffer()!;
  const limit = Math.min(samples, gl.getParameter(gl.MAX_SAMPLES) as number);
  let w = 0;
  let h = 0;

  const alloc = (nw: number, nh: number) => {
    w = nw;
    h = nh;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.bindRenderbuffer(gl.RENDERBUFFER, color);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, limit, gl.RGBA8, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, limit, gl.DEPTH_COMPONENT16, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };
  alloc(width, height);

  return {
    bind() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, w, h);
    },
    resize(nw: number, nh: number) {
      if (nw !== w || nh !== h) alloc(nw, nh);
    },
    /** Blit into `dst`, leaving nothing bound. */
    resolveTo(dst: Target) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fbo);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, dst.width, dst.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    },
    destroy() {
      gl.deleteFramebuffer(fbo);
      gl.deleteRenderbuffer(color);
      gl.deleteRenderbuffer(depth);
    },
  };
}

export type MsaaTarget = ReturnType<typeof createMsaaTarget>;

/** Bind a target (or the canvas, when null) and set the viewport to match. */
export function bindTarget(gl: GL, t: Target | null, canvasW = 0, canvasH = 0) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
  if (t) gl.viewport(0, 0, t.width, t.height);
  else gl.viewport(0, 0, canvasW, canvasH);
}

/** A VAO holding the single oversized triangle every post pass draws. */
export function createFullscreenTriangle(gl: GL): GpuMesh {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  bindAttrib(gl, 0, new Float32Array([-1, -1, 3, -1, -1, 3]), 2);
  gl.bindVertexArray(null);
  return { vao, count: 3, mode: gl.TRIANGLES };
}

export function drawFullscreen(gl: GL, tri: GpuMesh) {
  gl.bindVertexArray(tri.vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// ---------------------------------------------------------------------------
// Matrices — column-major, as GLSL expects.
// ---------------------------------------------------------------------------

export type Mat4 = Float32Array;

export const identity = (): Mat4 =>
  new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export function perspective(fovYRad: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovYRad / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (far + near) * nf,
    -1,
    0,
    0,
    2 * far * near * nf,
    0,
  ]);
}

export function lookAt(eye: number[], target: number[], up: number[]): Mat4 {
  const z = norm([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0],
    y[0],
    z[0],
    0,
    x[1],
    y[1],
    z[1],
    0,
    x[2],
    y[2],
    z[2],
    0,
    -dot(x, eye),
    -dot(y, eye),
    -dot(z, eye),
    1,
  ]);
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

/**
 * `rotateY(spin) · translate(at) · scale(by)` — a child placed inside a parent
 * that may be spinning. Note the order: the translation is rotated too, so an
 * object at x = 2 orbits rather than turning on the spot.
 */
export function compose(
  at: [number, number, number],
  by: [number, number, number] = [1, 1, 1],
  spin = 0,
): Mat4 {
  const c = Math.cos(spin);
  const s = Math.sin(spin);
  return new Float32Array([
    c * by[0],
    0,
    -s * by[0],
    0,
    0,
    by[1],
    0,
    0,
    s * by[2],
    0,
    c * by[2],
    0,
    c * at[0] + s * at[2],
    at[1],
    -s * at[0] + c * at[2],
    1,
  ]);
}

/**
 * The 3×3 inverse transpose of a model matrix, for normals.
 *
 * Needed because the cathode stack is squashed non-uniformly to convey the tube
 * style: under a non-uniform scale a normal transformed by the model matrix stops
 * being perpendicular to its surface, and the wires shade as though lit from
 * somewhere else.
 */
export function normalMatrix(m: Mat4): Float32Array {
  // Column-major in, column-major out: a, b, c is the first column of the 3×3
  // block, and so on.
  const a = m[0],
    b = m[1],
    c = m[2];
  const d = m[4],
    e = m[5],
    f = m[6];
  const g = m[8],
    h = m[9],
    i = m[10];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const k = 1 / det;
  // inverse(M)ᵀ is the cofactor matrix over the determinant — no separate
  // transpose step, since transposing the adjugate gives the cofactors back.
  return new Float32Array([
    (e * i - f * h) * k,
    (f * g - d * i) * k,
    (d * h - e * g) * k,
    (c * h - b * i) * k,
    (a * i - c * g) * k,
    (b * g - a * h) * k,
    (b * f - c * e) * k,
    (c * d - a * f) * k,
    (a * e - b * d) * k,
  ]);
}

const cross = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v: number[]) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
