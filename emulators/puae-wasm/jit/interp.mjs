// Reference 68k interpreter — the ORACLE the recompiler (coreblock.mjs) is
// validated against (jit/coreblocktest.mjs). Operates on an Int32Array `s`
// (D0..D7, A0..A7, CCR packed X=16 N=8 Z=4 V=2 C=1, PC) per layout.mjs.
// Guest memory goes through `s.__mem` (a sized get/put accessor) when present —
// coreblocktest backs it with a byte-addressable big-endian buffer, matching the
// real core's get/put_byte/word/long; without it, a .L cell fallback is used.
import * as L from "./layout.mjs";
import { blockAt, isMem } from "./decode.mjs";

export const CCR = L.iCCR;

const MASK = { 1: 0xff, 2: 0xffff, 4: 0xffffffff };
const msk = (sz) => MASK[sz];
const signExt = (v, sz) => (sz === 1 ? (v << 24) >> 24 : sz === 2 ? (v << 16) >> 16 : v | 0);
const nz = (res, sz) => {
  const m = msk(sz) >>> 0;
  const v = res & m;
  return (v & ((m >>> 1) + 1) ? L.N : 0) | (v === 0 ? L.Z : 0); // top bit = N
};

// a,b as UNSIGNED masked values (avoid `& 0xffffffff` which re-signs to int32);
// res is an unsigned Number 0..2^32-1.
function flagsAddSz(a, b, sz) {
  const m = msk(sz) >>> 0;
  const au = sz === 4 ? a >>> 0 : (a & m) >>> 0;
  const bu = sz === 4 ? b >>> 0 : (b & m) >>> 0;
  const full = au + bu; // exact JS number (< 2^33)
  const res = sz === 4 ? full % 0x100000000 : full & m;
  const c = full > m ? L.C : 0;
  const sb = (m >>> 1) + 1;
  const v = ((au ^ res) & (bu ^ res) & sb) !== 0 ? L.V : 0;
  return {
    res,
    flags: ((res & sb) !== 0 ? L.N : 0) | (res === 0 ? L.Z : 0) | v | c | (c ? L.X : 0),
  };
}
function flagsSubSz(a, b, sz) {
  const m = msk(sz) >>> 0;
  const au = sz === 4 ? a >>> 0 : (a & m) >>> 0;
  const bu = sz === 4 ? b >>> 0 : (b & m) >>> 0;
  const res = sz === 4 ? (au - bu) >>> 0 : (au - bu) & m;
  const c = au < bu ? L.C : 0; // unsigned borrow
  const sb = (m >>> 1) + 1;
  const v = ((au ^ bu) & (au ^ res) & sb) !== 0 ? L.V : 0;
  return {
    res,
    flags: ((res & sb) !== 0 ? L.N : 0) | (res === 0 ? L.Z : 0) | v | c | (c ? L.X : 0),
  };
}

// sized guest memory
function memGet(s, addr, sz) {
  if (s.__mem) return s.__mem.get(addr >>> 0, sz) >>> 0;
  return s[L.iCell(addr)] >>> 0; // .L cell fallback
}
function memPut(s, addr, sz, val) {
  if (s.__mem) s.__mem.put(addr >>> 0, sz, val >>> 0);
  else s[L.iCell(addr)] = val | 0;
}

