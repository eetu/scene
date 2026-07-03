// Reference 68k interpreter for the MVP subset — the ORACLE the recompiler is
// validated against (jit/difftest.mjs). Operates on a register file of 8 data
// registers D0..D7 as an Int32Array (index n = Dn). `| 0` keeps everything in
// signed 32-bit, matching both 68k .L wrapping and WASM i32.
import { decodeOne } from "./decode.mjs";

/** Run a block of opcode words against regs (Int32Array, len ≥ 8), in place. */
export function runInterp(words, regs) {
  for (const w of words) {
    const d = decodeOne(w);
    switch (d.op) {
      case "moveq":
        regs[d.dn] = d.imm | 0;
        break;
      case "addq":
        regs[d.dn] = (regs[d.dn] + d.imm) | 0;
        break;
      case "add":
        regs[d.dx] = (regs[d.dx] + regs[d.dy]) | 0;
        break;
      case "sub":
        regs[d.dx] = (regs[d.dx] - regs[d.dy]) | 0;
        break;
      default:
        throw new Error(`interp: unhandled ${d.op}`);
    }
  }
}
