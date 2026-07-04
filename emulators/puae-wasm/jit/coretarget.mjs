// Core-targeted recompiler — emits blocks against the REAL libretro-uae ABI (as
// resolved in R0), the codegen the browser integration will use:
//   * registers at abi.regsBase (Dn = +n*4, An = +32+n*4), from jit_abi_regs()
//   * flags in md-generic layout at abi.regflagsBase: cznv (u32) N=15 Z=14 C=8 V=0,
//     x (u32) X=8 — the JIT computes N/Z/V/C/X and scatters into that layout
//   * memory via the core's exported wrappers, imported as env.get_long/put_long
//     (banks + big-endian handled by the core)
// Block ABI: () -> i32 (next PC); side-effects regs/regflags/memory in place.
//
// Small op subset for the first integration slice: MOVEQ, ADD/SUB Dy,Dx,
// MOVE.L (An),Dn (load), MOVE.L Dn,(An) (store). Validated by jit/coretest.mjs.
import * as w from "../spike/emit.mjs";

const LA = 0,
  LB = 1,
  LRES = 2;

// imported func indices (2 imports before the block func)
const F_GET = 0,
  F_PUT = 1;

const mkHelpers = (abi) => {
  const rb = abi.regsBase,
    fb = abi.regflagsBase;
  const D = (n) => [w.op.i32Const(rb), w.op.i32Load(n * 4)];
  const A = (n) => [w.op.i32Const(rb), w.op.i32Load(32 + n * 4)];
  const storeD = (n, expr) => [w.op.i32Const(rb), ...expr, w.op.i32Store(n * 4)];
  const shl = (e, n) => [...e, w.op.i32Const(n), w.op.i32Shl()];
  const orAll = (ts) => ts.slice(1).reduce((a, t) => [...a, ...t, ...w.op.i32Or()], [...ts[0]]);
  // 0/1 flag bits from LRES / LA / LB
  const nB = () => [w.op.localGet(LRES), w.op.i32Const(31), w.op.i32ShrU()];
  const zB = () => [w.op.localGet(LRES), w.op.i32Eqz()];
  const cAdd = () => [w.op.localGet(LRES), w.op.localGet(LA), w.op.i32LtU()];
  const cSub = () => [w.op.localGet(LA), w.op.localGet(LB), w.op.i32LtU()];
  const vBit = (bytes) => [...bytes, w.op.i32Const(31), w.op.i32ShrU()];
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
  // md-generic scatter: N<<15 | Z<<14 | C<<8 | V<<0  (V is already bit0)
  const cznvNZ = () => orAll([shl(nB(), 15), shl(zB(), 14)]); // move/moveq: V=C=0
  const cznvAdd = () => orAll([shl(nB(), 15), shl(zB(), 14), shl(cAdd(), 8), vAdd()]);
  const cznvSub = () => orAll([shl(nB(), 15), shl(zB(), 14), shl(cSub(), 8), vSub()]);
  const storeCznv = (e) => [w.op.i32Const(fb), ...e, w.op.i32Store(0)];
  const storeX = (e) => [w.op.i32Const(fb), ...e, w.op.i32Store(4)]; // X at bit8 of regflags.x
  return { D, A, storeD, shl, cAdd, cSub, cznvNZ, cznvAdd, cznvSub, storeCznv, storeX };
};

function emit(it, h) {
  switch (it.op) {
    case "moveq": // Dn=imm; NZ; V=C=0; X preserved
      return [
        w.op.i32Const(it.imm),
        w.op.localSet(LRES),
        ...h.storeD(it.dn, [w.op.localGet(LRES)]),
        ...h.storeCznv(h.cznvNZ()),
      ];
    case "add":
    case "sub": {
      const bin = it.op === "add" ? w.op.i32Add() : w.op.i32Sub();
      const cznv = it.op === "add" ? h.cznvAdd() : h.cznvSub();
      const cbit =
        it.op === "add"
          ? [w.op.localGet(LRES), w.op.localGet(LA), w.op.i32LtU()]
          : [w.op.localGet(LA), w.op.localGet(LB), w.op.i32LtU()];
      return [
        ...h.D(it.dx),
        w.op.localSet(LA),
        ...h.D(it.dy),
        w.op.localSet(LB),
        w.op.localGet(LA),
        w.op.localGet(LB),
        bin,
        w.op.localSet(LRES),
        ...h.storeD(it.dx, [w.op.localGet(LRES)]),
        ...h.storeCznv(cznv),
        ...h.storeX([...cbit, w.op.i32Const(8), w.op.i32Shl()]), // X := C at bit8
      ];
    }
    case "load": // MOVE.L (An),Dn : Dn = get_long(An); NZ; V=C=0; X preserved
      return [
        ...h.A(it.an),
        w.op.call(F_GET),
        w.op.localSet(LRES),
        ...h.storeD(it.dn, [w.op.localGet(LRES)]),
        ...h.storeCznv(h.cznvNZ()),
      ];
    case "store": // MOVE.L Dn,(An) : put_long(An, Dn); NZ from Dn; V=C=0; X preserved
      return [
        ...h.D(it.dn),
        w.op.localSet(LRES),
        ...h.A(it.an),
        w.op.localGet(LRES),
        w.op.call(F_PUT),
        ...h.storeCznv(h.cznvNZ()),
      ];
    default:
      throw new Error(`coretarget: unhandled ${it.op}`);
  }
}

/** Build a block module for the real core ABI. abi = {regsBase, regflagsBase}. */
export function recompileCore(instrs, abi) {
  const h = mkHelpers(abi);
  const body = [...instrs.flatMap((it) => emit(it, h)), w.op.i32Const(0)]; // return dummy next PC
  const types = w.section(
    w.S.TYPE,
    w.vec([w.funcType([w.I32], [w.I32]), w.funcType([w.I32, w.I32], []), w.funcType([], [w.I32])]),
  );
  const imports = w.section(
    w.S.IMPORT,
    w.vec([
      w.concat(w.str("env"), w.str("memory"), [0x02], w.memType({ min: 1 })),
      w.concat(w.str("env"), w.str("get_long"), [0x00], w.uleb(0)), // func type0
      w.concat(w.str("env"), w.str("put_long"), [0x00], w.uleb(1)), // func type1
    ]),
  );
  const funcs = w.section(w.S.FUNC, w.vec([w.uleb(2)])); // block : type2
  const exports = w.section(w.S.EXPORT, w.vec([w.concat(w.str("block"), [0x00], w.uleb(2))])); // func idx 2
  const code = w.section(w.S.CODE, w.vec([w.body([{ count: 3, type: w.I32 }], body)]));
  return w.module([types, imports, funcs, exports, code]);
}
