import { describe, expect, test } from "vitest";

import { crc32, KNOWN_ROMS } from "$lib/amigaRoms";

const enc = new TextEncoder();

describe("crc32", () => {
  test("matches the canonical IEEE CRC32 test vector", () => {
    // "123456789" → 0xCBF43926 (the standard CRC32 check value).
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
  });

  test("empty input → 0", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  test("returns an unsigned 32-bit value", () => {
    const v = crc32(enc.encode("The quick brown fox"));
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(0xffffffff);
  });
});

describe("KNOWN_ROMS", () => {
  test("each ROM entry carries a 32-bit crc and a plausible size", () => {
    const entries = Object.entries(KNOWN_ROMS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, rom] of entries) {
      expect(rom.crc, name).toBeGreaterThanOrEqual(0);
      expect(rom.crc, name).toBeLessThanOrEqual(0xffffffff);
      expect(rom.size, name).toBeGreaterThan(0);
      expect(rom.label, name).toBeTruthy();
    }
  });
});
