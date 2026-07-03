// Reference 68k interpreter for the MVP subset — the ORACLE the recompiler is
// validated against (jit/difftest.mjs). Register file is an Int32Array:
//   index 0..7   = D0..D7
//   index 16     = CCR (byte offset 64; bits X=16 N=8 Z=4 V=2 C=1)
// `| 0` keeps everything signed-32, matching 68k .L wrapping and WASM i32.
import { decodeOne } from "./decode.mjs";

export const CCR = 16; // register-file index of the condition codes
export const X = 16,
  N = 8,
  Z = 4,
  V = 2,
  C = 1;

// Flags after a+b (result already truncated). X := C.
function flagsAdd(a, b, res) {
  const c = res >>> 0 < a >>> 0 ? C : 0;
  const v = ((a ^ res) & (b ^ res)) < 0 ? V : 0; // signed-overflow sign bit
  const n = res < 0 ? N : 0;
  const z = res === 0 ? Z : 0;
  return n | z | v | c | (c ? X : 0);
}

// Flags after a-b (result already truncated). X := C(borrow).
function flagsSub(a, b, res) {
  const c = a >>> 0 < b >>> 0 ? C : 0;
  const v = ((a ^ b) & (a ^ res)) < 0 ? V : 0;
  const n = res < 0 ? N : 0;
  const z = res === 0 ? Z : 0;
  return n | z | v | c | (c ? X : 0);
}

/** Run a block of opcode words against regs (Int32Array, len ≥ 17), in place. */
export function runInterp(words, regs) {
  for (const w of words) {
    const d = decodeOne(w);
    switch (d.op) {
      case "moveq": {
        const res = d.imm | 0;
        regs[d.dn] = res;
        // MOVEQ: N,Z from result; V=C=0; X unaffected.
        regs[CCR] = (regs[CCR] & X) | (res < 0 ? N : 0) | (res === 0 ? Z : 0);
        break;
      }
      case "addq": {
        const a = regs[d.dn];
        const res = (a + d.imm) | 0;
        regs[d.dn] = res;
        regs[CCR] = flagsAdd(a, d.imm, res);
        break;
      }
      case "add": {
        const a = regs[d.dx];
        const b = regs[d.dy];
        const res = (a + b) | 0;
        regs[d.dx] = res;
        regs[CCR] = flagsAdd(a, b, res);
        break;
      }
      case "sub": {
        const a = regs[d.dx];
        const b = regs[d.dy];
        const res = (a - b) | 0;
        regs[d.dx] = res;
        regs[CCR] = flagsSub(a, b, res);
        break;
      }
      default:
        throw new Error(`interp: unhandled ${d.op}`);
    }
  }
}
