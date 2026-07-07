import { afterEach, expect, test, vi } from "vitest";

import { setPatternMode, settings } from "$lib/settings.svelte";

afterEach(() => vi.unstubAllGlobals());

test("setPatternMode updates the shared state and persists", () => {
  const setItem = vi.fn();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem });

  setPatternMode("scroll");
  expect(settings.patternMode).toBe("scroll"); // any importer sees the new value
  expect(setItem).toHaveBeenCalledWith("tracker:patternMode", "scroll");

  setPatternMode("locked");
  expect(settings.patternMode).toBe("locked");
});

test("persistence failure is swallowed (storage unavailable)", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceeded");
    },
  });
  expect(() => setPatternMode("scroll")).not.toThrow();
  expect(settings.patternMode).toBe("scroll");
});
