// Block-level recompiler for the REAL libretro-uae ABI — the codegen the browser
// integration installs. Registers at abi.regsBase (Dn=+n*4, An=+32+n*4); flags
// md-generic at abi.regflagsBase (cznv N=15 Z=14 C=8 V=0 @+0, x X=8 @+4); guest
// memory via imported sized get/put (byte/word/long, banks + big-endian in-core).
// Block ABI: () -> i32 = next guest PC (the M3 hook does m68k_setpc).
//
// .B/.W/.L sizes across MOVE/MOVEA + ALU (ADD/SUB/AND/OR/CMP/EOR + immediate) +
// TST/CLR/NEG/NOT + ADDQ/SUBQ + ADDA/SUBA/CMPA + shifts (imm count) + Scc +
// EXT/SWAP/LEA. Ops it doesn't emit (MOVEM, register-count shifts) throw →
// installJit falls back to the interpreter for that block. Mirrors interp.mjs and
// is validated against it by jit/coreblocktest.mjs.
import * as w from "../spike/emit.mjs";
import { isMem } from "./decode.mjs";
import * as L from "./layout.mjs";

// scratch locals (all i32)
const LA = 0,
  LB = 1,
  LRES = 2,
  LSUM = 3,
  LADDR = 4,
  LADDR2 = 5,
  LTMP = 6;
const NLOCALS = 7;
// imported func indices: get_byte/word/long = 0/1/2, put_byte/word/long = 3/4/5
const GET = { 1: 0, 2: 1, 4: 2 };
const PUT = { 1: 3, 2: 4, 4: 5 };
const MASK = { 1: 0xff, 2: 0xffff, 4: 0xffffffff | 0 };
const BITS = { 1: 8, 2: 16, 4: 32 };
const SIGN = { 1: 0x80, 2: 0x8000, 4: 0x80000000 | 0 };