// (An)+ / -(An) advance by the operand size; SP (A7) stays even for byte access.
const step = (n, sz) => (n === 7 && sz === 1 ? 2 : sz);
function eaAddr(s, ea, sz) {
  switch (ea.ea) {
    case "ind":
      return s[L.iA(ea.n)] | 0;
    case "pinc": {
      const a = s[L.iA(ea.n)] | 0;
      s[L.iA(ea.n)] = (a + step(ea.n, sz)) | 0;
      return a;
    }
    case "pdec": {
      const a = (s[L.iA(ea.n)] - step(ea.n, sz)) | 0;
      s[L.iA(ea.n)] = a;
      return a;
    }
    case "disp":
      return (s[L.iA(ea.n)] + ea.d) | 0;
    case "abs":
    case "absw":
      return ea.addr | 0;
    case "idx": {
      const baseV = ea.an != null ? s[L.iA(ea.an)] : ea.base;
      const ix = ea.ri < 8 ? s[L.iD(ea.ri)] : s[L.iA(ea.ri - 8)];
      return (baseV + ea.disp + signExt(ix, ea.isz) * ea.scale) | 0;
    }
  }
  throw new Error(`eaAddr: not memory (${ea.ea})`);
}
// read EA as an UNSIGNED sized value
function readEA(s, ea, sz) {
  switch (ea.ea) {
    case "d":
      return s[L.iD(ea.n)] & (msk(sz) >>> 0);
    case "a":
      return signExt(s[L.iA(ea.n)], sz) & (msk(sz) >>> 0);
    case "imm":
      return ea.val & (msk(sz) >>> 0);
    default:
      return memGet(s, eaAddr(s, ea, sz), sz);
  }
}
// write a sized value to EA (Dn/mem merge low bytes; An writes full via caller)
function writeEA(s, ea, sz, val) {
  if (ea.ea === "d") {
    const m = msk(sz) >>> 0;
    s[L.iD(ea.n)] = (s[L.iD(ea.n)] & ~m) | (val & m) | 0;
  } else if (ea.ea === "a") {
    s[L.iA(ea.n)] = val | 0;
  } else {
    memPut(s, eaAddr(s, ea, sz), sz, val);
  }
}
const setNZ = (s, res, sz) => (s[CCR] = (s[CCR] & L.X) | nz(res, sz));

// Read-modify-write helpers: compute a memory EA's address ONCE (so (An)+/-(An)
// side effects apply a single time across the read and the write).
function eaOnce(s, ea, sz) {
  return isMem(ea) ? eaAddr(s, ea, sz) : 0;
}
function readAt(s, ea, sz, addr) {
  if (ea.ea === "d") return s[L.iD(ea.n)] & (msk(sz) >>> 0);
  if (ea.ea === "a") return signExt(s[L.iA(ea.n)], sz) & (msk(sz) >>> 0);
  if (ea.ea === "imm") return ea.val & (msk(sz) >>> 0);
  return memGet(s, addr, sz);
}
function writeAt(s, ea, sz, addr, val) {
  if (ea.ea === "d") {
    const m = msk(sz) >>> 0;
    s[L.iD(ea.n)] = (s[L.iD(ea.n)] & ~m) | (val & m) | 0;
  } else if (ea.ea === "a") s[L.iA(ea.n)] = val | 0;
  else memPut(s, addr, sz, val);
}

