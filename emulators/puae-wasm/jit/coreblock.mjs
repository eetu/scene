// Block-level recompiler for the REAL libretro-uae ABI — the codegen the browser
// integration actually installs. Merges recompile.mjs's IR coverage (all .L ALU +
// MOVE/MOVEA with EA modes + Bcc/DBcc/BRA terminators) with coretarget.mjs's real
// ABI:
//   * registers at abi.regsBase (Dn=+n*4, An=+32+n*4), from jit_abi_regs()
//   * flags md-generic at abi.regflagsBase: cznv (N=15 Z=14 C=8 V=0) @+0, x (X=8) @+4
//   * guest memory via imported env.get_long/put_long (banks + big-endian in-core)
//
// Block ABI: () -> i32 returning the NEXT guest PC (the M1 hook does m68k_setpc).
// Terminator hand-off: Bcc/DBcc/BRA are compiled (return target/fallPC); JSR/JMP/
// BSR/RTS/RTE/RTR are returned AS the terminator's own PC so the interpreter takes
// the actual transfer (its stack/linkage stays the interpreter's job). A block is
// only worth compiling if it has ≥1 body instr (see jit-runtime installJit).
//
// Validated by jit/coreblocktest.mjs against the reference interpreter (interp.mjs).
import * as w from "../spike/emit.mjs";
import { isMem } from "./decode.mjs";
import * as L from "./layout.mjs";

// scratch locals
const LA = 0,
  LB = 1,
  LRES = 2,
  LADDR = 3,
  LADDR2 = 4;
// imported func indices (2 imports precede the block func)
const F_GET = 0,
  F_PUT = 1;

