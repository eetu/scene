// 68k → WASM recompiler (MVP). Translates a decoded straight-line block into a
// single WASM `block()` function that operates on the register file in the
// core's shared linear memory — Dn lives at byte offset n*4, read/written with
// i32.load/i32.store (base address 0, memarg offset = n*4). This is the same
// substrate proven in ../spike (runtime module, imported memory, growable table);
// here we generate the block body from real 68k instructions.
import * as w from "../spike/emit.mjs";

const REG = (n) => n * 4; // byte offset of Dn in the register file

// load Dn onto the stack: (i32.const 0) (i32.load offset=n*4)
const loadReg = (n) => [w.op.i32Const(0), w.op.i32Load(REG(n))];
// the address slot for a store into Dn is just base 0 (offset carries n*4)
const storeAddr = () => w.op.i32Const(0);

/** Emit the WASM instruction bytes for one decoded 68k instruction. */
function emitInstr(it) {
  switch (it.op) {
    case "moveq": // Dn = sign-extended imm8
      return [storeAddr(), w.op.i32Const(it.imm), w.op.i32Store(REG(it.dn))];
    case "addq": // Dn = Dn + imm
      return [
        storeAddr(),
        ...loadReg(it.dn),
        w.op.i32Const(it.imm),
        w.op.i32Add(),
        w.op.i32Store(REG(it.dn)),
      ];
    case "add": // Dx = Dx + Dy
      return [
        storeAddr(),
        ...loadReg(it.dx),
        ...loadReg(it.dy),
        w.op.i32Add(),
        w.op.i32Store(REG(it.dx)),
      ];
    case "sub": // Dx = Dx - Dy
      return [
        storeAddr(),
        ...loadReg(it.dx),
        ...loadReg(it.dy),
        w.op.i32Sub(),
        w.op.i32Store(REG(it.dx)),
      ];
    default:
      throw new Error(`recompile: unhandled ${it.op}`);
  }
}

/** Build a WASM module exporting block():void, importing env.memory. */
export function recompile(instrs) {
  const types = w.section(w.S.TYPE, w.vec([w.funcType([], [])]));
  const imports = w.section(
    w.S.IMPORT,
    w.vec([w.concat(w.str("env"), w.str("memory"), [0x02], w.memType({ min: 1 }))]),
  );
  const funcs = w.section(w.S.FUNC, w.vec([w.uleb(0)]));
  const exports = w.section(w.S.EXPORT, w.vec([w.concat(w.str("block"), [0x00], w.uleb(0))]));
  const instrBytes = instrs.flatMap(emitInstr);
  const code = w.section(w.S.CODE, w.vec([w.body([], instrBytes)]));
  return w.module([types, imports, funcs, exports, code]);
}
