import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

// The chiptune3 engine (decoder Worker + worklet + libopenmpt glue) is served
// verbatim from each app's static/ (SvelteKit serves static/), so it's duplicated
// per app. Those copies MUST stay byte-identical — an engine change touches all of
// them, and it's easy to update one and forget the other (this happened while
// adding decodeSong). This guard fails CI on any drift; `just sync-engine` re-syncs
// from the canonical copy (tracker).
//
// (This is the interim guard until the engine is truly single-sourced into this
// package — see the "consolidate engine" task. Until then, one test beats silent
// drift.)
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../..");
const REL = "frontend/static/vendor/chiptune3";
const APPS = ["tracker", "party"] as const;

function engineDir(app: string) {
  return resolve(ROOT, "apps", app, REL);
}

describe("chiptune3 engine files stay in sync across apps", () => {
  const [canonical, other] = APPS;
  const canonicalNames = readdirSync(engineDir(canonical)).sort();

  test(`${other} ships the same engine files as ${canonical}`, () => {
    expect(readdirSync(engineDir(other)).sort()).toEqual(canonicalNames);
  });

  for (const name of canonicalNames) {
    test(`${name} is byte-identical across apps`, () => {
      const a = readFileSync(resolve(engineDir(canonical), name));
      const b = readFileSync(resolve(engineDir(other), name));
      expect(b.equals(a), `${name} differs — run \`just sync-engine\``).toBe(true);
    });
  }
});
