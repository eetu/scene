// Renders a fragment shader to a canvas so a test can screenshot it. Lives in a
// plain .ts file: anything named `*.svelte.ts` is compiled as a Svelte rune
// module, and this isn't one.
import { BACKDROP_FRAGMENT } from "../backdrop-shader";

const VS = [
  "#version 300 es",
  "in vec2 a;",
  "void main(){ gl_Position = vec4(a, 0.0, 1.0); }",
].join("\n");

export function drawBackdrop(w: number, h: number, time: number, pulse = 0.3): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.style.cssText = "width:" + w + "px;height:" + h + "px;display:block";
  document.body.appendChild(canvas);

  const gl = canvas.getContext("webgl2");
  if (!gl) throw new Error("no webgl2");

  // The shader is authored for WebGL1-style three.js; promote it to GLSL ES 3.00.
  // Precision has to be declared before the `out` variable, so the body's own
  // precision line is lifted to the top rather than left where it is.
  const fs = [
    "#version 300 es",
    "precision highp float;",
    "out vec4 fragColor;",
    BACKDROP_FRAGMENT.split("precision highp float;")
      .join("")
      .split("gl_FragColor")
      .join("fragColor"),
  ].join("\n");

  const compile = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) throw new Error("createShader");
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(s) || "compile failed");
    }
    return s;
  };

  const prog = gl.createProgram();
  if (!prog) throw new Error("createProgram");
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog) || "link failed");
  }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "a");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  // Set the viewport explicitly. The default one is derived at context creation
  // and doesn't reliably match the drawing buffer in this harness — leaving it
  // rasterises only part of the canvas, which looks exactly like a shader bug.
  gl.viewport(0, 0, w, h);
  gl.uniform2f(gl.getUniformLocation(prog, "uRes"), w, h);
  gl.uniform1f(gl.getUniformLocation(prog, "uTime"), time);
  gl.uniform1f(gl.getUniformLocation(prog, "uPulse"), pulse);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  return canvas;
}
