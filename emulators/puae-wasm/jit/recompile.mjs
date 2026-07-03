// 68k → WASM recompiler (MVP: ALU register ops + MOVE/MOVEA with EA modes and
// CCR flags). Emits a WASM block() operating on shared linear memory laid out per
// layout.mjs. Guest RAM access inlines as (GUEST_BASE + (addr & RAM_MASK)) load/
// store — see layout.mjs on the (temporary) little-endian cell model. Substrate
// proven in ../spike + ../phase1-abi; codegen via ../spike/emit.mjs.
import * as w from "../spike/emit.mjs";
import * as L from "./layout.mjs";
import { isMem } from "./decode.mjs";

// scratch locals
const LA = 0,
  LB = 1,
  LRES = 2,
  LADDR = 3,
  LADDR2 = 4;

const c0 = () => w.op.i32Const(0);
const loadD = (n) => [c0(), w.op.i32Load(L.DREG(n))];
const loadA = (n) => [c0(), w.op.i32Load(L.AREG(n))];
const storeAt = (off, expr) => [c0(), ...expr, w.op.i32Store(off)];

// ── CCR flag terms (each pushes one i32) ──
const termN = (l) => [
  w.op.localGet(l),
  w.op.i32Const(31),
  w.op.i32ShrU(),
  w.op.i32Const(3),
  w.op.i32Shl(),
];
const termZ = (l) => [w.op.localGet(l), w.op.i32Eqz(), w.op.i32Const(2), w.op.i32Shl()];
const cAdd = () => [w.op.localGet(LRES), w.op.localGet(LA), w.op.i32LtU()];
const cSub = () => [w.op.localGet(LA), w.op.localGet(LB), w.op.i32LtU()];
const shl = (expr, n) => [...expr, w.op.i32Const(n), w.op.i32Shl()];
const vBit = (bytes) => [
  ...bytes,
  w.op.i32Const(31),
  w.op.i32ShrU(),
  w.op.i32Const(1),
  w.op.i32Shl(),
];
const vAdd = () =>
  vBit([
    ...[w.op.localGet(LA), w.op.localGet(LRES), w.op.i32Xor()],
    ...[w.op.localGet(LB), w.op.localGet(LRES), w.op.i32Xor()],
    w.op.i32And(),
  ]);
const vSub = () =>
  vBit([
    ...[w.op.localGet(LA), w.op.localGet(LB), w.op.i32Xor()],
    ...[w.op.localGet(LA), w.op.localGet(LRES), w.op.i32Xor()],
    w.op.i32And(),
  ]);
const orAll = (terms) =>
  terms.slice(1).reduce((acc, t) => [...acc, ...t, ...w.op.i32Or()], [...terms[0]]);
const xOld = () => [c0(), w.op.i32Load(L.CCR_OFF), w.op.i32Const(16), w.op.i32And()];
const ccrAdd = () => orAll([termN(LRES), termZ(LRES), vAdd(), cAdd(), shl(cAdd(), 4)]);
const ccrSub = () => orAll([termN(LRES), termZ(LRES), vSub(), cSub(), shl(cSub(), 4)]);
const ccrMoveNZ = () => orAll([xOld(), termN(LRES), termZ(LRES)]); // NZ, V=C=0, X preserved
const ccrCmp = () => orAll([xOld(), termN(LRES), termZ(LRES), vSub(), cSub()]); // like sub, X preserved

// ── effective address → compute guest addr into local `dst` (with side effects) ──
function eaAddr(ea, dst) {
  const set = (bytes) => [...bytes, w.op.localSet(dst)];
  switch (ea.ea) {
    case "ind":
      return set(loadA(ea.n));
    case "pinc":
      return [
        ...set(loadA(ea.n)),
        ...storeAt(L.AREG(ea.n), [...loadA(ea.n), w.op.i32Const(4), w.op.i32Add()]),
      ];
    case "pdec":
      return [
        ...storeAt(L.AREG(ea.n), [...loadA(ea.n), w.op.i32Const(4), w.op.i32Sub()]),
        ...set(loadA(ea.n)),
      ];
    case "disp":
      return set([...loadA(ea.n), w.op.i32Const(ea.d), w.op.i32Add()]);
    case "abs":
      return set([w.op.i32Const(ea.addr)]);
    default:
      throw new Error(`eaAddr: not memory (${ea.ea})`);
  }
}
// guest addr in local `l` → linear address expr for i32.load/store
const lin = (l) => [
  w.op.localGet(l),
  w.op.i32Const(L.RAM_MASK),
  w.op.i32And(),
  w.op.i32Const(L.GUEST_BASE),
  w.op.i32Add(),
];
const memLoad = (l) => [...lin(l), w.op.i32Load(0)];
const memStore = (l, valExpr) => [...lin(l), ...valExpr, w.op.i32Store(0)];

// value of a source EA (its address already computed into `l` if memory)
function srcVal(ea, l) {
  switch (ea.ea) {
    case "d":
      return loadD(ea.n);
    case "a":
      return loadA(ea.n);
    case "imm":
      return [w.op.i32Const(ea.val)];
    default:
      return memLoad(l);
  }
}

