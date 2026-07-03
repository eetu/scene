// Control-flow differential test. Generates terminating programs with real
// branches and loops (forward Bcc/BRA + bounded DBRA loops, ending in HALT),
// then runs them BOTH through the reference interpreter (runProgram) and the
// WASM block-runner (runWasm) and asserts identical final state (D/A regs, CCR,
// PC). Exercises all 16 condition codes, DBcc, BRA, the PC model, and block
// caching. Termination is guaranteed by construction (only backward branch is a
// bounded DBRA) plus a step budget backstop in both runners.
//
//   node cftest.mjs [trials]
import { runProgram } from "./interp.mjs";
import { runWasm } from "./run.mjs";
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
const TRIALS = Number(process.argv[2] || 3000);
const rnd = rng(0xc0ffee);
const ri = (n) => Math.floor(rnd() * n);
const r32 = () => (rnd() * 4294967296) | 0;

// single-word register ALU ops
function aluWord() {
  switch (ri(9)) {
    case 0:
      return 0x7000 | (ri(8) << 9) | ri(256); // MOVEQ
    case 1:
      return 0x5080 | (ri(8) << 9) | ri(8); // ADDQ
    case 2:
      return 0xd080 | (ri(8) << 9) | ri(8); // ADD
    case 3:
      return 0x9080 | (ri(8) << 9) | ri(8); // SUB
    case 4:
      return 0xc080 | (ri(8) << 9) | ri(8); // AND
    case 5:
      return 0x8080 | (ri(8) << 9) | ri(8); // OR
    case 6:
      return 0xb080 | (ri(8) << 9) | ri(8); // CMP
    case 7:
      return 0x4680 | ri(8); // NOT
    default:
      return 0x4480 | ri(8); // NEG
  }
}
// destination register of a word, or -1 if none (cmp)
function destOf(w) {
  if ((w & 0xf100) === 0x7000) return (w >> 9) & 7;
  if ((w & 0xf1f8) === 0x5080) return w & 7;
  if ((w & 0xf1f8) === 0xd080) return (w >> 9) & 7;
  if ((w & 0xf1f8) === 0x9080) return (w >> 9) & 7;
  if ((w & 0xf1f8) === 0xc080) return (w >> 9) & 7;
  if ((w & 0xf1f8) === 0x8080) return (w >> 9) & 7;
  if ((w & 0xfff8) === 0x4680) return w & 7;
  if ((w & 0xfff8) === 0x4480) return w & 7;
  return -1;
}
const aluAvoid = (k) => {
  for (let i = 0; i < 12; i++) {
    const w = aluWord();
    if (destOf(w) !== k) return w;
  }
  return 0xb080 | (ri(8) << 9) | ri(8); // CMP — never writes back
};

// tiny two-pass assembler
function asm() {
  const words = [];
  const labels = {};
  const fixups = [];
  return {
    words,
    at: () => words.length * 2,
    op: (...ws) => words.push(...ws),
    label: (n) => (labels[n] = words.length * 2),
    bcc8: (cc, n) => {
      fixups.push({ i: words.length, n, kind: "b8" });
      words.push(0x6000 | (cc << 8));
    },
    dbra: (reg, n) => {
      fixups.push({ i: words.length, n, kind: "dbcc" });
      words.push(0x50c8 | (1 << 8) | reg, 0); // cc=1 (F) ⇒ DBRA
    },
    halt: () => words.push(0x4afc),
    finish() {
      for (const f of fixups) {
        const disp = labels[f.n] - (f.i * 2 + 2);
        if (f.kind === "b8") words[f.i] = (words[f.i] & 0xff00) | (disp & 0xff);
        else words[f.i + 1] = disp & 0xffff;
      }
      return words;
    },
  };
}

function genProgram() {
  const a = asm();
  for (let r = 0; r < 8; r++) a.op(0x7000 | (r << 9) | ri(24)); // seed D0..D7 small
  const segs = 2 + ri(3);
  for (let s = 0; s < segs; s++) {
    for (let b = 0; b < 1 + ri(3); b++) a.op(aluWord());
    switch (ri(3)) {
      case 0: {
        // forward Bcc (skip 1..3 ops); disp guaranteed >0 and small
        const cc = 2 + ri(14);
        const lbl = "f" + s;
        a.bcc8(cc, lbl);
        for (let b = 0; b < 1 + ri(3); b++) a.op(aluWord());
        a.label(lbl);
        break;
      }
      case 1: {
        // bounded DBRA loop (counter reg k seeded small; body avoids clobbering k)
        const k = ri(8);
        a.op(0x7000 | (k << 9) | ri(8)); // MOVEQ #count,Dk
        const lbl = "l" + s;
        a.label(lbl);
        for (let b = 0; b < 1 + ri(2); b++) a.op(aluAvoid(k));
        a.dbra(k, lbl);
        break;
      }
      default: {
        // forward BRA (skip 1..3 ops)
        const lbl = "b" + s;
        a.bcc8(0, lbl); // cc=0 ⇒ BRA
        for (let b = 0; b < 1 + ri(3); b++) a.op(aluWord());
        a.label(lbl);
      }
    }
  }
  a.halt();
  return a.finish();
}

const STATE_CELLS = L.RAM_CELL0 + L.RAM_CELLS;

let pass = 0;
let fail = 0;
let totalCompiles = 0;
let totalSteps = 0;
const failures = [];

for (let t = 0; t < TRIALS; t++) {
  const words = genProgram();

  const init = new Int32Array(STATE_CELLS);
  for (let i = 0; i < 16; i++) init[i] = r32();
  init[L.iCCR] = ri(32);
  init[L.iPC] = 0;

  const expect = Int32Array.from(init);
  runProgram(words, expect);

  const pages = Math.ceil((STATE_CELLS * 4) / 65536);
  const mem = new WebAssembly.Memory({ initial: pages });
  new Int32Array(mem.buffer).set(init);
  const stats = await runWasm(words, mem);
  totalCompiles += stats.compiles;
  totalSteps += stats.steps;
  const view = new Int32Array(mem.buffer);

  let ok = true;
  for (let i = 0; i <= L.iPC; i++) if (view[i] !== expect[i]) ok = false;
  if (ok) pass++;
  else {
    fail++;
    if (failures.length < 2) {
      const diff = [];
      for (let i = 0; i <= L.iPC; i++)
        if (view[i] !== expect[i]) diff.push({ idx: i, expect: expect[i], got: view[i] });
      failures.push({ words: words.map((w) => "0x" + (w & 0xffff).toString(16)), diff });
    }
  }
}

console.log(`control-flow difftest: ${pass}/${TRIALS} passed, ${fail} failed`);
console.log(
  `(avg ${(totalSteps / TRIALS).toFixed(1)} blocks/run, ${(totalCompiles / TRIALS).toFixed(1)} compiles/run — caching reuses loop blocks)`,
);
if (fail) {
  console.log(JSON.stringify(failures, null, 2));
  process.exit(1);
}
console.log("✅ recompiled control flow (Bcc/DBcc/BRA + PC) matches the interpreter.");
