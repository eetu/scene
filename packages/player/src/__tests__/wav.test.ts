import { describe, expect, test } from "vitest";

import { buildWav } from "../wav";

async function view(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}
const ascii = (dv: DataView, at: number, len: number) =>
  String.fromCharCode(...Array.from({ length: len }, (_, i) => dv.getUint8(at + i)));

describe("buildWav", () => {
  test("writes a correct 44-byte RIFF/PCM header (16-bit stereo)", async () => {
    const raw = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]); // 2 frames of 16-bit stereo
    const dv = await view(buildWav(raw, { bits: 16, channels: 2, rate: 44100 }));

    expect(ascii(dv, 0, 4)).toBe("RIFF");
    expect(dv.getUint32(4, true)).toBe(36 + raw.length); // chunk size
    expect(ascii(dv, 8, 4)).toBe("WAVE");
    expect(ascii(dv, 12, 4)).toBe("fmt ");
    expect(dv.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(dv.getUint16(20, true)).toBe(1); // PCM
    expect(dv.getUint16(22, true)).toBe(2); // channels
    expect(dv.getUint32(24, true)).toBe(44100); // sample rate
    expect(dv.getUint32(28, true)).toBe(44100 * 4); // byte rate = rate * blockAlign
    expect(dv.getUint16(32, true)).toBe(4); // blockAlign = ch * bytesPerSample
    expect(dv.getUint16(34, true)).toBe(16); // bits
    expect(ascii(dv, 36, 4)).toBe("data");
    expect(dv.getUint32(40, true)).toBe(raw.length);
    expect(dv.byteLength).toBe(44 + raw.length);
  });

  test("16-bit PCM bytes pass through unchanged", async () => {
    const raw = new Uint8Array([10, 20, 250, 130]);
    const dv = await view(buildWav(raw, { bits: 16, channels: 1, rate: 8000 }));
    expect([dv.getUint8(44), dv.getUint8(45), dv.getUint8(46), dv.getUint8(47)]).toEqual([
      10, 20, 250, 130,
    ]);
  });

  test("8-bit signed → unsigned (+128) conversion", async () => {
    // libopenmpt stores 8-bit signed; WAV wants unsigned, so bias by 128.
    const raw = new Uint8Array([0, 128, 255, 1]); // signed 0, -128, -1, 1
    const dv = await view(buildWav(raw, { bits: 8, channels: 1, rate: 8000 }));
    expect(dv.getUint16(34, true)).toBe(8); // bits
    expect(dv.getUint16(32, true)).toBe(1); // blockAlign = 1
    expect([dv.getUint8(44), dv.getUint8(45), dv.getUint8(46), dv.getUint8(47)]).toEqual([
      128, // (0 + 128) & 0xff
      0, // (128 + 128) & 0xff
      127, // (255 + 128) & 0xff
      129, // (1 + 128) & 0xff
    ]);
  });
});
