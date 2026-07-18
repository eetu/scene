import { expect, test } from "vitest";

// The fragment shader source as text — Vite's `?raw` loader. We compile it in a
// real WebGL context (why this is a browser test, not a node one: jsdom has no
// GL), guarding against a GLSL syntax error without spinning the full app.
import plasmaSource from "../Plasma.svelte?raw";

test("Plasma FRAG shader compiles", () => {
  const m = plasmaSource.match(/const FRAG = `([\s\S]*?)`;/);
  expect(m, "FRAG template literal found in Plasma.svelte").toBeTruthy();
  const frag = m![1];

  const gl = document.createElement("canvas").getContext("webgl");
  expect(gl, "WebGL context available in the test browser").toBeTruthy();

  const shader = gl!.createShader(gl!.FRAGMENT_SHADER)!;
  gl!.shaderSource(shader, frag);
  gl!.compileShader(shader);

  const ok = gl!.getShaderParameter(shader, gl!.COMPILE_STATUS);
  const log = ok ? null : gl!.getShaderInfoLog(shader);
  expect(log, log ? `GLSL compile error:\n${log}` : "compiles").toBeNull();
});
