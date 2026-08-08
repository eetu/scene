// Fullscreen-triangle WebGL boilerplate shared by the raw-shader visualisers
// (Plasma, Tunnel, DiscoBall): context, compiled+linked program, the
// big-triangle VBO, and a ResizeObserver keeping the drawing buffer + viewport
// matched to the element.

export type QuadProgram = {
  gl: WebGLRenderingContext;
  prog: WebGLProgram;
  /** Disconnects the observer, frees the GL objects and loses the context. */
  destroy: () => void;
};

export function createQuadProgram(
  el: HTMLCanvasElement,
  opts: {
    /** console.warn prefix, so a failure names its visualiser. */
    label: string;
    vert: string;
    frag: string;
    antialias: boolean;
    /** WebGL1 extensions to enable before compiling (e.g. OES_standard_derivatives). */
    extensions?: string[];
  },
): QuadProgram | null {
  // preserveDrawingBuffer: the CRT screen samples this canvas as a texture from its own
  // rAF, and Safari discards a drawing buffer as soon as it has composited it — so
  // without this the screen reads an empty buffer and the tube goes black there (Chrome
  // happens to keep it around, which is why it only showed up on Safari). Costs the
  // driver some freedom to discard, which is the price of being compositable.
  const ctx = el.getContext("webgl", {
    antialias: opts.antialias,
    alpha: false,
    preserveDrawingBuffer: true,
  });
  if (!ctx) {
    console.warn(`${opts.label}: WebGL unavailable`);
    return null;
  }
  const gl: WebGLRenderingContext = ctx;
  for (const name of opts.extensions ?? []) gl.getExtension(name);

  function compile(type: number, src: string): WebGLShader | null {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn(`${opts.label} shader:`, gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }
  const vs = compile(gl.VERTEX_SHADER, opts.vert);
  const fs = compile(gl.FRAGMENT_SHADER, opts.frag);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn(`${opts.label} link:`, gl.getProgramInfoLog(prog));
    return null;
  }
  gl.useProgram(prog);

  // One big triangle covering the viewport — no per-frame geometry.
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  // Cap the backing resolution at 1.5× rather than the full 2× retina: these are
  // smooth-gradient shaders, so 1.5× is visually identical for ~44% fewer
  // fragment-shader invocations per frame (the main heat lever).
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const ro = new ResizeObserver(() => {
    const rect = el.getBoundingClientRect();
    el.width = Math.max(1, Math.round(rect.width * dpr));
    el.height = Math.max(1, Math.round(rect.height * dpr));
    gl.viewport(0, 0, el.width, el.height);
  });
  ro.observe(el);

  return {
    gl,
    prog,
    destroy() {
      ro.disconnect();
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
