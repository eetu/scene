import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";
test("Tunnel FRAG shader compiles (all themes)", async ({ page }) => {
  const src = readFileSync("../../../packages/player/src/Tunnel.svelte", "utf8");
  const m = src.match(/const FRAG = `([\s\S]*?)`;/);
  expect(m, "FRAG template found").toBeTruthy();
  await page.goto("about:blank");
  const err = await page.evaluate((frag: string) => {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl")!;
    const sh = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(sh, frag);
    gl.compileShader(sh);
    return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? null : gl.getShaderInfoLog(sh);
  }, m![1]);
  if (err) throw new Error("GLSL compile error:\n" + err);
});
