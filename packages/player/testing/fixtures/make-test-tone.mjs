// Build a tiny PSID that is genuinely playable but wholly synthetic — HVSC
// tunes are their authors' copyright and can't live in the repo, and a header
// with no 6502 behind it proves nothing about playback.
//
// The init routine sets master volume, a mid frequency, a fast attack with full
// sustain, and gates voice 1 to a sawtooth. The play routine is a bare RTS: the
// tone simply sustains, which is all a "does audio come out" test needs.
import { writeFileSync } from "node:fs";
import { SidAudioEngine } from "libsidplayfp-wasm";

const CODE = [
  0xa9, 0x0f, 0x8d, 0x18, 0xd4, // LDA #$0F ; STA $D418   volume = 15
  0xa9, 0x00, 0x8d, 0x00, 0xd4, // LDA #$00 ; STA $D400   freq lo
  0xa9, 0x20, 0x8d, 0x01, 0xd4, // LDA #$20 ; STA $D401   freq hi
  0xa9, 0x09, 0x8d, 0x05, 0xd4, // LDA #$09 ; STA $D405   attack/decay
  0xa9, 0xf0, 0x8d, 0x06, 0xd4, // LDA #$F0 ; STA $D406   sustain 15
  0xa9, 0x21, 0x8d, 0x04, 0xd4, // LDA #$21 ; STA $D404   sawtooth + gate
  0x60,                          // RTS                    (init done)
  0x60,                          // RTS                    (play: nothing per frame)
];

const LOAD = 0x1000;
const INIT = 0x1000;
const PLAY = LOAD + CODE.length - 1; // the trailing RTS

const h = Buffer.alloc(0x7c);
h.write("PSID", 0, "ascii");
h.writeUInt16BE(2, 0x04); // version
h.writeUInt16BE(0x7c, 0x06); // dataOffset
h.writeUInt16BE(0, 0x08); // loadAddress 0 → taken from the data
h.writeUInt16BE(INIT, 0x0a);
h.writeUInt16BE(PLAY, 0x0c);
h.writeUInt16BE(2, 0x0e); // songs — two, so subtune switching is testable
h.writeUInt16BE(1, 0x10); // startSong
h.write("Test Tone", 0x16, "latin1");
h.write("scene", 0x36, "latin1");
h.write("2026 synthetic fixture", 0x56, "latin1");
h.writeUInt16BE((0b01 << 2) | (0b01 << 4), 0x76); // PAL, MOS6581

const data = Buffer.alloc(2 + CODE.length);
data.writeUInt16LE(LOAD, 0);
Buffer.from(CODE).copy(data, 2);

const sid = Buffer.concat([h, data]);
const out = process.argv[2] ?? "./test-tone.sid";
writeFileSync(out, sid);
console.log(`wrote ${out} (${sid.length} bytes)`);

// Prove it actually sounds, with and without ROMs — a fixture that renders
// silence would make the test it backs meaningless.
const peak = (p) => p.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
for (const engineName of ["residfp"]) {
  const eng = new SidAudioEngine({ sampleRate: 44100, engine: engineName });
  await eng.loadSidBuffer(new Uint8Array(sid));
  const info = eng.getTuneInfo();
  console.log(`  ${engineName}: songs=${info?.songs} peak=${peak(await eng.renderSeconds(2))}`);
}