export function execOne(d, s) {
  const sz = d.sz || 4;
  switch (d.op) {
    case "nop":
      break;
    case "moveq":
      s[L.iD(d.dn)] = d.imm | 0;
      setNZ(s, d.imm, 4);
      break;
    case "move": {
      const v = readEA(s, d.src, sz);
      writeEA(s, d.dst, sz, v);
      setNZ(s, v, sz);
      break;
    }
    case "movea": {
      s[L.iA(d.dst.n)] = signExt(readEA(s, d.src, sz), sz) | 0; // .W sign-extends; no flags
      break;
    }
    case "add":
    case "sub": {
      if (d.immForm || d.memDst) {
        const dst = d.dst;
        const addr = eaOnce(s, dst, sz);
        const b = d.immForm ? d.src.val & (msk(sz) >>> 0) : s[L.iD(d.dn)] & (msk(sz) >>> 0);
        const a = readAt(s, dst, sz, addr);
        const r = d.op === "add" ? flagsAddSz(a, b, sz) : flagsSubSz(a, b, sz);
        writeAt(s, dst, sz, addr, r.res);
        s[CCR] = r.flags;
      } else {
        const b = readEA(s, d.src, sz); // src side effects first
        const a = s[L.iD(d.dn)] & (msk(sz) >>> 0);
        const r = d.op === "add" ? flagsAddSz(a, b, sz) : flagsSubSz(a, b, sz);
        writeAt(s, { ea: "d", n: d.dn }, sz, 0, r.res);
        s[CCR] = r.flags;
      }
      break;
    }
    case "and":
    case "or": {
      if (d.immForm || d.memDst) {
        const dst = d.dst;
        const addr = eaOnce(s, dst, sz);
        const b = d.immForm ? d.src.val & (msk(sz) >>> 0) : s[L.iD(d.dn)] & (msk(sz) >>> 0);
        const a = readAt(s, dst, sz, addr);
        const res = (d.op === "and" ? a & b : a | b) >>> 0;
        writeAt(s, dst, sz, addr, res);
        setNZ(s, res, sz);
      } else {
        const b = readEA(s, d.src, sz);
        const a = s[L.iD(d.dn)] & (msk(sz) >>> 0);
        const res = (d.op === "and" ? a & b : a | b) >>> 0;
        writeAt(s, { ea: "d", n: d.dn }, sz, 0, res);
        setNZ(s, res, sz);
      }
      break;
    }
    case "cmp": {
      const b = d.immForm ? d.src.val & (msk(sz) >>> 0) : readEA(s, d.src, sz);
      const a = (d.immForm ? readEA(s, d.dst, sz) : s[L.iD(d.dn)] & (msk(sz) >>> 0)) >>> 0;
      const r = flagsSubSz(a, b, sz);
      s[CCR] = (r.flags & ~L.X) | (s[CCR] & L.X); // CMP preserves X
      break;
    }
    case "eor": {
      const addr = eaOnce(s, d.dst, sz);
      const res = (readAt(s, d.dst, sz, addr) ^ (s[L.iD(d.dn)] & (msk(sz) >>> 0))) >>> 0;
      writeAt(s, d.dst, sz, addr, res);
      setNZ(s, res, sz);
      break;
    }
    case "eori": {
      const addr = eaOnce(s, d.dst, sz);
      const res = (readAt(s, d.dst, sz, addr) ^ (d.imm & (msk(sz) >>> 0))) >>> 0;
      writeAt(s, d.dst, sz, addr, res);
      setNZ(s, res, sz);
      break;
    }
    case "not": {
      const addr = eaOnce(s, d.dst, sz);
      const res = ~readAt(s, d.dst, sz, addr) >>> 0;
      writeAt(s, d.dst, sz, addr, res);
      setNZ(s, res, sz);
      break;
    }
    case "neg": {
      const addr = eaOnce(s, d.dst, sz);
      const r = flagsSubSz(0, readAt(s, d.dst, sz, addr), sz);
      writeAt(s, d.dst, sz, addr, r.res);
      s[CCR] = r.flags;
      break;
    }
    case "addq":
    case "subq": {
      if (d.dst.ea === "a") {
        s[L.iA(d.dst.n)] = (s[L.iA(d.dst.n)] + (d.op === "addq" ? d.imm : -d.imm)) | 0; // no flags
      } else {
        const addr = eaOnce(s, d.dst, sz);
        const a = readAt(s, d.dst, sz, addr);
        const r = d.op === "addq" ? flagsAddSz(a, d.imm, sz) : flagsSubSz(a, d.imm, sz);
        writeAt(s, d.dst, sz, addr, r.res);
        s[CCR] = r.flags;
      }
      break;
    }
    case "tst": {
      setNZ(s, readEA(s, d.dst, sz), sz);
      break;
    }
    case "clr": {
      writeEA(s, d.dst, sz, 0);
      s[CCR] = (s[CCR] & L.X) | L.Z;
      break;
    }
    case "scc": {
      writeEA(s, d.dst, 1, evalCond(d.cc, s) ? 0xff : 0x00); // no flags
      break;
    }
    case "adda":
    case "suba": {
      const b = signExt(readEA(s, d.src, sz), sz) | 0;
      s[L.iA(d.an)] = (s[L.iA(d.an)] + (d.op === "adda" ? b : -b)) | 0; // no flags
      break;
    }
    case "cmpa": {
      const a = s[L.iA(d.an)] | 0;
      const b = signExt(readEA(s, d.src, sz), sz) | 0;
      const r = flagsSubSz(a >>> 0, b >>> 0, 4);
      s[CCR] = (r.flags & ~L.X) | (s[CCR] & L.X);
      break;
    }
    case "lea":
      s[L.iA(d.an)] = eaAddr(s, d.src, 4) | 0;
      break;
    case "ext": {
      if (sz === 2) {
        const res = signExt(s[L.iD(d.dn)] & 0xff, 1) & 0xffff;
        s[L.iD(d.dn)] = (s[L.iD(d.dn)] & ~0xffff) | res | 0;
        setNZ(s, res, 2);
      } else {
        const res = signExt(s[L.iD(d.dn)] & 0xffff, 2) | 0;
        s[L.iD(d.dn)] = res;
        setNZ(s, res, 4);
      }
      break;
    }
    case "swap": {
      const x = s[L.iD(d.dn)];
      const res = (x >>> 16) | (x << 16) | 0;
      s[L.iD(d.dn)] = res;
      setNZ(s, res, 4);
      break;
    }
    case "asl":
    case "lsl":
    case "asr":
    case "lsr": {
      const m = msk(sz) >>> 0;
      const sb = (m >>> 1) + 1;
      let cnt = d.cntReg != null ? s[L.iD(d.cntReg)] & 63 : d.cnt;
      const left = d.op === "asl" || d.op === "lsl";
      let val = s[L.iD(d.dn)] & m;
      let c = 0,
        vf = 0;
      if (cnt === 0) {
        c = 0; // count 0 → C cleared, X unaffected, no V
        const res = val;
        s[L.iD(d.dn)] = (s[L.iD(d.dn)] & ~m) | res | 0;
        s[CCR] = (s[CCR] & L.X) | nz(res, sz);
        break;
      }
      let res = val;
      if (left) {
        for (let k = 0; k < cnt; k++) {
          c = res & sb ? L.C : 0;
          const prevSign = res & sb;
          res = (res << 1) & m;
          if (d.op === "asl" && (res & sb) !== prevSign) vf = L.V;
        }
      } else {
        for (let k = 0; k < cnt; k++) {
          c = res & 1 ? L.C : 0;
          if (d.op === "asr") res = ((res & sb ? res | ~m : res) >> 1) & m;
          else res = (res >>> 1) & m;
        }
      }
      s[L.iD(d.dn)] = (s[L.iD(d.dn)] & ~m) | res | 0;
      s[CCR] = (res & sb ? L.N : 0) | (res === 0 ? L.Z : 0) | vf | c | (c ? L.X : 0);
      break;
    }
    case "movem": {
      // list order: reg→mem uses A7..D0 for -(An), else D0..A7; mem→reg D0..A7
      let addr = d.ea.ea === "pdec" ? s[L.iA(d.ea.n)] : eaAddr(s, d.ea, sz);
      const st = sz;
      if (d.toMem) {
        if (d.ea.ea === "pdec") {
          // mask bit0 = A7 … bit15 = D0 (reversed); predecrement
          for (let bit = 0; bit < 16; bit++) {
            if (d.mask & (1 << bit)) {
              const regIdx = 15 - bit; // 0..15 → D0..A7 index
              addr = (addr - st) | 0;
              const val = regIdx < 8 ? s[L.iD(regIdx)] : s[L.iA(regIdx - 8)];
              memPut(s, addr, st, val >>> 0);
            }
          }
          s[L.iA(d.ea.n)] = addr | 0;
        } else {
          for (let bit = 0; bit < 16; bit++) {
            if (d.mask & (1 << bit)) {
              const val = bit < 8 ? s[L.iD(bit)] : s[L.iA(bit - 8)];
              memPut(s, addr, st, val >>> 0);
              addr = (addr + st) | 0;
            }
          }
        }
      } else {
        // mem→reg: bit0=D0 … bit15=A7; postincrement
        for (let bit = 0; bit < 16; bit++) {
          if (d.mask & (1 << bit)) {
            const v = signExt(memGet(s, addr, st), st) | 0;
            if (bit < 8) s[L.iD(bit)] = v;
            else s[L.iA(bit - 8)] = v;
            addr = (addr + st) | 0;
          }
        }
        if (d.ea.ea === "pinc") s[L.iA(d.ea.n)] = addr | 0;
      }
      break;
    }
    case "btst":
    case "bchg":
    case "bclr":
    case "bset": {
      const addr = eaOnce(s, d.dst, sz);
      const val = readAt(s, d.dst, sz, addr);
      const bn = (d.bitReg != null ? s[L.iD(d.bitReg)] : d.bitnum) & (sz === 4 ? 31 : 7);
      const bit = (val >>> bn) & 1;
      s[CCR] = (s[CCR] & ~L.Z) | (bit ? 0 : L.Z); // only Z affected
      if (d.op !== "btst") {
        const nv =
          d.op === "bset" ? val | (1 << bn) : d.op === "bclr" ? val & ~(1 << bn) : val ^ (1 << bn);
        writeAt(s, d.dst, sz, addr, nv >>> 0);
      }
      break;
    }
    case "mulu":
    case "muls": {
      const b = readEA(s, d.src, 2); // word source
      const a = s[L.iD(d.dn)] & 0xffff;
      const res = d.op === "mulu" ? (a * b) >>> 0 : (signExt(a, 2) * signExt(b, 2)) | 0;
      s[L.iD(d.dn)] = res | 0;
      s[CCR] = (s[CCR] & L.X) | nz(res, 4); // N,Z; V=C=0; X preserved
      break;
    }
    default:
      throw new Error(`interp: unhandled ${d.op}`);
  }
}

