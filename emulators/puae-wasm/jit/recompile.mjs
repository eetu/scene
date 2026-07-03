// 68k → WASM recompiler (MVP + CCR flags). Translates a decoded straight-line
// block into a WASM `block()` that operates on the register file in the core's
// shared linear memory: Dn at byte offset n*4, CCR at byte offset 64 (bits
// X=16 N=8 Z=4 V=2 C=1). Uses 3 scratch locals (a, b, res). Substrate proven in
// ../spike + ../phase1-abi; codegen via ../spike/emit.mjs.
import * as w from "../spike/emit.mjs";

const REG = (n) => n * 4; // byte offset of Dn
const CCR_OFF = 64; // byte offset of CCR
const LA = 0,
  LB = 1,
  LRES = 2; // scratch local indices

const loadReg = (n) => [w.op.i32Const(0), w.op.i32Load(REG(n))];
// store the single value produced by `expr` into memory offset `off`
const storeAt = (off, expr) => [w.op.i32Const(0), ...expr, w.op.i32Store(off)];

// flag terms — each pushes ONE i32 (the flag's bit value or 0)
const termN = (l) => [
  w.op.localGet(l),
  w.op.i32Const(31),
  w.op.i32ShrU(),
  w.op.i32Const(3),
  w.op.i32Shl(),
]; // N=8
const termZ = (l) => [w.op.localGet(l), w.op.i32Eqz(), w.op.i32Const(2), w.op.i32Shl()]; // Z=4
const cAdd = () => [w.op.localGet(LRES), w.op.localGet(LA), w.op.i32LtU()]; // carry: res <u a  → bit0
const cSub = () => [w.op.localGet(LA), w.op.localGet(LB), w.op.i32LtU()]; // borrow: a <u b → bit0
const shl = (expr, n) => [...expr, w.op.i32Const(n), w.op.i32Shl()];
// signed-overflow sign bit → V(=2), from a 32-bit expr whose sign bit is the overflow
const vBit = (exprBytes) => [
  ...exprBytes,
  w.op.i32Const(31),
  w.op.i32ShrU(),
  w.op.i32Const(1),
  w.op.i32Shl(),
];
// add: (a^res)&(b^res)
const vAdd = () =>
  vBit([
    w.op.localGet(LA),
    w.op.localGet(LRES),
    w.op.i32Xor(),
    w.op.localGet(LB),
    w.op.localGet(LRES),
    w.op.i32Xor(),
    w.op.i32And(),
  ]);
// sub: (a^b)&(a^res)
const vSub = () =>
  vBit([
    w.op.localGet(LA),
    w.op.localGet(LB),
    w.op.i32Xor(),
    w.op.localGet(LA),
    w.op.localGet(LRES),
    w.op.i32Xor(),
    w.op.i32And(),
  ]);
// OR a list of one-value exprs together
const orAll = (terms) =>
  terms.slice(1).reduce((acc, t) => [...acc, ...t, ...w.op.i32Or()], [...terms[0]]);
// preserved X (old CCR & 16)
const xOld = () => [w.op.i32Const(0), w.op.i32Load(CCR_OFF), w.op.i32Const(16), w.op.i32And()];

const ccrAdd = () => orAll([termN(LRES), termZ(LRES), vAdd(), cAdd(), shl(cAdd(), 4)]); // X = C<<4
const ccrSub = () => orAll([termN(LRES), termZ(LRES), vSub(), cSub(), shl(cSub(), 4)]);

function emitInstr(it) {
  switch (it.op) {
    case "moveq": // Dn = imm; N,Z from result; V=C=0; X preserved
      return [
        w.op.i32Const(it.imm),
        w.op.localSet(LRES),
        ...storeAt(REG(it.dn), [w.op.localGet(LRES)]),
        ...storeAt(CCR_OFF, orAll([xOld(), termN(LRES), termZ(LRES)])),
      ];
    case "addq": // Dn = Dn + imm
      return [
        ...loadReg(it.dn),
        w.op.localSet(LA),
        w.op.i32Const(it.imm),
        w.op.localSet(LB),
        w.op.localGet(LA),
        w.op.localGet(LB),
        w.op.i32Add(),
        w.op.localSet(LRES),
        ...storeAt(REG(it.dn), [w.op.localGet(LRES)]),
        ...storeAt(CCR_OFF, ccrAdd()),
      ];
    case "add": // Dx = Dx + Dy
      return [
        ...loadReg(it.dx),
        w.op.localSet(LA),
        ...loadReg(it.dy),
        w.op.localSet(LB),
        w.op.localGet(LA),
        w.op.localGet(LB),
        w.op.i32Add(),
        w.op.localSet(LRES),
        ...storeAt(REG(it.dx), [w.op.localGet(LRES)]),
        ...storeAt(CCR_OFF, ccrAdd()),
      ];
    case "sub": // Dx = Dx - Dy
      return [
        ...loadReg(it.dx),
        w.op.localSet(LA),
        ...loadReg(it.dy),
        w.op.localSet(LB),
        w.op.localGet(LA),
        w.op.localGet(LB),
        w.op.i32Sub(),
        w.op.localSet(LRES),
        ...storeAt(REG(it.dx), [w.op.localGet(LRES)]),
        ...storeAt(CCR_OFF, ccrSub()),
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
  const code = w.section(w.S.CODE, w.vec([w.body([{ count: 3, type: w.I32 }], instrBytes)]));
  return w.module([types, imports, funcs, exports, code]);
}
