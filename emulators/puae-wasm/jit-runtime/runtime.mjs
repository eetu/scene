// Browser-side JIT driver for the M1 core — the last-mile substrate that the
// EM_JS hook (`Module.ejsJitGet(pc)`) delegates to. This is the object under
// test: it must reach the real core Module, read the R0 ABI, emit a block with
// the SAME codegen validated in Node (jit/coretarget.mjs), install it into the
// core's __indirect_function_table, and have it correctly mutate the real 68k
// register file + md-generic flags living in the core's linear memory.
//
// Step-2a scope: prove that whole path IN-SITU (inside a booted demo) with a
// one-shot, NON-DESTRUCTIVE self-test — snapshot the real regs/flags, run a
// known reg-only block against them, verify vs the oracle, restore. Then return
// -1 forever so the demo keeps running on the interpreter. Step 2b makes
// ejsJitGet actually decode+compile the guest block at `pc` and return its slot.
import { recompileCore } from "../jit/coretarget.mjs";

// md-generic flag pack (matches jit/coretarget.mjs + jit/coretest.mjs):
//   cznv = N<<15 | Z<<14 | C<<8 | V<<0 ; x = C<<8
const packCznv = (n, z, v, c) => ((n << 15) | (z << 14) | (c << 8) | (v << 0)) >>> 0;

// JS oracle for the reg-only op subset the self-test uses (moveq/add/sub).
// Mirrors coretarget semantics exactly; the program is self-initialising so the
// result is independent of the live reg state (we compare the live file to this).
function oracle(prog) {
  const D = new Int32Array(8);
  let cznv = 0,
    x = 0;
  const nz = (r) => packCznv(r < 0 ? 1 : 0, r === 0 ? 1 : 0, 0, 0);
  for (const it of prog) {
    if (it.op === "moveq") {
      D[it.dn] = it.imm | 0;
      cznv = nz(D[it.dn]); // X preserved
    } else if (it.op === "add" || it.op === "sub") {
      const a = D[it.dx],
        b = D[it.dy];
      const res = (it.op === "add" ? a + b : a - b) | 0;
      const c = it.op === "add" ? (res >>> 0 < a >>> 0 ? 1 : 0) : a >>> 0 < b >>> 0 ? 1 : 0;
      const v = (it.op === "add" ? ((a ^ res) & (b ^ res)) < 0 : ((a ^ b) & (a ^ res)) < 0) ? 1 : 0;
      D[it.dx] = res;
      cznv = packCznv(res < 0 ? 1 : 0, res === 0 ? 1 : 0, v, c);
      x = (c << 8) >>> 0;
    } else throw new Error(`oracle: unhandled ${it.op}`);
  }
  const writes = {};
  for (const it of prog) writes[it.dn ?? it.dx] = true;
  return { D, cznv, x, wrote: Object.keys(writes).map(Number) };
}

// A deterministic, self-initialising reg-only program that exercises N/Z/C/V/X.
const SELFTEST_PROG = [
  { op: "moveq", dn: 1, imm: -1 }, // D1 = -1
  { op: "moveq", dn: 2, imm: 1 }, // D2 = 1
  { op: "add", dx: 2, dy: 1 }, // D2 = 0  → Z=1,C=1,X=1,N=0,V=0
  { op: "moveq", dn: 3, imm: 0x40 }, // D3 = 0x40
  { op: "sub", dx: 3, dy: 1 }, // D3 = 0x41 → N=0,Z=0,C=1,V=0,X=1
];

function runSelfTest(Module) {
  const detail = { step: "start" };
  try {
    const regsBase = Module._jit_abi_regs() >>> 0;
    const flagsBase = Module._jit_abi_regflags() >>> 0;
    const pcBase = Module._jit_abi_pc ? Module._jit_abi_pc() >>> 0 : 0;
    detail.abi = { regsBase, flagsBase, pcBase };

    const table = Module.wasmTable;
    const mem = Module.wasmMemory;
    if (!table || !table.grow) throw new Error("no growable wasmTable");
    if (!mem || !mem.buffer) throw new Error("no wasmMemory");

    // snapshot the real regs[0..63] + regflags[0..7] so the demo is undisturbed
    const dv = new DataView(mem.buffer);
    const snap = new Uint8Array(72);
    for (let i = 0; i < 64; i++) snap[i] = dv.getUint8(regsBase + i);
    for (let i = 0; i < 8; i++) snap[64 + i] = dv.getUint8(flagsBase + i);

    // emit + install the block using the exact Node-validated codegen. Tiny
    // module → synchronous WebAssembly.Module/Instance (allowed on main thread).
    const bytes = recompileCore(SELFTEST_PROG, { regsBase, regflagsBase: flagsBase });
    detail.blockBytes = bytes.length;
    const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
      env: { memory: mem, get_long: () => 0, put_long: () => {} }, // unused by this prog
    });
    const idx = table.grow(1);
    table.set(idx, inst.exports.block);
    detail.tableSlot = idx;

    // call it EXACTLY as the core's hook would: a funcref pulled from the table
    const fn = table.get(idx);
    const ret = fn();
    detail.blockReturned = ret;

    // read back what the block wrote to the REAL reg file + flags
    const dv2 = new DataView(mem.buffer);
    const got = {};
    const exp = oracle(SELFTEST_PROG);
    const mism = [];
    for (const n of exp.wrote) {
      const g = dv2.getInt32(regsBase + n * 4, true);
      got[`D${n}`] = g;
      if (g !== exp.D[n]) mism.push(`D${n}=${g} want ${exp.D[n]}`);
    }
    const gotCznv = dv2.getUint32(flagsBase, true) >>> 0;
    const gotX = dv2.getUint32(flagsBase + 4, true) >>> 0;
    // compare only the bits md-generic actually defines (N/Z/C/V mask 0xC101)
    const CZNV_MASK = 0xc101;
    if ((gotCznv & CZNV_MASK) !== (exp.cznv & CZNV_MASK))
      mism.push(`cznv=0x${gotCznv.toString(16)} want 0x${exp.cznv.toString(16)}`);
    if ((gotX & 0x100) !== (exp.x & 0x100))
      mism.push(`x=0x${gotX.toString(16)} want 0x${exp.x.toString(16)}`);
    detail.got = { ...got, cznv: gotCznv, x: gotX };
    detail.expect = { D: [...exp.D], cznv: exp.cznv, x: exp.x };

    // restore the snapshot — demo continues as if nothing happened
    for (let i = 0; i < 64; i++) dv2.setUint8(regsBase + i, snap[i]);
    for (let i = 0; i < 8; i++) dv2.setUint8(flagsBase + i, snap[64 + i]);

    detail.mismatches = mism;
    detail.pass = mism.length === 0;
    detail.step = "done";
    return detail;
  } catch (e) {
    detail.error = String(e && e.stack ? e.stack : e);
    detail.pass = false;
    return detail;
  }
}

// Install the one-shot self-test as ejsJitGet. Returns -1 always (interpreter
// keeps running); the first hook call runs the test and stashes the result.
export function installSelfTest(Module) {
  let ran = false;
  Module.ejsJitGet = (pc) => {
    if (!ran) {
      ran = true;
      window.__jitSelfTest = runSelfTest(Module);
      window.__jitSelfTest.firstPc = pc >>> 0;
      console.log("[jit] self-test:", JSON.stringify(window.__jitSelfTest));
    }
    return -1;
  };
  window.__jitAttached = true;
  console.log("[jit] ejsJitGet self-test installed");
}