function emitInstr(it) {
  switch (it.op) {
    case "moveq":
      return [
        w.op.i32Const(it.imm),
        w.op.localSet(LRES),
        ...storeAt(L.DREG(it.dn), [w.op.localGet(LRES)]),
        ...storeAt(L.CCR_OFF, ccrMoveNZ()),
      ];
    case "addq":
      return [
        ...loadD(it.dn),
        w.op.localSet(LA),
        w.op.i32Const(it.imm),
        w.op.localSet(LB),
        w.op.localGet(LA),
        w.op.localGet(LB),
        w.op.i32Add(),
        w.op.localSet(LRES),
        ...storeAt(L.DREG(it.dn), [w.op.localGet(LRES)]),
        ...storeAt(L.CCR_OFF, ccrAdd()),
      ];
    case "add":
      return [
        ...loadD(it.dx),
        w.op.localSet(LA),
        ...loadD(it.dy),
        w.op.localSet(LB),
        w.op.localGet(LA),
        w.op.localGet(LB),
        w.op.i32Add(),
        w.op.localSet(LRES),
        ...storeAt(L.DREG(it.dx), [w.op.localGet(LRES)]),
        ...storeAt(L.CCR_OFF, ccrAdd()),
      ];
    case "sub":
      return [
        ...loadD(it.dx),
        w.op.localSet(LA),
        ...loadD(it.dy),
        w.op.localSet(LB),
        w.op.localGet(LA),
        w.op.localGet(LB),
        w.op.i32Sub(),
        w.op.localSet(LRES),
        ...storeAt(L.DREG(it.dx), [w.op.localGet(LRES)]),
        ...storeAt(L.CCR_OFF, ccrSub()),
      ];
    case "and":
    case "or":
    case "eor": {
      // AND/OR write Dx; EOR writes Dy. res = a OP b; N,Z; V=C=0; X preserved.
      const dst = it.op === "eor" ? it.dy : it.dx;
      const other = it.op === "eor" ? it.dx : it.dy;
      const bit = it.op === "and" ? w.op.i32And() : it.op === "or" ? w.op.i32Or() : w.op.i32Xor();
      return [
        ...loadD(dst),
        w.op.localSet(LA),
        ...loadD(other),
        w.op.localSet(LB),
        w.op.localGet(LA),
        w.op.localGet(LB),
        ...[bit],
        w.op.localSet(LRES),
        ...storeAt(L.DREG(dst), [w.op.localGet(LRES)]),
        ...storeAt(L.CCR_OFF, ccrMoveNZ()),
      ];
    }
    case "cmp": // Dx - Dy, flags only (no writeback), X preserved
      return [
        ...loadD(it.dx),
        w.op.localSet(LA),
        ...loadD(it.dy),
        w.op.localSet(LB),
        w.op.localGet(LA),
        w.op.localGet(LB),
        w.op.i32Sub(),
        w.op.localSet(LRES),
        ...storeAt(L.CCR_OFF, ccrCmp()),
      ];
    case "not": // Dn = ~Dn; N,Z; V=C=0; X preserved
      return [
        ...loadD(it.dn),
        w.op.i32Const(-1),
        w.op.i32Xor(),
        w.op.localSet(LRES),
        ...storeAt(L.DREG(it.dn), [w.op.localGet(LRES)]),
        ...storeAt(L.CCR_OFF, ccrMoveNZ()),
      ];
    case "neg": // Dn = 0 - Dn; flags like SUB(0,Dn) (X:=C)
      return [
        w.op.i32Const(0),
        w.op.localSet(LA),
        ...loadD(it.dn),
        w.op.localSet(LB),
        w.op.localGet(LA),
        w.op.localGet(LB),
        w.op.i32Sub(),
        w.op.localSet(LRES),
        ...storeAt(L.DREG(it.dn), [w.op.localGet(LRES)]),
        ...storeAt(L.CCR_OFF, ccrSub()),
      ];
    case "move": {
      const code = [];
      if (isMem(it.src)) code.push(...eaAddr(it.src, LADDR));
      if (isMem(it.dst)) code.push(...eaAddr(it.dst, LADDR2));
      code.push(...srcVal(it.src, LADDR), w.op.localSet(LRES)); // value → LRES
      if (it.dst.ea === "d") code.push(...storeAt(L.DREG(it.dst.n), [w.op.localGet(LRES)]));
      else code.push(...memStore(LADDR2, [w.op.localGet(LRES)]));
      code.push(...storeAt(L.CCR_OFF, ccrMoveNZ()));
      return code;
    }
    case "movea": {
      const code = [];
      if (isMem(it.src)) code.push(...eaAddr(it.src, LADDR));
      code.push(...storeAt(L.AREG(it.dst.n), srcVal(it.src, LADDR))); // no flags
      return code;
    }
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
  const code = w.section(w.S.CODE, w.vec([w.body([{ count: 5, type: w.I32 }], instrBytes)]));
  return w.module([types, imports, funcs, exports, code]);
}
