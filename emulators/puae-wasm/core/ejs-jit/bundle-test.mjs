// Validate the bundled ejs-jit.js end-to-end WITHOUT a core rebuild: fake a core
// Module (real WebAssembly.Table/Memory for regs+flags; guest RAM via the jit_*
// byte/word/long callbacks), load the bundle so it installs Module.ejsJitGet, then
// drive random programs through it. The bundle's OWN parity gate compares each
// compiled block to the bundled interpreter, so gateFail===0 over many programs
// proves the bundle is wired correctly (same behaviour as jit/coreblocktest.mjs).
//
//   node bundle.mjs && node bundle-test.mjs [trials]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const bundle = readFileSync(join(HERE, "ejs-jit.js"), "utf8");

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
const pick = (a) => a[ri(a.length)];
const bits = (m, r) => (m << 3) | r;
const briefExt = () => ((ri(16) << 12) | (ri(2) ? 0x800 : 0) | (ri(4) << 9) | ri(256)) & 0xfeff;
const memEA = () =>
  pick([
    () => ({ mode: 2, reg: ri(8), ext: [] }),
    () => ({ mode: 3, reg: ri(8), ext: [] }),
    () => ({ mode: 5, reg: ri(8), ext: [ri(0x10000)] }),
    () => ({ mode: 6, reg: ri(8), ext: [briefExt()] }),
  ])();
const dEA = () => ({ mode: 0, reg: ri(8), ext: [] });
const src = () => pick([memEA, dEA, () => ({ mode: 7, reg: 4, ext: [ri(0x10000)] })])();
const dst = () => pick([memEA, dEA])();
// a small spread of the op families the bundle should JIT
const FAM = process.argv[3] !== undefined ? Number(process.argv[3]) : -1;
function body() {
  switch (FAM >= 0 ? FAM : ri(10)) {
    case 0:
      return [0x7000 | (ri(8) << 9) | ri(256)]; // MOVEQ
    case 1: {
      const s = src(),
        d = dst();
      return [0x3000 | (d.reg << 9) | (d.mode << 6) | bits(s.mode, s.reg), ...s.ext, ...d.ext];
    } // MOVE.W
    case 2: {
      const s = src();
      return [0xd000 | (ri(8) << 9) | (2 << 6) | bits(s.mode, s.reg), ...s.ext];
    } // ADD.L <ea>,Dn
    case 3: {
      const s = src();
      return [0xb000 | (ri(8) << 9) | (1 << 6) | bits(s.mode, s.reg), ...s.ext];
    } // CMP.W
    case 4: {
      const d = dst();
      return [0x0800 | (ri(4) << 6) | bits(d.mode, d.reg), ri(256), ...d.ext];
    } // static bit op
    case 5: {
      const s = src();
      return [0xc0c0 | (ri(8) << 9) | bits(s.mode, s.reg), ...s.ext];
    } // MULU
    case 6: {
      const d = dst();
      return [0x4200 | (1 << 6) | bits(d.mode, d.reg), ...d.ext];
    } // CLR.W
    case 7:
      return [0xe188 | (ri(8) << 9) | ri(8)]; // LSL.L #cnt,Dn
    case 8: {
      const s = { mode: 6, reg: ri(8), ext: [briefExt()] };
      return [0x41c0 | (ri(8) << 9) | bits(s.mode, s.reg), ...s.ext];
    } // LEA (d8,An,Xn)
    default: {
      const d = dst();
      return [0x5000 | (ri(8) << 9) | (ri(2) << 8) | (1 << 6) | bits(d.mode, d.reg), ...d.ext];
    } // ADDQ/SUBQ.W
  }
}
function term() {
  return pick([
    () => [0x6000 | (ri(0x80) + 1)], // BRA.b
    () => [0x6700, ri(0x10000)], // BEQ.w
    () => [0x50c8 | (ri(16) << 8) | ri(8), ri(0x10000)], // DBcc
    () => [0x4e75], // RTS
  ])();
}

// ---- fake core Module ----
const mem = new WebAssembly.Memory({ initial: 4 });
const dvm = new DataView(mem.buffer);
const REGS = 4096,
  FLAGS = REGS + 64;
const GBITS = 18,
  GSIZE = 1 << GBITS,
  GMASK = GSIZE - 1;
const g = new Uint8Array(GSIZE);
const gget = (a, sz) => {
  let v = 0;
  for (let i = 0; i < sz; i++) v = ((v << 8) | g[(a + i) & GMASK]) >>> 0;
  return v >>> 0;
};
const gput = (a, sz, val) => {
  for (let i = 0; i < sz; i++) g[(a + sz - 1 - i) & GMASK] = (val >>> (8 * i)) & 0xff;
};
const table = new WebAssembly.Table({ initial: 8, element: "anyfunc" });
const Module = {
  wasmMemory: mem,
  wasmTable: table,
  ejsJitGate: true,
  _jit_abi_regs: () => REGS,
  _jit_abi_regflags: () => FLAGS,
  _jit_abi_pc: () => FLAGS + 8,
  _jit_get_byte: (a) => gget(a, 1),
  _jit_get_word: (a) => gget(a, 2),
  _jit_get_long: (a) => gget(a, 4),
  _jit_put_byte: (a, v) => gput(a, 1, v),
  _jit_put_word: (a, v) => gput(a, 2, v),
  _jit_put_long: (a, v) => gput(a, 4, v),
};
// load the bundle → sets Module.ejsJitGet
new Function("Module", bundle)(Module);
if (typeof Module.ejsJitGet !== "function") {
  console.log("❌ bundle did not install Module.ejsJitGet");
  process.exit(1);
}

let ran = 0;
for (let t = 0; t < TRIALS; t++) {
  const PC = 0x2000 + t * 64; // distinct PC each trial (jsCache keys on PC)
  const words = [];
  const n = 1 + ri(4);
  for (let k = 0; k < n; k++) words.push(...body());
  words.push(...term());
  for (let i = 0; i < words.length; i++) gput(PC + i * 2, 2, words[i] & 0xffff);
  // random reg/flag state
  for (let i = 0; i < 16; i++) dvm.setInt32(REGS + i * 4, r32(), true);
  dvm.setUint32(FLAGS, ri(0x10000), true);
  dvm.setUint32(FLAGS + 4, ri(0x200), true);
  const packed = Module.ejsJitGet(PC) | 0;
  if (packed >= 0) {
    table.get(packed & 0xffffff)(); // run it as the core hook would
    ran++;
  }
}

const st = Module.__ejsJitStats;
console.log("bundle stats:", JSON.stringify(st));
console.log(`slots returned & executed: ${ran}`);
if (!st || st.gateFail > 0) {
  console.log(
    `❌ gateFail=${st ? st.gateFail : "?"} — bundle codegen diverges from bundled interp`,
  );
  process.exit(1);
}
if (st.activated === 0) {
  console.log("❌ nothing activated — bundle not JITing");
  process.exit(1);
}
console.log("✅ bundled ejs-jit.js installs + JITs + parity-passes (gateFail 0).");
