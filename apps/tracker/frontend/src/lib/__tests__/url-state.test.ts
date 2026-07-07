import { describe, expect, test } from "vitest";

import { buildShareUrl, parsePos } from "$lib/url-state";

describe("parsePos", () => {
  test("parses whole seconds", () => {
    expect(parsePos("42")).toBe(42);
    expect(parsePos("42.9")).toBe(42); // floored
  });
  test("missing / junk / negative → 0", () => {
    expect(parsePos(null)).toBe(0);
    expect(parsePos("")).toBe(0);
    expect(parsePos("nope")).toBe(0);
    expect(parsePos("-5")).toBe(0);
  });
});

describe("buildShareUrl", () => {
  test("sets ?t and ?pos, flooring the position", () => {
    const url = new URL(buildShareUrl("https://x.test/app", "deadbeef", 12.7));
    expect(url.searchParams.get("t")).toBe("deadbeef");
    expect(url.searchParams.get("pos")).toBe("12");
  });
  test("clamps a negative position to 0 and preserves other params", () => {
    const url = new URL(buildShareUrl("https://x.test/app?tab=fav", "h1", -3));
    expect(url.searchParams.get("pos")).toBe("0");
    expect(url.searchParams.get("tab")).toBe("fav");
  });
  test("replaces a stale ?t/?pos rather than appending", () => {
    const url = new URL(buildShareUrl("https://x.test/?t=old&pos=99", "new", 5));
    expect(url.searchParams.getAll("t")).toEqual(["new"]);
    expect(url.searchParams.getAll("pos")).toEqual(["5"]);
  });
});