export function makeCodegen(abi) {
  const rb = abi.regsBase,
    fb = abi.regflagsBase;
  const kb = (n) => w.op.i32Const(rb + n);
  const loadD = (n) => [kb(0), w.op.i32Load(n * 4)];
  const loadA = (n) => [kb(0), w.op.i32Load(32 + n * 4)];
  const storeD = (n, e) => [kb(0), ...e, w.op.i32Store(n * 4)];
  const storeA = (n, e) => [kb(0), ...e, w.op.i32Store(32 + n * 4)];

  // md-generic flag terms (each leaves one i32 packed for cznv)
  const shl = (e, n) => [...e, w.op.i32Const(n), w.op.i32Shl()];
  const orAll = (ts) => ts.slice(1).reduce((a, t) => [...a, ...t, ...w.op.i32Or()], [...ts[0]]);
  const fN = (l) => [
    w.op.localGet(l),
    w.op.i32Const(31),
    w.op.i32ShrU(),
    w.op.i32Const(15),
    w.op.i32Shl(),
  ]; // N<<15
  const fZ = (l) => [w.op.localGet(l), w.op.i32Eqz(), w.op.i32Const(14), w.op.i32Shl()]; // Z<<14
  const cAdd = () => [w.op.localGet(LRES), w.op.localGet(LA), w.op.i32LtU()];
  const cSub = () => [w.op.localGet(LA), w.op.localGet(LB), w.op.i32LtU()];
  const vAdd = () => [
    w.op.localGet(LA),
    w.op.localGet(LRES),
    w.op.i32Xor(),
    w.op.localGet(LB),
    w.op.localGet(LRES),
    w.op.i32Xor(),
    w.op.i32And(),
    w.op.i32Const(31),
    w.op.i32ShrU(), // V at bit0
  ];
  const vSub = () => [
    w.op.localGet(LA),
    w.op.localGet(LB),
    w.op.i32Xor(),
    w.op.localGet(LA),
    w.op.localGet(LRES),
    w.op.i32Xor(),
    w.op.i32And(),
    w.op.i32Const(31),
    w.op.i32ShrU(),
  ];
  const cznvNZ = () => orAll([fN(LRES), fZ(LRES)]); // V=C=0
  const cznvAdd = () => orAll([fN(LRES), fZ(LRES), shl(cAdd(), 8), vAdd()]);
  const cznvSub = () => orAll([fN(LRES), fZ(LRES), shl(cSub(), 8), vSub()]);
  const storeCznv = (e) => [w.op.i32Const(fb), ...e, w.op.i32Store(0)];
  const storeXfrom = (cbit) => [
    w.op.i32Const(fb),
    ...cbit,
    w.op.i32Const(8),
    w.op.i32Shl(),
    w.op.i32Store(4),
  ];

  // effective address → guest addr into local `dst` (with (An)+/-(An) side effects)
  function eaAddr(ea, dst) {
    const set = (bytes) => [...bytes, w.op.localSet(dst)];
    switch (ea.ea) {
      case "ind":
        return set(loadA(ea.n));
      case "pinc":
        return [
          ...set(loadA(ea.n)),
          ...storeA(ea.n, [...loadA(ea.n), w.op.i32Const(4), w.op.i32Add()]),
        ];
      case "pdec":
        return [
          ...storeA(ea.n, [...loadA(ea.n), w.op.i32Const(4), w.op.i32Sub()]),
          ...set(loadA(ea.n)),
        ];
      case "disp":
        return set([...loadA(ea.n), w.op.i32Const(ea.d), w.op.i32Add()]);
      case "abs":
        return set([w.op.i32Const(ea.addr)]);
      default:
        throw new Error(`coreblock eaAddr: not memory (${ea.ea})`);
    }
  }
  const memLoad = (l) => [w.op.localGet(l), w.op.call(F_GET)];
  const memStore = (l, valExpr) => [w.op.localGet(l), ...valExpr, w.op.call(F_PUT)];
  const srcVal = (ea, l) => {
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
  };

  function emitInstr(it) {
    switch (it.op) {
      case "nop":
        return [];
      case "moveq":
        return [
          w.op.i32Const(it.imm),
          w.op.localSet(LRES),
          ...storeD(it.dn, [w.op.localGet(LRES)]),
          ...storeCznv(cznvNZ()),
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
          ...storeD(it.dn, [w.op.localGet(LRES)]),
          ...storeCznv(cznvAdd()),
          ...storeXfrom(cAdd()),
        ];
      case "add":
      case "sub":
      case "and":
      case "or":
      case "cmp": {
        const bin =
          it.op === "add"
            ? w.op.i32Add()
            : it.op === "sub" || it.op === "cmp"
              ? w.op.i32Sub()
              : it.op === "and"
                ? w.op.i32And()
                : w.op.i32Or();
        const code = [];
        if (isMem(it.src)) code.push(...eaAddr(it.src, LADDR));
        code.push(...loadD(it.dn), w.op.localSet(LA));
        code.push(...srcVal(it.src, LADDR), w.op.localSet(LB));
        code.push(w.op.localGet(LA), w.op.localGet(LB), bin, w.op.localSet(LRES));
        if (it.op !== "cmp") code.push(...storeD(it.dn, [w.op.localGet(LRES)]));
        if (it.op === "add") code.push(...storeCznv(cznvAdd()), ...storeXfrom(cAdd()));
        else if (it.op === "sub") code.push(...storeCznv(cznvSub()), ...storeXfrom(cSub()));
        else if (it.op === "cmp")
          code.push(...storeCznv(cznvSub())); // X preserved
        else code.push(...storeCznv(cznvNZ())); // and/or
        return code;
      }
      case "eor":
        return [
          ...loadD(it.dy),
          w.op.localSet(LA),
          ...loadD(it.dx),
          w.op.localSet(LB),
          w.op.localGet(LA),
          w.op.localGet(LB),
          w.op.i32Xor(),
          w.op.localSet(LRES),
          ...storeD(it.dy, [w.op.localGet(LRES)]),
          ...storeCznv(cznvNZ()),
        ];
      case "eori":
        return [
          ...loadD(it.dn),
          w.op.i32Const(it.imm),
          w.op.i32Xor(),
          w.op.localSet(LRES),
          ...storeD(it.dn, [w.op.localGet(LRES)]),
          ...storeCznv(cznvNZ()),
        ];
      case "not":
        return [
          ...loadD(it.dn),
          w.op.i32Const(-1),
          w.op.i32Xor(),
          w.op.localSet(LRES),
          ...storeD(it.dn, [w.op.localGet(LRES)]),
          ...storeCznv(cznvNZ()),
        ];
      case "neg":
        return [
          w.op.i32Const(0),
          w.op.localSet(LA),
          ...loadD(it.dn),
          w.op.localSet(LB),
          w.op.localGet(LA),
          w.op.localGet(LB),
          w.op.i32Sub(),
          w.op.localSet(LRES),
          ...storeD(it.dn, [w.op.localGet(LRES)]),
          ...storeCznv(cznvSub()),
          ...storeXfrom(cSub()),
        ];
      case "asl":
      case "lsl":
      case "asr":
      case "lsr": {
        const n = it.cnt;
        const left = it.op === "asl" || it.op === "lsl";
        const shift = left ? w.op.i32Shl() : it.op === "asr" ? w.op.i32ShrS() : w.op.i32ShrU();
        const cBit = left
          ? [
              w.op.localGet(LA),
              w.op.i32Const(32 - n),
              w.op.i32ShrU(),
              w.op.i32Const(1),
              w.op.i32And(),
            ]
          : [
              w.op.localGet(LA),
              w.op.i32Const(n - 1),
              w.op.i32ShrU(),
              w.op.i32Const(1),
              w.op.i32And(),
            ];
        // ASL V: set if top n+1 bits not all equal (sar(val,31-n) ∉ {0,-1}); else 0
        const top = [w.op.localGet(LA), w.op.i32Const(31 - n), w.op.i32ShrS()];
        const vTerm =
          it.op === "asl"
            ? [
                ...[...top, w.op.i32Eqz()],
                ...[...top, w.op.i32Const(-1), w.op.i32Eq()],
                w.op.i32Or(),
                w.op.i32Eqz(), // 1 if NOT all-equal → V=1
              ]
            : [w.op.i32Const(0)];
        return [
          ...loadD(it.dn),
          w.op.localSet(LA),
          w.op.localGet(LA),
          w.op.i32Const(n),
          shift,
          w.op.localSet(LRES),
          ...storeD(it.dn, [w.op.localGet(LRES)]),
          ...storeCznv(orAll([fN(LRES), fZ(LRES), shl(cBit, 8), vTerm])),
          ...storeXfrom(cBit),
        ];
      }
      case "tst": {
        const code = [];
        if (isMem(it.src)) code.push(...eaAddr(it.src, LADDR));
        code.push(...srcVal(it.src, LADDR), w.op.localSet(LRES));
        code.push(...storeCznv(cznvNZ()));
        return code;
      }
      case "clr": {
        const code = [];
        if (isMem(it.dst)) code.push(...eaAddr(it.dst, LADDR));
        if (it.dst.ea === "d") code.push(...storeD(it.dst.n, [w.op.i32Const(0)]));
        else code.push(...memStore(LADDR, [w.op.i32Const(0)]));
        code.push(...storeCznv([w.op.i32Const(1 << 14)])); // Z=1, N=V=C=0; X preserved
        return code;
      }
      case "adda":
      case "suba": {
        const bin = it.op === "adda" ? w.op.i32Add() : w.op.i32Sub();
        const code = [];
        if (isMem(it.src)) code.push(...eaAddr(it.src, LADDR));
        code.push(...storeA(it.an, [...loadA(it.an), ...srcVal(it.src, LADDR), bin])); // no flags
        return code;
      }
      case "cmpa": {
        const code = [];
        if (isMem(it.src)) code.push(...eaAddr(it.src, LADDR));
        code.push(...loadA(it.an), w.op.localSet(LA));
        code.push(...srcVal(it.src, LADDR), w.op.localSet(LB));
        code.push(w.op.localGet(LA), w.op.localGet(LB), w.op.i32Sub(), w.op.localSet(LRES));
        code.push(...storeCznv(cznvSub())); // X preserved
        return code;
      }
      case "lea":
        return [...eaAddr(it.src, LADDR), ...storeA(it.an, [w.op.localGet(LADDR)])];
      case "ext":
        return [
          ...loadD(it.dn),
          w.op.i32Const(16),
          w.op.i32Shl(),
          w.op.i32Const(16),
          w.op.i32ShrS(),
          w.op.localSet(LRES),
          ...storeD(it.dn, [w.op.localGet(LRES)]),
          ...storeCznv(cznvNZ()),
        ];
      case "swap":
        return [
          ...loadD(it.dn),
          w.op.localSet(LA),
          w.op.localGet(LA),
          w.op.i32Const(16),
          w.op.i32ShrU(),
          w.op.localGet(LA),
          w.op.i32Const(16),
          w.op.i32Shl(),
          w.op.i32Or(),
          w.op.localSet(LRES),
          ...storeD(it.dn, [w.op.localGet(LRES)]),
          ...storeCznv(cznvNZ()),
        ];
      case "move": {
        const code = [];
        if (isMem(it.src)) code.push(...eaAddr(it.src, LADDR));
        if (isMem(it.dst)) code.push(...eaAddr(it.dst, LADDR2));
        code.push(...srcVal(it.src, LADDR), w.op.localSet(LRES));
        if (it.dst.ea === "d") code.push(...storeD(it.dst.n, [w.op.localGet(LRES)]));
        else code.push(...memStore(LADDR2, [w.op.localGet(LRES)]));
        code.push(...storeCznv(cznvNZ()));
        return code;
      }
      case "movea": {
        const code = [];
        if (isMem(it.src)) code.push(...eaAddr(it.src, LADDR));
        code.push(...storeA(it.dst.n, srcVal(it.src, LADDR))); // no flags
        return code;
      }
      default:
        throw new Error(`coreblock: unhandled ${it.op}`);
    }
  }

  // ── condition codes → 0/1 on stack, reading md-generic cznv @ fb ──
  const loadCznv = () => [w.op.i32Const(fb), w.op.i32Load(0)];
  const bitAt = (shift) => [
    ...loadCznv(),
    w.op.i32Const(shift),
    w.op.i32ShrU(),
    w.op.i32Const(1),
    w.op.i32And(),
  ];
  const bC = () => bitAt(8);
  const bV = () => [...loadCznv(), w.op.i32Const(1), w.op.i32And()];
  const bZ = () => bitAt(14);
  const bN = () => bitAt(15);
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
  const sel = (a, b, cond) => [...a, ...b, ...cond, w.op.select()]; // cond?a:b

  // Terminator → an i32 expression: the NEXT guest PC (function return value).
  function emitTerminator(term, fallPC) {
    if (!term) return [w.op.i32Const(fallPC)];
    // control transfers we don't compile → hand the terminator to the interpreter
    if (["jsr", "jmp", "bsr", "rts", "rte", "rtr"].includes(term.op))
      return [w.op.i32Const(term.pc | 0)];
    if (term.op === "halt") return [w.op.i32Const(L.HALT_PC)];
    const target = (term.pc + 2 + term.disp) | 0;
    if (term.op === "bcc")
      return sel([w.op.i32Const(target)], [w.op.i32Const(fallPC)], condExpr(term.cc));
    // dbcc: if cond → fall through; else Dn.w-- and branch unless it wrapped (-1)
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
    const branchTaken = [...[w.op.localGet(LA), w.op.i32Eqz()], ...cntNotMinus1, w.op.i32And()];
    return [
      ...condExpr(term.cc),
      w.op.localSet(LA),
      ...loadD(term.dn),
      w.op.localSet(LB),
      ...dec,
      w.op.localSet(LRES),
      ...storeD(term.dn, [
        w.op.localGet(LB),
        w.op.localGet(LRES),
        w.op.localGet(LA),
        w.op.select(),
      ]),
      ...sel([w.op.i32Const(target)], [w.op.i32Const(fallPC)], branchTaken),
    ];
  }

  return { emitInstr, emitTerminator, condExpr };
}

