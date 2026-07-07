import { expect, test } from "vitest";

// The whole shader source as text — Vite's `?raw` loader. We compile the
// fragment shader in a real WebGL context (why this is a browser test, not a
// node one: jsdom has no GL). Guards every theme branch against a GLSL syntax
// error, the way the old Playwright spec did but without spinning the full app.
import tunnelSource from "../Tunnel.svelte?raw";

test("Tunnel FRAG shader compiles (all themes)", () => {
  const m = tunnelSource.match(/const FRAG = `([\s\S]*?)`;/);
  expect(m, "FRAG template literal found in Tunnel.svelte").toBeTruthy();
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
