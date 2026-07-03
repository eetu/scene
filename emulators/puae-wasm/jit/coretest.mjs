// Differential test for the CORE-TARGETED codegen (coretarget.mjs) — validates
// the real-ABI blocks (register base offset, md-generic flags, imported
// big-endian memory) against a JS oracle over the identical byte layout, in Node
// (fast, no CI/browser). This is the codegen the browser integration will use.
//
//   node coretest.mjs [trials]
import { recompileCore } from "./coretarget.mjs";

const REGS_BASE = 1024; // Dn=+n*4, An=+32+n*4
const FLAGS_BASE = 1024 + 64; // cznv @+0, x @+4
const RAM_BASE = 4096; // guest RAM window for (An) load/store
const RAM_SLOTS = 64;
const abi = { regsBase: REGS_BASE, regflagsBase: FLAGS_BASE };

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const TRIALS = Number(process.argv[2] || 5000);
const rnd = rng(0xabc123);
const ri = (n) => Math.floor(rnd() * n);
const r32 = () => (rnd() * 4294967296) | 0;

// little-endian i32 (registers/flags) + big-endian long (guest memory)
const geLE = (dv, o) => dv.getInt32(o, true);
const seLE = (dv, o, v) => dv.setInt32(o, v, true);
const geBE = (dv, o) => dv.getUint32(o, false) | 0;
const seBE = (dv, o, v) => dv.setUint32(o, v >>> 0, false);

// md-generic flag pack
const packCznv = (n, z, v, c) => ((n << 15) | (z << 14) | (c << 8) | (v << 0)) >>> 0;

// JS oracle over a DataView with the same layout the block mutates
function oracle(prog, dv) {
  const D = (n) => geLE(dv, REGS_BASE + n * 4);
  const A = (n) => geLE(dv, REGS_BASE + 32 + n * 4);
  const setD = (n, x) => seLE(dv, REGS_BASE + n * 4, x | 0);
  const setCznv = (x) => dv.setUint32(FLAGS_BASE, x >>> 0, true);
  const setX = (x) => dv.setUint32(FLAGS_BASE + 4, x >>> 0, true);
  const nzOf = (res) => packCznv(res < 0 ? 1 : 0, res === 0 ? 1 : 0, 0, 0);
  for (const it of prog) {
    if (it.op === "moveq") {
      const res = it.imm | 0;
      setD(it.dn, res);
      setCznv(nzOf(res)); // X preserved
    } else if (it.op === "add" || it.op === "sub") {
      const a = D(it.dx),
        b = D(it.dy);
      const res = (it.op === "add" ? a + b : a - b) | 0;
      setD(it.dx, res);
      const c = it.op === "add" ? (res >>> 0 < a >>> 0 ? 1 : 0) : a >>> 0 < b >>> 0 ? 1 : 0;
      const v = (it.op === "add" ? ((a ^ res) & (b ^ res)) < 0 : ((a ^ b) & (a ^ res)) < 0) ? 1 : 0;
      setCznv(packCznv(res < 0 ? 1 : 0, res === 0 ? 1 : 0, v, c));
      setX((c << 8) >>> 0);
    } else if (it.op === "load") {
      const res = geBE(dv, A(it.an));
      setD(it.dn, res);
      setCznv(nzOf(res));
    } else if (it.op === "store") {
      const val = D(it.dn);
      seBE(dv, A(it.an), val);
      setCznv(nzOf(val));
    }
  }
}

function randProg() {
  const out = [];
  const n = 1 + ri(8);
  for (let i = 0; i < n; i++) {
    switch (ri(5)) {
      case 0:
        out.push({ op: "moveq", dn: ri(8), imm: (ri(256) << 24) >> 24 });
        break;
      case 1:
        out.push({ op: "add", dx: ri(8), dy: ri(8) });
        break;
      case 2:
        out.push({ op: "sub", dx: ri(8), dy: ri(8) });
        break;
      case 3:
        out.push({ op: "load", dn: ri(8), an: ri(8) });
        break;
      default:
        out.push({ op: "store", dn: ri(8), an: ri(8) });
        break;
    }
  }
  return out;
}

function seed(dv) {
  for (let i = 0; i < 8; i++) seLE(dv, REGS_BASE + i * 4, r32()); // D0..D7
  for (let i = 0; i < 8; i++) seLE(dv, REGS_BASE + 32 + i * 4, RAM_BASE + ri(RAM_SLOTS) * 4); // A0..A7 → RAM
  dv.setUint32(FLAGS_BASE, ri(0x10000), true); // cznv
  dv.setUint32(FLAGS_BASE + 4, ri(0x200), true); // x
  for (let i = 0; i < RAM_SLOTS; i++) seBE(dv, RAM_BASE + i * 4, r32()); // guest RAM
}

let pass = 0,
  fail = 0;
const failures = [];
for (let t = 0; t < TRIALS; t++) {
  const prog = randProg();

  // block: fresh wasm memory, seeded; imported big-endian get/put_long over it
  const mem = new WebAssembly.Memory({ initial: 1 });
  const bdv = new DataView(mem.buffer);
  seed(bdv);
  // oracle: a copy of the seeded image
  const odv = new DataView(mem.buffer.slice(0));

  const env = {
    memory: mem,
    get_long: (a) => geBE(bdv, a >>> 0),
    put_long: (a, v) => seBE(bdv, a >>> 0, v),
  };
  const inst = await WebAssembly.instantiate(await WebAssembly.compile(recompileCore(prog, abi)), {
    env,
  });
  inst.exports.block();
  oracle(prog, odv);

  // compare regs (0..63), flags (64..71), and the RAM window
  let ok = true;
  for (let o = REGS_BASE; o < FLAGS_BASE + 8; o += 4)
    if (bdv.getInt32(o, true) !== odv.getInt32(o, true)) ok = false;
  for (let o = RAM_BASE; o < RAM_BASE + RAM_SLOTS * 4; o += 4)
    if (bdv.getInt32(o, true) !== odv.getInt32(o, true)) ok = false;
  if (ok) pass++;
  else {
    fail++;
    if (failures.length < 2) failures.push(prog.map((p) => p.op));
  }
}

console.log(`core-targeted codegen difftest: ${pass}/${TRIALS} passed, ${fail} failed`);
if (fail) {
  console.log(JSON.stringify(failures, null, 2));
  process.exit(1);
}
console.log(
  "✅ real-ABI blocks (reg base + md-generic flags + imported BE memory) match the oracle.",
);