// module scaffold: imports get_long:(i32)->i32, put_long:(i32,i32)->(), memory; block:()->i32
function buildModule(bodyBytes) {
  const types = w.section(
    w.S.TYPE,
    w.vec([w.funcType([w.I32], [w.I32]), w.funcType([w.I32, w.I32], []), w.funcType([], [w.I32])]),
  );
  const imports = w.section(
    w.S.IMPORT,
    w.vec([
      w.concat(w.str("env"), w.str("memory"), [0x02], w.memType({ min: 1 })),
      w.concat(w.str("env"), w.str("get_long"), [0x00], w.uleb(0)),
      w.concat(w.str("env"), w.str("put_long"), [0x00], w.uleb(1)),
    ]),
  );
  const funcs = w.section(w.S.FUNC, w.vec([w.uleb(2)]));
  const exports = w.section(w.S.EXPORT, w.vec([w.concat(w.str("block"), [0x00], w.uleb(2))]));
  const code = w.section(w.S.CODE, w.vec([w.body([{ count: 5, type: w.I32 }], bodyBytes)]));
  return w.module([types, imports, funcs, exports, code]);
}

/** Basic block (from blockAt) + abi → WASM module exporting block():i32 (next PC). */
export function recompileCoreBlock(block, abi) {
  const cg = makeCodegen(abi);
  const body = [
    ...block.instrs.flatMap(cg.emitInstr),
    ...cg.emitTerminator(block.term, block.fallPC),
  ];
  return buildModule(body);
}