export function makeCodegen(abi) {
  const rb = abi.regsBase,
    fb = abi.regflagsBase;
  const k = (n) => w.op.i32Const(n);
  const get = (l) => w.op.localGet(l);
  const set = (l) => w.op.localSet(l);
  const tee = (l) => w.op.localTee(l);
  const loadDraw = (n) => [k(rb), w.op.i32Load(n * 4)];
  const loadAraw = (n) => [k(rb), w.op.i32Load(32 + n * 4)];
  const andM = (sz) => (sz === 4 ? [] : [k(MASK[sz]), w.op.i32And()]);
  const storeAfull = (n, e) => [k(rb), ...e, w.op.i32Store(32 + n * 4)];
  // write sized value (expr) into Dn, merging low bytes for .B/.W
  const storeDsz = (n, sz, e) =>
    sz === 4
      ? [k(rb), ...e, w.op.i32Store(n * 4)]
      : [
          k(rb),
          ...loadDraw(n),
          k(~MASK[sz]),
          w.op.i32And(),
          ...e,
          k(MASK[sz]),
          w.op.i32And(),
          w.op.i32Or(),
          w.op.i32Store(n * 4),
        ];

  // md-generic flag terms from a masked sized result in local `l`
  const shl = (e, n) => [...e, k(n), w.op.i32Shl()];
  const orAll = (ts) => ts.slice(1).reduce((a, t) => [...a, ...t, ...w.op.i32Or()], [...ts[0]]);
  const fN = (l, sz) => [
    get(l),
    k(BITS[sz] - 1),
    w.op.i32ShrU(),
    k(1),
    w.op.i32And(),
    k(15),
    w.op.i32Shl(),
  ];
  const fZ = (l) => [get(l), w.op.i32Eqz(), k(14), w.op.i32Shl()];
  // carry (bit8) as 0/1 in bit8 position
  const cAddExpr = (sz) =>
    sz === 4
      ? [get(LRES), get(LA), w.op.i32LtU()] // res <u a
      : [get(LSUM), k(BITS[sz]), w.op.i32ShrU(), k(1), w.op.i32And()]; // carry out
  const cSubExpr = () => [get(LA), get(LB), w.op.i32LtU()]; // borrow: a <u b
  const vExpr = (subtract, sz) => {
    // ((a^res)&(b^res)&sign)  [add]  or  ((a^b)&(a^res)&sign)  [sub]  → bit0
    const t1 = subtract ? [get(LA), get(LB), w.op.i32Xor()] : [get(LA), get(LRES), w.op.i32Xor()];
    const t2 = subtract ? [get(LA), get(LRES), w.op.i32Xor()] : [get(LB), get(LRES), w.op.i32Xor()];
    return [...t1, ...t2, w.op.i32And(), k(SIGN[sz]), w.op.i32And(), w.op.i32Eqz(), w.op.i32Eqz()]; // !=0 → 1
  };
  const storeCznv = (e) => [k(fb), ...e, w.op.i32Store(0)];
  const storeXfromC = (cbitExpr) => [k(fb), ...cbitExpr, k(8), w.op.i32Shl(), w.op.i32Store(4)];
  const cznvNZ = (l, sz) => orAll([fN(l, sz), fZ(l)]); // V=C=0
  // full add/sub flags: LA,LB set (masked); computes LSUM,LRES; writes cznv + X
  const arithFlags = (subtract, sz) => {
    const cbit = subtract ? cSubExpr() : cAddExpr(sz);
    return [
      ...storeCznv(
        orAll([
          fN(LRES, sz),
          fZ(LRES),
          shl(subtract ? cSubExpr() : cAddExpr(sz), 8),
          vExpr(subtract, sz),
        ]),
      ),
      ...storeXfromC(cbit),
    ];
  };

  // EA address → local `dst` (guest addr), applying (An)+/-(An) by size
  const stepN = (n, sz) => (n === 7 && sz === 1 ? 2 : sz);
  function eaAddr(ea, dst, sz) {
    const put = (bytes) => [...bytes, set(dst)];
    switch (ea.ea) {
      case "ind":
        return put(loadAraw(ea.n));
      case "pinc":
        return [
          ...put(loadAraw(ea.n)),
          ...storeAfull(ea.n, [...loadAraw(ea.n), k(stepN(ea.n, sz)), w.op.i32Add()]),
        ];
      case "pdec":
        return [
          ...storeAfull(ea.n, [...loadAraw(ea.n), k(stepN(ea.n, sz)), w.op.i32Sub()]),
          ...put(loadAraw(ea.n)),
        ];
      case "disp":
        return put([...loadAraw(ea.n), k(ea.d), w.op.i32Add()]);
      case "abs":
      case "absw":
        return put([k(ea.addr)]);
      case "idx": {
        // base + signExt(indexReg, isz)*scale + disp
        const baseE = ea.an != null ? loadAraw(ea.an) : [k(ea.base)];
        const idxRaw = ea.ri < 8 ? loadDraw(ea.ri) : loadAraw(ea.ri - 8);
        const idxE = signExtExpr(idxRaw, ea.isz);
        const scaled = ea.scale > 1 ? [...idxE, k(ea.scale), w.op.i32Mul()] : idxE;
        return put([...baseE, ...scaled, w.op.i32Add(), k(ea.disp), w.op.i32Add()]);
      }
      default:
        throw new Error(`coreblock eaAddr: ${ea.ea}`);
    }
  }
  const memLoad = (l, sz) => [get(l), w.op.call(GET[sz])];
  const memStore = (l, sz, valExpr) => [get(l), ...valExpr, w.op.call(PUT[sz])];
  // read EA as masked unsigned sized value (address already in `l` if memory)
  function readEA(ea, l, sz) {
    switch (ea.ea) {
      case "d":
        return [...loadDraw(ea.n), ...andM(sz)];
      case "a":
        return [...loadAraw(ea.n), ...andM(sz)];
      case "imm":
        return [k(ea.val & MASK[sz])];
      default:
        return memLoad(l, sz);
    }
  }
  const signExtExpr = (e, sz) =>
    sz === 4 ? e : [...e, k(32 - BITS[sz]), w.op.i32Shl(), k(32 - BITS[sz]), w.op.i32ShrS()];
  // write masked value in local `l` to a dst EA (addr already in `addrL` if mem)
  function writeEA(ea, addrL, sz, valLocal) {
    if (ea.ea === "d") return storeDsz(ea.n, sz, [get(valLocal)]);
    if (ea.ea === "a") return storeAfull(ea.n, [get(valLocal)]);
    return memStore(addrL, sz, [get(valLocal)]);
  }

  // compute src value → LB, dst current → LA (both masked); addr locals filled
  function loadOperands(it, sz) {
    const code = [];
    // determine the "dst" EA (Dn form, memDst/immForm dst, etc.)
    const dstEA = it.memDst || it.immForm ? it.dst : { ea: "d", n: it.dn };
    const srcEA = it.immForm ? it.src : it.memDst ? { ea: "d", n: it.dn } : it.src;
    if (isMem(dstEA)) code.push(...eaAddr(dstEA, LADDR, sz));
    if (isMem(srcEA)) code.push(...eaAddr(srcEA, LADDR2, sz));
    code.push(...readEA(dstEA, LADDR, sz), set(LA));
    code.push(...readEA(srcEA, LADDR2, sz), set(LB));
    return { code, dstEA };
  }

  function emitInstr(it) {
    const sz = it.sz || 4;
    switch (it.op) {
      case "nop":
        return [];
      case "moveq":
        return [
          k(it.imm),
          set(LRES),
          ...storeDsz(it.dn, 4, [get(LRES)]),
          ...storeCznv(cznvNZ(LRES, 4)),
        ];
      case "move": {
        // 68k order: fully evaluate the source (addr + value) BEFORE the dest EA,
        // so e.g. MOVE.W A5,(A5)+ reads A5 before the post-increment.
        const code = [];
        if (isMem(it.src)) code.push(...eaAddr(it.src, LADDR2, sz));
        code.push(...readEA(it.src, LADDR2, sz), set(LRES));
        if (isMem(it.dst)) code.push(...eaAddr(it.dst, LADDR, sz));
        code.push(...writeEA(it.dst, LADDR, sz, LRES));
        code.push(...storeCznv(cznvNZ(LRES, sz)));
        return code;
      }
      case "movea": {
        const code = [];
        if (isMem(it.src)) code.push(...eaAddr(it.src, LADDR2, sz));
        code.push(...storeAfull(it.dst.n, signExtExpr(readEA(it.src, LADDR2, sz), sz))); // no flags
        return code;
      }
      case "add":
      case "sub": {
        const { code, dstEA } = loadOperands(it, sz);
        code.push(
          get(LA),
          get(LB),
          it.op === "add" ? w.op.i32Add() : w.op.i32Sub(),
          tee(LSUM),
          ...andM(sz),
          set(LRES),
        );
        code.push(...writeEA(dstEA, LADDR, sz, LRES));
        code.push(...arithFlags(it.op === "sub", sz));
        return code;
      }
      case "and":
      case "or": {
        const { code, dstEA } = loadOperands(it, sz);
        code.push(
          get(LA),
          get(LB),
          it.op === "and" ? w.op.i32And() : w.op.i32Or(),
          ...andM(sz),
          set(LRES),
        );
        code.push(...writeEA(dstEA, LADDR, sz, LRES));
        code.push(...storeCznv(cznvNZ(LRES, sz)));
        return code;
      }
      case "cmp": {
        // a = Dn (or dst for immForm); b = src/imm; sub, flags only, X preserved
        const aEA = it.immForm ? it.dst : { ea: "d", n: it.dn };
        const code = [];
        if (isMem(aEA)) code.push(...eaAddr(aEA, LADDR, sz));
        if (!it.immForm && isMem(it.src)) code.push(...eaAddr(it.src, LADDR2, sz));
        code.push(...readEA(aEA, LADDR, sz), set(LA));
        code.push(...readEA(it.immForm ? it.src : it.src, LADDR2, sz), set(LB));
        code.push(get(LA), get(LB), w.op.i32Sub(), ...andM(sz), set(LRES));
        code.push(
          ...storeCznv(orAll([fN(LRES, sz), fZ(LRES), shl(cSubExpr(), 8), vExpr(true, sz)])),
        ); // X preserved
        return code;
      }
      case "eor": {
        const code = [];
        if (isMem(it.dst)) code.push(...eaAddr(it.dst, LADDR, sz));
        code.push(...readEA(it.dst, LADDR, sz), set(LA));
        code.push(get(LA), ...loadDraw(it.dn), ...andM(sz), w.op.i32Xor(), ...andM(sz), set(LRES));
        code.push(...writeEA(it.dst, LADDR, sz, LRES));
        code.push(...storeCznv(cznvNZ(LRES, sz)));
        return code;
      }
      case "eori": {
        const code = [];
        if (isMem(it.dst)) code.push(...eaAddr(it.dst, LADDR, sz));
        code.push(
          ...readEA(it.dst, LADDR, sz),
          k(it.imm & MASK[sz]),
          w.op.i32Xor(),
          ...andM(sz),
          set(LRES),
        );
        code.push(...writeEA(it.dst, LADDR, sz, LRES));
        code.push(...storeCznv(cznvNZ(LRES, sz)));
        return code;
      }
      case "not": {
        const code = [];
        if (isMem(it.dst)) code.push(...eaAddr(it.dst, LADDR, sz));
        code.push(...readEA(it.dst, LADDR, sz), k(-1), w.op.i32Xor(), ...andM(sz), set(LRES));
        code.push(...writeEA(it.dst, LADDR, sz, LRES));
        code.push(...storeCznv(cznvNZ(LRES, sz)));
        return code;
      }
      case "neg": {
        const code = [];
        if (isMem(it.dst)) code.push(...eaAddr(it.dst, LADDR, sz));
        code.push(...readEA(it.dst, LADDR, sz), set(LB));
        code.push(k(0), set(LA));
        code.push(get(LA), get(LB), w.op.i32Sub(), tee(LSUM), ...andM(sz), set(LRES));
        code.push(...writeEA(it.dst, LADDR, sz, LRES));
        code.push(...arithFlags(true, sz));
        return code;
      }
      case "addq":
      case "subq": {
        if (it.dst.ea === "a") {
          return storeAfull(it.dst.n, [
            ...loadAraw(it.dst.n),
            k(it.op === "addq" ? it.imm : -it.imm),
            w.op.i32Add(),
          ]);
        }
        const code = [];
        if (isMem(it.dst)) code.push(...eaAddr(it.dst, LADDR, sz));
        code.push(...readEA(it.dst, LADDR, sz), set(LA));
        code.push(k(it.imm), set(LB));
        code.push(
          get(LA),
          get(LB),
          it.op === "addq" ? w.op.i32Add() : w.op.i32Sub(),
          tee(LSUM),
          ...andM(sz),
          set(LRES),
        );
        code.push(...writeEA(it.dst, LADDR, sz, LRES));
        code.push(...arithFlags(it.op === "subq", sz));
        return code;
      }
      case "tst": {
        const code = [];
        if (isMem(it.dst)) code.push(...eaAddr(it.dst, LADDR, sz));
        code.push(...readEA(it.dst, LADDR, sz), set(LRES));
        code.push(...storeCznv(cznvNZ(LRES, sz)));
        return code;
      }
      case "clr": {
        const code = [];
        if (isMem(it.dst)) code.push(...eaAddr(it.dst, LADDR, sz));
        code.push(k(0), set(LRES));
        code.push(...writeEA(it.dst, LADDR, sz, LRES));
        code.push(...storeCznv([k(1 << 14)])); // Z=1
        return code;
      }
      case "scc": {
        const code = [];
        if (isMem(it.dst)) code.push(...eaAddr(it.dst, LADDR, 1));
        // cond ? 0xff : 0 → replicate: (0 - cond) & 0xff
        code.push(k(0), ...condExpr(it.cc), w.op.i32Sub(), k(0xff), w.op.i32And(), set(LRES));
        code.push(...writeEA(it.dst, LADDR, 1, LRES));
        return code;
      }
      case "adda":
      case "suba": {
        const code = [];
        if (isMem(it.src)) code.push(...eaAddr(it.src, LADDR2, sz));
        const b = signExtExpr(readEA(it.src, LADDR2, sz), sz);
        code.push(
          ...storeAfull(it.an, [
            ...loadAraw(it.an),
            ...b,
            it.op === "adda" ? w.op.i32Add() : w.op.i32Sub(),
          ]),
        );
        return code;
      }
      case "cmpa": {
        const code = [];
        if (isMem(it.src)) code.push(...eaAddr(it.src, LADDR2, sz));
        code.push(...loadAraw(it.an), set(LA));
        code.push(...signExtExpr(readEA(it.src, LADDR2, sz), sz), set(LB));
        code.push(get(LA), get(LB), w.op.i32Sub(), set(LRES));
        code.push(...storeCznv(orAll([fN(LRES, 4), fZ(LRES), shl(cSubExpr(), 8), vExpr(true, 4)]))); // 32-bit, X preserved
        return code;
      }
      case "lea":
        return [...eaAddr(it.src, LADDR, 4), ...storeAfull(it.an, [get(LADDR)])];
      case "ext": {
        if (sz === 2) {
          return [
            ...loadDraw(it.dn),
            k(24),
            w.op.i32Shl(),
            k(24),
            w.op.i32ShrS(),
            k(0xffff),
            w.op.i32And(),
            set(LRES),
            ...storeDsz(it.dn, 2, [get(LRES)]),
            ...storeCznv(cznvNZ(LRES, 2)),
          ];
        }
        return [
          ...loadDraw(it.dn),
          k(16),
          w.op.i32Shl(),
          k(16),
          w.op.i32ShrS(),
          set(LRES),
          ...storeDsz(it.dn, 4, [get(LRES)]),
          ...storeCznv(cznvNZ(LRES, 4)),
        ];
      }
      case "swap":
        return [
          ...loadDraw(it.dn),
          tee(LA),
          k(16),
          w.op.i32ShrU(),
          get(LA),
          k(16),
          w.op.i32Shl(),
          w.op.i32Or(),
          set(LRES),
          ...storeDsz(it.dn, 4, [get(LRES)]),
          ...storeCznv(cznvNZ(LRES, 4)),
        ];
      case "asl":
      case "lsl":
      case "asr":
      case "lsr": {
        if (it.cntReg != null) throw new Error("coreblock: register-count shift unsupported");
        const n = it.cnt;
        const m = MASK[sz];
        const left = it.op === "asl" || it.op === "lsl";
        const shiftOp = left ? w.op.i32Shl() : it.op === "asr" ? w.op.i32ShrS() : w.op.i32ShrU();
        // val (masked, sign-extended for ASR so ShrS works on the sized sign)
        const valExpr =
          it.op === "asr"
            ? signExtExpr([...loadDraw(it.dn), ...andM(sz)], sz)
            : [...loadDraw(it.dn), ...andM(sz)];
        const cBit = left
          ? [get(LA), k(BITS[sz] - n), w.op.i32ShrU(), k(1), w.op.i32And()]
          : [get(LA), k(n - 1), w.op.i32ShrU(), k(1), w.op.i32And()];
        // ASL overflow (68k-exact): V=1 iff the sign bit changed at ANY step —
        // the top (n+1) bits of the sign-extended value aren't all equal. For
        // n>=BITS (byte #8) zeros pass through the sign → V = (val != 0).
        let vBit = [k(0)];
        if (it.op === "asl") {
          if (n < BITS[sz]) {
            vBit = [
              ...signExtExpr([get(LA)], sz),
              k(BITS[sz] - 1 - n),
              w.op.i32ShrS(),
              tee(LTMP),
              k(0),
              w.op.i32Ne(),
              get(LTMP),
              k(-1),
              w.op.i32Ne(),
              w.op.i32And(),
            ];
          } else {
            vBit = [get(LA), w.op.i32Eqz(), w.op.i32Eqz()]; // val != 0
          }
        }
        return [
          ...valExpr,
          set(LA),
          get(LA),
          k(n),
          shiftOp,
          ...andM(sz),
          set(LRES),
          ...storeDsz(it.dn, sz, [get(LRES)]),
          ...storeCznv(orAll([fN(LRES, sz), fZ(LRES), shl(cBit, 8), shl(vBit, 0)])),
          ...storeXfromC(cBit),
        ];
      }
      case "movem": {
        // mask is a compile-time constant → unroll exactly the listed registers.
        const st = sz; // 2 or 4
        const regOff = (idx) => (idx < 8 ? idx * 4 : 32 + (idx - 8) * 4);
        const loadReg = (idx) => [k(rb), w.op.i32Load(regOff(idx))];
        const storeRegFull = (idx, e) => [k(rb), ...e, w.op.i32Store(regOff(idx))];
        const code = [];
        if (it.toMem) {
          if (it.ea.ea === "pdec") {
            code.push(...loadAraw(it.ea.n), set(LADDR)); // addr = An
            for (let bit = 0; bit < 16; bit++)
              if (it.mask & (1 << bit)) {
                code.push(get(LADDR), k(st), w.op.i32Sub(), set(LADDR));
                code.push(...memStore(LADDR, st, loadReg(15 - bit))); // bit0=A7 … bit15=D0
              }
            code.push(...storeAfull(it.ea.n, [get(LADDR)]));
          } else {
            code.push(...eaAddr(it.ea, LADDR, st)); // control addr (ind/disp/abs)
            for (let bit = 0; bit < 16; bit++)
              if (it.mask & (1 << bit)) {
                code.push(...memStore(LADDR, st, loadReg(bit))); // bit0=D0 … bit15=A7
                code.push(get(LADDR), k(st), w.op.i32Add(), set(LADDR));
              }
          }
        } else {
          if (it.ea.ea === "pinc") code.push(...loadAraw(it.ea.n), set(LADDR));
          else code.push(...eaAddr(it.ea, LADDR, st));
          for (let bit = 0; bit < 16; bit++)
            if (it.mask & (1 << bit)) {
              const v = memLoad(LADDR, st);
              code.push(...storeRegFull(bit, st === 2 ? signExtExpr(v, 2) : v)); // word sign-extends
              code.push(get(LADDR), k(st), w.op.i32Add(), set(LADDR));
            }
          if (it.ea.ea === "pinc") code.push(...storeAfull(it.ea.n, [get(LADDR)]));
        }
        return code;
      }
      case "btst":
      case "bchg":
      case "bclr":
      case "bset": {
        const code = [];
        if (isMem(it.dst)) code.push(...eaAddr(it.dst, LADDR, sz));
        code.push(...readEA(it.dst, LADDR, sz), set(LA)); // value → LA
        const bmask = sz === 4 ? 31 : 7;
        const bnExpr =
          it.bitReg != null
            ? [...loadDraw(it.bitReg), k(bmask), w.op.i32And()]
            : [k(it.bitnum & bmask)];
        code.push(...bnExpr, set(LB)); // bit number → LB
        code.push(get(LA), get(LB), w.op.i32ShrU(), k(1), w.op.i32And(), set(LRES)); // bit → LRES
        // Z only: cznv = (cznv & ~0x4000) | (bit==0 ? 0x4000 : 0)
        code.push(
          ...storeCznv([
            k(fb),
            w.op.i32Load(0),
            k(~0x4000),
            w.op.i32And(),
            get(LRES),
            w.op.i32Eqz(),
            k(14),
            w.op.i32Shl(),
            w.op.i32Or(),
          ]),
        );
        if (it.op !== "btst") {
          const oneShl = [k(1), get(LB), w.op.i32Shl()];
          const nv =
            it.op === "bset"
              ? [get(LA), ...oneShl, w.op.i32Or()]
              : it.op === "bclr"
                ? [get(LA), ...oneShl, k(-1), w.op.i32Xor(), w.op.i32And()]
                : [get(LA), ...oneShl, w.op.i32Xor()]; // bchg
          code.push(...nv, set(LRES));
          code.push(...writeEA(it.dst, LADDR, sz, LRES));
        }
        return code;
      }
      case "mulu":
      case "muls": {
        const code = [];
        if (isMem(it.src)) code.push(...eaAddr(it.src, LADDR2, 2));
        const aWord = [...loadDraw(it.dn), k(0xffff), w.op.i32And()];
        const bWord = readEA(it.src, LADDR2, 2);
        const aE = it.op === "muls" ? signExtExpr(aWord, 2) : aWord;
        const bE = it.op === "muls" ? signExtExpr(bWord, 2) : bWord;
        code.push(...aE, ...bE, w.op.i32Mul(), set(LRES));
        code.push(...storeDsz(it.dn, 4, [get(LRES)]));
        code.push(...storeCznv(cznvNZ(LRES, 4))); // N,Z; V=C=0; X preserved
        return code;
      }
      default:
        throw new Error(`coreblock: unhandled ${it.op}`);
    }
  }

  // ---- condition codes → 0/1 (reads md-generic cznv) ----
  const loadCznv = () => [k(fb), w.op.i32Load(0)];
  const bitAt = (shift) => [...loadCznv(), k(shift), w.op.i32ShrU(), k(1), w.op.i32And()];
  const bC = () => bitAt(8),
    bV = () => [...loadCznv(), k(1), w.op.i32And()],
    bZ = () => bitAt(14),
    bN = () => bitAt(15);
  const notb = (x) => [...x, w.op.i32Eqz()];
  const and2 = (a, b) => [...a, ...b, w.op.i32And()];
  const or2 = (a, b) => [...a, ...b, w.op.i32Or()];
  const eq2 = (a, b) => [...a, ...b, w.op.i32Eq()];
  const ne2 = (a, b) => [...a, ...b, w.op.i32Ne()];
  function condExpr(cc) {
    switch (cc) {
      case 0:
        return [k(1)];
      case 1:
        return [k(0)];
      case 2:
        return and2(notb(bC()), notb(bZ()));
      case 3:
        return or2(bC(), bZ());
      case 4:
        return notb(bC());
      case 5:
        return bC();
      case 6:
        return notb(bZ());
      case 7:
        return bZ();
      case 8:
        return notb(bV());
      case 9:
        return bV();
      case 10:
        return notb(bN());
      case 11:
        return bN();
      case 12:
        return eq2(bN(), bV());
      case 13:
        return ne2(bN(), bV());
      case 14:
        return and2(notb(bZ()), eq2(bN(), bV()));
      default:
        return or2(bZ(), ne2(bN(), bV()));
    }
  }
  const sel = (a, b, cond) => [...a, ...b, ...cond, w.op.select()];

  function emitTerminator(term, fallPC) {
    if (!term) return [k(fallPC)];
    if (["jsr", "jmp", "bsr", "rts", "rte", "rtr"].includes(term.op)) return [k(term.pc | 0)];
    if (term.op === "halt") return [k(L.HALT_PC)];
    const target = (term.pc + 2 + term.disp) | 0;
    if (term.op === "bcc") return sel([k(target)], [k(fallPC)], condExpr(term.cc));
    // dbcc
    const dec = [
      get(LB),
      k(0xffff0000 | 0),
      w.op.i32And(),
      get(LB),
      k(1),
      w.op.i32Sub(),
      k(0xffff),
      w.op.i32And(),
      w.op.i32Or(),
    ];
    const cntNotMinus1 = [get(LRES), k(0xffff), w.op.i32And(), k(0xffff), w.op.i32Ne()];
    const branchTaken = [...[...condExpr(term.cc), w.op.i32Eqz()], ...cntNotMinus1, w.op.i32And()];
    return [
      ...condExpr(term.cc),
      set(LA),
      ...loadDraw(term.dn),
      set(LB),
      ...dec,
      set(LRES),
      ...storeDsz(term.dn, 4, [get(LB), get(LRES), get(LA), w.op.select()]),
      ...sel([k(target)], [k(fallPC)], branchTaken),
    ];
  }

  return { emitInstr, emitTerminator, condExpr };
}

function buildModule(bodyBytes) {
  const types = w.section(
    w.S.TYPE,
    w.vec([w.funcType([w.I32], [w.I32]), w.funcType([w.I32, w.I32], []), w.funcType([], [w.I32])]),
  );
  const imp = (name, tIdx) => w.concat(w.str("env"), w.str(name), [0x00], w.uleb(tIdx));
  const imports = w.section(
    w.S.IMPORT,
    w.vec([
      w.concat(w.str("env"), w.str("memory"), [0x02], w.memType({ min: 1 })),
      imp("get_byte", 0),
      imp("get_word", 0),
      imp("get_long", 0),
      imp("put_byte", 1),
      imp("put_word", 1),
      imp("put_long", 1),
    ]),
  );
  const funcs = w.section(w.S.FUNC, w.vec([w.uleb(2)])); // block : type2
  const exports = w.section(w.S.EXPORT, w.vec([w.concat(w.str("block"), [0x00], w.uleb(6))])); // func idx 6 (6 imports)
  const code = w.section(w.S.CODE, w.vec([w.body([{ count: NLOCALS, type: w.I32 }], bodyBytes)]));
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
