// Differential test: random programs (register ALU ops + MOVE/MOVEA with EA
// modes and guest-RAM access) on random machine state; run the recompiled WASM
// block and the reference interpreter and assert identical D0..D7, A0..A7, CCR,
// and the whole guest-RAM region. Proves the recompiler's codegen — results,
// flags, addressing, and memory — without a running core.
//
//   node difftest.mjs [trials] [maxlen]
import { recompile } from "./recompile.mjs";
import { runInterp } from "./interp.mjs";
import { decodeBlock } from "./decode.mjs";
import * as L from "./layout.mjs";

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const TRIALS = Number(process.argv[2] || 4000);
const MAXLEN = Number(process.argv[3] || 10);
const rnd = rng(0x1a2b3c);
const ri = (n) => Math.floor(rnd() * n);
const r32 = () => (rnd() * 4294967296) | 0;

// EA generators → {mode, reg, ext}
const memEA = () => {
  switch (ri(5)) {
    case 0:
      return { mode: 2, reg: ri(8), ext: [] }; // (An)
    case 1:
      return { mode: 3, reg: ri(8), ext: [] }; // (An)+
    case 2:
      return { mode: 4, reg: ri(8), ext: [] }; // -(An)
    case 3:
      return { mode: 5, reg: ri(8), ext: [ri(0x10000)] }; // (d16,An)
    default: {
      const a = r32();
      return { mode: 7, reg: 1, ext: [(a >>> 16) & 0xffff, a & 0xffff] }; // abs.L
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

// instruction generators → array of words
function randInstr() {
  switch (ri(14)) {
    case 8:
      return [0xc080 | (ri(8) << 9) | ri(8)]; // AND.L Dy,Dx
    case 9:
      return [0x8080 | (ri(8) << 9) | ri(8)]; // OR.L Dy,Dx
    case 10:
      return [0xb180 | (ri(8) << 9) | ri(8)]; // EOR.L Dx,Dy
    case 11:
      return [0xb080 | (ri(8) << 9) | ri(8)]; // CMP.L Dy,Dx
    case 12:
      return [0x4680 | ri(8)]; // NOT.L Dn
    case 13:
      return [0x4480 | ri(8)]; // NEG.L Dn
    case 0:
      return [0x7000 | (ri(8) << 9) | ri(256)]; // MOVEQ
    case 1:
      return [0x5080 | (ri(8) << 9) | ri(8)]; // ADDQ.L
    case 2:
      return [0xd080 | (ri(8) << 9) | ri(8)]; // ADD.L Dy,Dx
    case 3:
      return [0x9080 | (ri(8) << 9) | ri(8)]; // SUB.L Dy,Dx
    case 4: {
      // MOVE.L <ea>,Dn (load / reg move); src ext words follow the opcode
      const s = anySrc();
      const dn = ri(8);
      return [0x2000 | (dn << 9) | (0 << 6) | (s.mode << 3) | s.reg, ...s.ext];
    }
    case 5: {
      // MOVE.L Dn,<mem> (store); dst ext words follow the opcode (src Dn has none)
      const d = memEA();
      const dn = ri(8);
      return [0x2000 | (d.reg << 9) | (d.mode << 6) | (0 << 3) | dn, ...d.ext];
    }
    default: {
      // MOVEA.L <ea>,An
      const s = anySrc();
      const an = ri(8);
      return [0x2000 | (an << 9) | (1 << 6) | (s.mode << 3) | s.reg, ...s.ext];
    }
  }
}

const STATE_CELLS = L.RAM_CELL0 + L.RAM_CELLS;

function seedState() {
  const s = new Int32Array(STATE_CELLS);
  for (let i = 0; i < 16; i++) s[i] = r32(); // D0..D7, A0..A7
  s[L.iCCR] = ri(32);
  for (let i = L.RAM_CELL0; i < STATE_CELLS; i++) s[i] = r32(); // guest RAM
  return s;
}

let pass = 0;
let fail = 0;
const failures = [];

for (let t = 0; t < TRIALS; t++) {
  const words = [];
  const n = 1 + ri(MAXLEN);
  for (let k = 0; k < n; k++) words.push(...randInstr());

  const init = seedState();
  const expect = Int32Array.from(init);
  runInterp(words, expect);

  const pages = Math.ceil((STATE_CELLS * 4) / 65536);
  const mem = new WebAssembly.Memory({ initial: pages });
  const inst = await WebAssembly.instantiate(
    await WebAssembly.compile(recompile(decodeBlock(words))),
    {
      env: { memory: mem },
    },
  );
  const view = new Int32Array(mem.buffer);
  view.set(init);
  inst.exports.block();

  let ok = true;
  for (let i = 0; i < STATE_CELLS; i++) if (view[i] !== expect[i]) ok = false;
  if (ok) pass++;
  else {
    fail++;
    if (failures.length < 2) {
      const diff = [];
      for (let i = 0; i < STATE_CELLS; i++)
        if (view[i] !== expect[i]) diff.push({ idx: i, expect: expect[i], got: view[i] });
      failures.push({
        words: words.map((w) => "0x" + (w & 0xffff).toString(16)),
        diff: diff.slice(0, 8),
      });
    }
  }
}

console.log(`68k→WASM recompiler difftest (EA + memory): ${pass}/${TRIALS} passed, ${fail} failed`);
if (fail) {
  console.log(JSON.stringify(failures, null, 2));
  process.exit(1);
}
console.log("✅ recompiled blocks match the reference interpreter (regs, A-regs, CCR, RAM).");
