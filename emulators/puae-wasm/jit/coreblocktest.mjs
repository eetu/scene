// Differential test for the REAL-ABI block codegen (coreblock.mjs) against the
// trusted reference interpreter (interp.mjs). Random body + terminator, random
// state; run both; compare D0..D7 / A0..A7 / flags (md-generic↔packed) / guest
// RAM / next PC. Memory is backed by the SAME masked-cell model interp uses (so
// get_long/put_long address the same words) — this validates codegen logic;
// big-endian get/put_long is the core's job (proven by coretest.mjs).
//
//   node coreblocktest.mjs [trials] [maxlen]
import { recompileCoreBlock } from "./coreblock.mjs";
import { interpBlock, runInterp } from "./interp.mjs";
import { blockAt, decodeBlock } from "./decode.mjs";
import * as L from "./layout.mjs";

const RB = 1024,
  FB = 1024 + 64; // regs base / regflags base in the block's wasm memory

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const TRIALS = Number(process.argv[2] || 20000);
const MAXLEN = Number(process.argv[3] || 8);
const rnd = rng(0x9e3779b1);
const ri = (n) => Math.floor(rnd() * n);
const r32 = () => (rnd() * 4294967296) | 0;

// ── instruction-word generators (subset the decoder + coreblock support) ──
const memEA = () => {
  switch (ri(5)) {
    case 0:
      return { mode: 2, reg: ri(8), ext: [] };
    case 1:
      return { mode: 3, reg: ri(8), ext: [] };
    case 2:
      return { mode: 4, reg: ri(8), ext: [] };
    case 3:
      return { mode: 5, reg: ri(8), ext: [ri(0x10000)] };
    default: {
      const a = r32();
      return { mode: 7, reg: 1, ext: [(a >>> 16) & 0xffff, a & 0xffff] };
    }
  }
};
const immEA = () => {
  const v = r32();
  return { mode: 7, reg: 4, ext: [(v >>> 16) & 0xffff, v & 0xffff] };
};
const dEA = () => ({ mode: 0, reg: ri(8), ext: [] });
const aEA = () => ({ mode: 1, reg: ri(8), ext: [] });
const anySrc = () => [memEA, immEA, dEA, aEA][ri(4)]();
const aluEA = (base, allowA) => {
  const s = allowA ? anySrc() : [memEA, immEA, dEA][ri(3)]();
  return [base | (ri(8) << 9) | (0b010 << 6) | (s.mode << 3) | s.reg, ...s.ext];
};
const immI = () => {
  const base = [0x0680, 0x0480, 0x0280, 0x0080, 0x0a80, 0x0c80][ri(6)];
  const v = r32();
  return [base | ri(8), (v >>> 16) & 0xffff, v & 0xffff];
};
const leaEA = () => {
  const a = r32();
  return [
    { mode: 2, reg: ri(8), ext: [] },
    { mode: 5, reg: ri(8), ext: [ri(0x10000)] },
    { mode: 7, reg: 1, ext: [(a >>> 16) & 0xffff, a & 0xffff] },
  ][ri(3)];
};
const eaWord = (base, an, s) => [base | (an << 9) | (s.mode << 3) | s.reg, ...s.ext];

function randBody() {
  switch (ri(27)) {
    case 0:
      return [0x7000 | (ri(8) << 9) | ri(256)]; // MOVEQ
    case 1:
      return [0x5080 | (ri(8) << 9) | ri(8)]; // ADDQ.L
    case 2:
      return aluEA(0xd000, true); // ADD.L <ea>,Dn
    case 3:
      return aluEA(0x9000, true); // SUB.L
    case 4: {
      const s = anySrc();
      return [0x2000 | (ri(8) << 9) | (s.mode << 3) | s.reg, ...s.ext];
    } // MOVE.L <ea>,Dn
    case 5: {
      const d = memEA();
      return [0x2000 | (d.reg << 9) | (d.mode << 6) | ri(8), ...d.ext];
    } // MOVE.L Dn,<mem>
    case 6: {
      const s = anySrc();
      return [0x2000 | (ri(8) << 9) | (1 << 6) | (s.mode << 3) | s.reg, ...s.ext];
    } // MOVEA.L
    case 7:
      return aluEA(0xc000, false); // AND.L
    case 8:
      return aluEA(0x8000, false); // OR.L
    case 9:
      return [0xb180 | (ri(8) << 9) | ri(8)]; // EOR.L Dx,Dy
    case 10:
      return aluEA(0xb000, true); // CMP.L
    case 11:
      return [0x4680 | ri(8)]; // NOT.L
    case 12:
      return [0x4480 | ri(8)]; // NEG.L
    case 13:
      return immI(); // immediate ALU
    case 14: {
      const s = [memEA, immEA, dEA][ri(3)]();
      return [0x4a80 | (s.mode << 3) | s.reg, ...s.ext];
    } // TST.L
    case 15: {
      const s = [memEA, dEA][ri(2)]();
      return [0x4280 | (s.mode << 3) | s.reg, ...s.ext];
    } // CLR.L
    case 16:
      return eaWord(0xd1c0, ri(8), anySrc()); // ADDA.L
    case 17:
      return eaWord(0x91c0, ri(8), anySrc()); // SUBA.L
    case 18:
      return eaWord(0xb1c0, ri(8), anySrc()); // CMPA.L
    case 19:
      return eaWord(0x41c0, ri(8), leaEA()); // LEA
    case 20:
      return [0x48c0 | ri(8)]; // EXT.L
    case 21:
      return [0x4840 | ri(8)]; // SWAP
    case 22:
      return [0xe080 | (ri(8) << 9) | ri(8)]; // ASR.L
    case 23:
      return [0xe180 | (ri(8) << 9) | ri(8)]; // ASL.L
    case 24:
      return [0xe088 | (ri(8) << 9) | ri(8)]; // LSR.L
    case 25:
      return [0xe188 | (ri(8) << 9) | ri(8)]; // LSL.L
    default:
      return [0x4e71]; // NOP
  }
}
// terminators interp understands (so we can compare next PC)
function randTerm() {
  switch (ri(4)) {
    case 0:
      return [0x6000 | (ri(0x80) + 1)]; // BRA.b (nonzero disp)
    case 1:
      return [0x6000 | (2 << 8) | (ri(0x80) + 1)]; // Bcc.b (cc=2 HI)
    case 2:
      return [0x6700, ri(0x10000)]; // BEQ.w (word disp)
    default:
      return [0x50c8 | (ri(16) << 8) | ri(8), ri(0x10000)]; // DBcc, random cc (exercises decrement path)
  }
}

