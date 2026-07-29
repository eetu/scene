// Guard: no NUL bytes in source files.
//
// One stray NUL is enough for git to classify a file as binary, and a binary file has
// no diff, no blame and nothing to review — split-flap-shakedown.svelte.test.ts landed
// that way, 11kB of test code committed as "Bin 0 -> 11036 bytes". Nothing else catches
// it: eslint parsed the file happily and prettier reformatted it without complaint,
// because a NUL inside a string literal is valid TypeScript.
//
// A node-project test rather than a lint rule, because the failure is about the bytes
// on disk rather than the syntax tree.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

const ROOT = new URL("../", import.meta.url).pathname;
const SKIP = new Set(["vendor", "__screenshots__", "viz-gallery"]);

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|js|svelte)$/.test(entry)) out.push(path);
  }
  return out;
}

test("no source file contains a NUL byte", () => {
  const files = sources(ROOT);
  // Guard the guard: if the walk finds nothing, the test passes while checking nothing.
  expect(files.length, "found no sources to scan").toBeGreaterThan(20);

  const binary = files.filter((f) => readFileSync(f).includes(0));
  expect(
    binary.map((f) => f.slice(ROOT.length)),
    "these would be committed as binary — git shows no diff for them",
  ).toEqual([]);
});
