// Byte-exact WAV (RIFF/PCM) encoding for sample export. Pure: takes raw PCM +
// format and returns a Blob, no store/engine — so the header layout and the
// 8-bit sign conversion are unit-testable (a regression here silently corrupts
// every exported sample).

/** The format fields buildWav needs (a subset of the engine's SampleInfo). */
export type WavFormat = { bits: number; channels: number; rate: number };

/** Wrap raw PCM in a 44-byte RIFF/WAVE header. libopenmpt stores 8-bit PCM as
 *  signed, but WAV wants unsigned 8-bit, so bias those samples by +128. */
export function buildWav(raw: Uint8Array, info: WavFormat): Blob {
  const { bits, channels: ch, rate } = info;
  let data = raw;
  if (bits === 8) {
    data = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) data[i] = (raw[i] + 128) & 0xff;
  }
  const blockAlign = ch * (bits >> 3);
  const buf = new ArrayBuffer(44 + data.length);
  const dv = new DataView(buf);
  let o = 0;
  const str = (s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o++, s.charCodeAt(i));
  };
  str("RIFF");
  dv.setUint32(o, 36 + data.length, true);
  o += 4;
  str("WAVE");
  str("fmt ");
  dv.setUint32(o, 16, true);
  o += 4;
  dv.setUint16(o, 1, true); // PCM
  o += 2;
  dv.setUint16(o, ch, true);
  o += 2;
  dv.setUint32(o, rate, true);
  o += 4;
  dv.setUint32(o, rate * blockAlign, true); // byte rate
  o += 4;
  dv.setUint16(o, blockAlign, true);
  o += 2;
  dv.setUint16(o, bits, true);
  o += 2;
  str("data");
  dv.setUint32(o, data.length, true);
  o += 4;
  new Uint8Array(buf, 44).set(data);
  return new Blob([buf], { type: "audio/wav" });
}