// packed CCR (interp) ↔ md-generic (coreblock)
const packedToMd = (ccr) => ({
  cznv:
    ((ccr & L.N ? 1 << 15 : 0) |
      (ccr & L.Z ? 1 << 14 : 0) |
      (ccr & L.C ? 1 << 8 : 0) |
      (ccr & L.V ? 1 : 0)) >>>
    0,
  x: ccr & L.X ? 1 << 8 : 0,
});
const mdToPacked = (cznv, x) =>
  ((cznv >>> 15) & 1 ? L.N : 0) |
  ((cznv >>> 14) & 1 ? L.Z : 0) |
  ((cznv >>> 8) & 1 ? L.C : 0) |
  (cznv & 1 ? L.V : 0) |
  ((x >>> 8) & 1 ? L.X : 0);

let pass = 0,
  fail = 0;
const failures = [];

for (let t = 0; t < TRIALS; t++) {
  const body = [];
  const n = 1 + ri(MAXLEN);
  for (let k = 0; k < n; k++) body.push(...randBody());
  const words = [...body, ...randTerm()];

  const block = blockAt(words, 0);
  if (!block.instrs.length) continue; // need a body to JIT

  // seed random machine state
  const D = Array.from({ length: 8 }, () => r32());
  const A = Array.from({ length: 8 }, () => r32());
  const ccr = ri(32);
  const RAM = L.RAM_CELLS;
  const ram = Int32Array.from({ length: RAM }, () => r32());

  // ── reference: interp over an Int32Array state (packed CCR, cell RAM) ──
  const s = new Int32Array(L.RAM_CELL0 + RAM);
  for (let i = 0; i < 8; i++) s[L.iD(i)] = D[i];
  for (let i = 0; i < 8; i++) s[L.iA(i)] = A[i];
  s[L.iCCR] = ccr;
  for (let i = 0; i < RAM; i++) s[L.RAM_CELL0 + i] = ram[i];
  interpBlock(block, s);

  // ── coreblock: regs/flags in wasm memory, RAM via cell-backed get/put_long ──
  const mem = new WebAssembly.Memory({ initial: 1 });
  const dv = new DataView(mem.buffer);
  for (let i = 0; i < 8; i++) dv.setInt32(RB + i * 4, D[i], true);
  for (let i = 0; i < 8; i++) dv.setInt32(RB + 32 + i * 4, A[i], true);
  const md = packedToMd(ccr);
  dv.setUint32(FB, md.cznv, true);
  dv.setUint32(FB + 4, md.x, true);
  const ramC = Int32Array.from(ram);
  const cell = (a) => (a & L.RAM_MASK) / 4;
  const env = {
    memory: mem,
    get_long: (a) => ramC[cell(a >>> 0)] | 0,
    put_long: (a, v) => (ramC[cell(a >>> 0)] = v | 0),
  };
  const inst = await WebAssembly.instantiate(
    await WebAssembly.compile(recompileCoreBlock(block, { regsBase: RB, regflagsBase: FB })),
    { env },
  );
  const gotPC = inst.exports.block() | 0;

  // ── compare ──
  let ok = gotPC === s[L.iPC];
  for (let i = 0; i < 8; i++) if (dv.getInt32(RB + i * 4, true) !== s[L.iD(i)]) ok = false;
  for (let i = 0; i < 8; i++) if (dv.getInt32(RB + 32 + i * 4, true) !== s[L.iA(i)]) ok = false;
  const gotCcr = mdToPacked(dv.getUint32(FB, true) >>> 0, dv.getUint32(FB + 4, true) >>> 0);
  if (gotCcr !== (s[L.iCCR] & 0x1f)) ok = false;
  for (let i = 0; i < RAM; i++) if (ramC[i] !== s[L.RAM_CELL0 + i]) ok = false;

  if (ok) pass++;
  else {
    fail++;
    if (failures.length < 3)
      failures.push({
        words: words.map((x) => "0x" + (x & 0xffff).toString(16)),
        gotPC,
        wantPC: s[L.iPC],
        gotCcr,
        wantCcr: s[L.iCCR] & 0x1f,
      });
  }
}

console.log(
  `coreblock (real ABI) difftest vs interp: ${pass}/${pass + fail} passed, ${fail} failed`,
);
if (fail) {
  console.log(JSON.stringify(failures, null, 2));
  process.exit(1);
}
console.log("✅ real-ABI blocks match the reference interpreter (regs, flags, RAM, next PC).");