export function evalCond(cc, s) {
  const ccr = s[CCR];
  const C = (ccr & L.C) !== 0,
    V = (ccr & L.V) !== 0,
    Z = (ccr & L.Z) !== 0,
    N = (ccr & L.N) !== 0;
  switch (cc) {
    case 0:
      return true;
    case 1:
      return false;
    case 2:
      return !C && !Z;
    case 3:
      return C || Z;
    case 4:
      return !C;
    case 5:
      return C;
    case 6:
      return !Z;
    case 7:
      return Z;
    case 8:
      return !V;
    case 9:
      return V;
    case 10:
      return !N;
    case 11:
      return N;
    case 12:
      return N === V;
    case 13:
      return N !== V;
    case 14:
      return !Z && N === V;
    default:
      return Z || N !== V;
  }
}

export function interpBlock(block, s) {
  for (const d of block.instrs) execOne(d, s);
  const t = block.term;
  if (!t) {
    s[L.iPC] = block.fallPC;
    return;
  }
  if (t.op === "halt") {
    s[L.iPC] = L.HALT_PC;
    return;
  }
  if (t.op === "rte" || t.op === "rtr") {
    s[L.iPC] = t.pc | 0; // supervisor / format word — stays interpreted upstream
    return;
  }
  if (t.op === "jmp") {
    s[L.iPC] = t.ea ? eaAddr(s, t.ea, 4) | 0 : t.pc | 0;
    return;
  }
  if (t.op === "jsr") {
    if (!t.ea) {
      s[L.iPC] = t.pc | 0;
      return;
    }
    const target = eaAddr(s, t.ea, 4) | 0; // reads the OLD A7 if the EA is (A7)
    const sp = (s[L.iA(7)] - 4) | 0;
    s[L.iA(7)] = sp;
    memPut(s, sp, 4, block.fallPC >>> 0);
    s[L.iPC] = target;
    return;
  }
  if (t.op === "bsr") {
    const sp = (s[L.iA(7)] - 4) | 0;
    s[L.iA(7)] = sp;
    memPut(s, sp, 4, block.fallPC >>> 0);
    s[L.iPC] = (t.pc + 2 + t.disp) | 0;
    return;
  }
  if (t.op === "rts") {
    const sp = s[L.iA(7)] | 0;
    s[L.iPC] = memGet(s, sp, 4) | 0;
    s[L.iA(7)] = (sp + 4) | 0;
    return;
  }
  const target = (t.pc + 2 + t.disp) | 0;
  if (t.op === "bcc") {
    s[L.iPC] = evalCond(t.cc, s) ? target : block.fallPC;
    return;
  }
  if (evalCond(t.cc, s)) {
    s[L.iPC] = block.fallPC;
  } else {
    const dn = s[L.iD(t.dn)];
    const cnt = (dn - 1) & 0xffff;
    s[L.iD(t.dn)] = (dn & 0xffff0000) | cnt;
    s[L.iPC] = cnt !== 0xffff ? target : block.fallPC;
  }
}

export function runProgram(words, s, budget = 100000) {
  let steps = 0;
  while (steps < budget && (s[L.iPC] & 0xffff) !== L.HALT_PC) {
    interpBlock(blockAt(words, s[L.iPC]), s);
    steps++;
  }
  return steps;
}
