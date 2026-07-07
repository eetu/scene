import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

// The chiptune3 engine (decoder Worker + worklet + libopenmpt glue) is
// single-sourced in packages/player/vendor/chiptune3; each app's
// static/vendor/chiptune3 is a SYMLINK to it. SvelteKit serves static/, and both
// adapter-static (build) and the Dockerfile (COPY preserves the link, and it
// copies packages/ too) follow it — so there's exactly one real copy and the apps
// can't drift. This guards that invariant: if a symlink is ever replaced by a real
// (divergent) copy, the per-app engine silently drifts — catch it here.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../..");
const CANONICAL = resolve(ROOT, "packages/player/vendor/chiptune3");
const APPS = ["tracker", "party"] as const;

describe("chiptune3 engine is single-sourced (apps symlink the canonical copy)", () => {
  test("the canonical copy holds the engine files", () => {
    const files = readdirSync(CANONICAL);
    expect(files).toEqual(
      expect.arrayContaining([
        "decoder.worker.js",
        "chiptune3.worklet.js",
        "libopenmpt.worklet.js",
      ]),
    );
  });

  for (const app of APPS) {
    const link = resolve(ROOT, "apps", app, "frontend/static/vendor/chiptune3");
    test(`${app} symlinks the canonical engine (no per-app copy)`, () => {
      expect(
        lstatSync(link).isSymbolicLink(),
        `${app}/static/vendor/chiptune3 must be a symlink to packages/player/vendor/chiptune3, not a copy`,
      ).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(CANONICAL));
    });
  }
});
