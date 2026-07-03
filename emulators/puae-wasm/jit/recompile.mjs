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
    case "sub":
    case "and":
    case "or":
    case "cmp": {
      // <ea>,Dn: LA = Dn, LB = src value, LRES = LA OP LB. CMP has no writeback.
      const bin =
        it.op === "add"
          ? w.op.i32Add()
          : it.op === "sub" || it.op === "cmp"
            ? w.op.i32Sub()
            : it.op === "and"
              ? w.op.i32And()
              : w.op.i32Or();
      const ccr =
        it.op === "add"
          ? ccrAdd()
          : it.op === "sub"
            ? ccrSub()
            : it.op === "cmp"
              ? ccrCmp()
              : ccrMoveNZ(); // and/or
      const code = [];
      if (isMem(it.src)) code.push(...eaAddr(it.src, LADDR));
      code.push(...loadD(it.dn), w.op.localSet(LA));
      code.push(...srcVal(it.src, LADDR), w.op.localSet(LB));
      code.push(w.op.localGet(LA), w.op.localGet(LB), bin, w.op.localSet(LRES));
      if (it.op !== "cmp") code.push(...storeAt(L.DREG(it.dn), [w.op.localGet(LRES)]));
      code.push(...storeAt(L.CCR_OFF, ccr));
      return code;
    }
    case "eor": // EOR.L Dx,Dy (Dy ^= Dx); N,Z; V=C=0; X preserved
      return [
        ...loadD(it.dy),
        w.op.localSet(LA),
        ...loadD(it.dx),
        w.op.localSet(LB),
        w.op.localGet(LA),
        w.op.localGet(LB),
        w.op.i32Xor(),
        w.op.localSet(LRES),
        ...storeAt(L.DREG(it.dy), [w.op.localGet(LRES)]),
        ...storeAt(L.CCR_OFF, ccrMoveNZ()),
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

// ── condition codes → 0/1 on the stack (bits shifted down to LSB) ──
const loadCCR = () => [c0(), w.op.i32Load(L.CCR_OFF)];
const bit = (shift) => [
  ...loadCCR(),
  w.op.i32Const(shift),
  w.op.i32ShrU(),
  w.op.i32Const(1),
  w.op.i32And(),
];
const bC = () => [...loadCCR(), w.op.i32Const(1), w.op.i32And()]; // bit 0
const bV = () => bit(1);
const bZ = () => bit(2);
const bN = () => bit(3);
const not = (x) => [...x, w.op.i32Eqz()];
const and2 = (a, b) => [...a, ...b, w.op.i32And()];
const or2 = (a, b) => [...a, ...b, w.op.i32Or()];
const eq2 = (a, b) => [...a, ...b, w.op.i32Eq()];
const ne2 = (a, b) => [...a, ...b, w.op.i32Ne()];
function condExpr(cc) {
  switch (cc) {
    case 0:
      return [w.op.i32Const(1)]; // T
    case 1:
      return [w.op.i32Const(0)]; // F
    case 2:
      return and2(not(bC()), not(bZ())); // HI
    case 3:
      return or2(bC(), bZ()); // LS
    case 4:
      return not(bC()); // CC
    case 5:
      return bC(); // CS
    case 6:
      return not(bZ()); // NE
    case 7:
      return bZ(); // EQ
    case 8:
      return not(bV()); // VC
    case 9:
      return bV(); // VS
    case 10:
      return not(bN()); // PL
    case 11:
      return bN(); // MI
    case 12:
      return eq2(bN(), bV()); // GE
    case 13:
      return ne2(bN(), bV()); // LT
    case 14:
      return and2(not(bZ()), eq2(bN(), bV())); // GT
    default:
      return or2(bZ(), ne2(bN(), bV())); // LE (15)
  }
}
// select(a,b,cond): cond!=0 ? a : b
const sel = (aBytes, bBytes, condBytes) => [...aBytes, ...bBytes, ...condBytes, w.op.select()];

// terminator → bytes that set PC (uses locals LA/LB/LRES, free at block end)
function emitTerminator(term, fallPC) {
  if (!term) return storeAt(L.PC_OFF, [w.op.i32Const(fallPC)]);
  if (term.op === "halt") return storeAt(L.PC_OFF, [w.op.i32Const(L.HALT_PC)]);
  const target = (term.pc + 2 + term.disp) | 0;
  if (term.op === "bcc")
    return storeAt(
      L.PC_OFF,
      sel([w.op.i32Const(target)], [w.op.i32Const(fallPC)], condExpr(term.cc)),
    );
  // dbcc
  const dec = [
    w.op.localGet(LB),
    w.op.i32Const(0xffff0000 | 0),
    w.op.i32And(),
    w.op.localGet(LB),
    w.op.i32Const(1),
    w.op.i32Sub(),
    w.op.i32Const(0xffff),
    w.op.i32And(),
    w.op.i32Or(),
  ];
  const cntNotMinus1 = [
    w.op.localGet(LRES),
    w.op.i32Const(0xffff),
    w.op.i32And(),
    w.op.i32Const(0xffff),
    w.op.i32Ne(),
  ];
  const branchTaken = [...[w.op.localGet(LA), w.op.i32Eqz()], ...cntNotMinus1, w.op.i32And()]; // !cond && cnt!=-1
  return [
    ...condExpr(term.cc),
    w.op.localSet(LA),
    ...loadD(term.dn),
    w.op.localSet(LB),
    ...dec,
    w.op.localSet(LRES),
    ...storeAt(L.DREG(term.dn), [
      w.op.localGet(LB),
      w.op.localGet(LRES),
      w.op.localGet(LA),
      w.op.select(),
    ]), // cond?keep:dec
    ...storeAt(L.PC_OFF, sel([w.op.i32Const(target)], [w.op.i32Const(fallPC)], branchTaken)),
  ];
}

const IMPORTS = () =>
  w.section(
    w.S.IMPORT,
    w.vec([w.concat(w.str("env"), w.str("memory"), [0x02], w.memType({ min: 1 }))]),
  );
function buildModule(bodyBytes) {
  const types = w.section(w.S.TYPE, w.vec([w.funcType([], [])]));
  const funcs = w.section(w.S.FUNC, w.vec([w.uleb(0)]));
  const exports = w.section(w.S.EXPORT, w.vec([w.concat(w.str("block"), [0x00], w.uleb(0))]));
  const code = w.section(w.S.CODE, w.vec([w.body([{ count: 5, type: w.I32 }], bodyBytes)]));
  return w.module([types, IMPORTS(), funcs, exports, code]);
}

/** Straight-line block → WASM module (no PC/terminator). */
export function recompile(instrs) {
  return buildModule(instrs.flatMap(emitInstr));
}

/** Basic block (from blockAt) → WASM module that also sets PC per the terminator. */
export function recompileBlock(block) {
  return buildModule([
    ...block.instrs.flatMap(emitInstr),
    ...emitTerminator(block.term, block.fallPC),
  ]);
}
