// Reference 68k interpreter for the MVP subset — the ORACLE the recompiler is
// validated against (jit/difftest.mjs). Operates on an Int32Array `s` laid out
// per layout.mjs (D0..D7, A0..A7, CCR, guest RAM cells).
import * as L from "./layout.mjs";
import { decodeBlock, blockAt } from "./decode.mjs";

export const CCR = L.iCCR;

function flagsAdd(a, b, res) {
  const c = res >>> 0 < a >>> 0 ? L.C : 0;
  const v = ((a ^ res) & (b ^ res)) < 0 ? L.V : 0;
  return (res < 0 ? L.N : 0) | (res === 0 ? L.Z : 0) | v | c | (c ? L.X : 0);
}
function flagsSub(a, b, res) {
  const c = a >>> 0 < b >>> 0 ? L.C : 0;
  const v = ((a ^ b) & (a ^ res)) < 0 ? L.V : 0;
  return (res < 0 ? L.N : 0) | (res === 0 ? L.Z : 0) | v | c | (c ? L.X : 0);
}

// Effective address (guest addr), applying (An)+ / -(An) side effects.
function eaAddr(s, ea) {
  switch (ea.ea) {
    case "ind":
      return s[L.iA(ea.n)];
    case "pinc": {
      const a = s[L.iA(ea.n)];
      s[L.iA(ea.n)] = (a + 4) | 0;
      return a;
    }
    case "pdec": {
      const a = (s[L.iA(ea.n)] - 4) | 0;
      s[L.iA(ea.n)] = a;
      return a;
    }
    case "disp":
      return (s[L.iA(ea.n)] + ea.d) | 0;
    case "abs":
      return ea.addr;
  }
  throw new Error(`eaAddr: not a memory EA (${ea.ea})`);
}
function readEA(s, ea) {
  switch (ea.ea) {
    case "d":
      return s[L.iD(ea.n)];
    case "a":
      return s[L.iA(ea.n)];
    case "imm":
      return ea.val | 0;
    default:
      return s[L.iCell(eaAddr(s, ea))];
  }
}
function writeEA(s, ea, val) {
  switch (ea.ea) {
    case "d":
      s[L.iD(ea.n)] = val | 0;
      break;
    case "a":
      s[L.iA(ea.n)] = val | 0;
      break;
    default:
      s[L.iCell(eaAddr(s, ea))] = val | 0;
      break;
  }
}

/** Execute one non-control-flow instruction against state s. */
export function execOne(d, s) {
  switch (d.op) {
    case "nop":
      break;
    case "moveq": {
      const res = d.imm | 0;
      s[L.iD(d.dn)] = res;
      s[CCR] = (s[CCR] & L.X) | (res < 0 ? L.N : 0) | (res === 0 ? L.Z : 0);
      break;
    }
    case "addq": {
      const a = s[L.iD(d.dn)];
      const res = (a + d.imm) | 0;
      s[L.iD(d.dn)] = res;
      s[CCR] = flagsAdd(a, d.imm, res);
      break;
    }
    // For <ea>,Dn/An ops the SOURCE EA is evaluated first (its (An)+/-(An) side
    // effects happen before the destination is read) — matches real 68k and the
    // recompiler (which runs eaAddr before loading the destination register).
    case "add": {
      const b = readEA(s, d.src);
      const a = s[L.iD(d.dn)];
      const res = (a + b) | 0;
      s[L.iD(d.dn)] = res;
      s[CCR] = flagsAdd(a, b, res);
      break;
    }
    case "sub": {
      const b = readEA(s, d.src);
      const a = s[L.iD(d.dn)];
      const res = (a - b) | 0;
      s[L.iD(d.dn)] = res;
      s[CCR] = flagsSub(a, b, res);
      break;
    }
    case "and":
    case "or": {
      const b = readEA(s, d.src);
      const a = s[L.iD(d.dn)];
      const res = (d.op === "and" ? a & b : a | b) | 0;
      s[L.iD(d.dn)] = res;
      s[CCR] = (s[CCR] & L.X) | (res < 0 ? L.N : 0) | (res === 0 ? L.Z : 0);
      break;
    }
    case "cmp": {
      const b = readEA(s, d.src);
      const a = s[L.iD(d.dn)];
      const res = (a - b) | 0;
      s[CCR] = (flagsSub(a, b, res) & ~L.X) | (s[CCR] & L.X);
      break;
    }
    case "eor": {
      // EOR.L Dx,Dy (Dy ^= Dx). N,Z from result; V=C=0; X preserved.
      const a = s[L.iD(d.dy)];
      const res = (a ^ s[L.iD(d.dx)]) | 0;
      s[L.iD(d.dy)] = res;
      s[CCR] = (s[CCR] & L.X) | (res < 0 ? L.N : 0) | (res === 0 ? L.Z : 0);
      break;
    }
    case "move": {
      const val = readEA(s, d.src); // src side effects first
      writeEA(s, d.dst, val); // then dst side effects
      s[CCR] = (s[CCR] & L.X) | (val < 0 ? L.N : 0) | (val === 0 ? L.Z : 0); // NZ, V=C=0
      break;
    }
    case "movea": {
      s[L.iA(d.dst.n)] = readEA(s, d.src) | 0; // MOVEA.L: no flags
      break;
    }
    case "not": {
      const res = ~s[L.iD(d.dn)] | 0;
      s[L.iD(d.dn)] = res;
      s[CCR] = (s[CCR] & L.X) | (res < 0 ? L.N : 0) | (res === 0 ? L.Z : 0);
      break;
    }
    case "neg": {
      const b = s[L.iD(d.dn)];
      const res = (0 - b) | 0;
      s[L.iD(d.dn)] = res;
      s[CCR] = flagsSub(0, b, res); // X:=C, correct for NEG
      break;
    }
    case "asl":
    case "lsl":
    case "asr":
    case "lsr": {
      // .L shift by immediate count n (1..8). C = last bit shifted out; X:=C;
      // N,Z from result; V=0 except ASL (set if the sign bit changed).
      const n = d.cnt;
      const v = s[L.iD(d.dn)];
      const left = d.op === "asl" || d.op === "lsl";
      const res = (left ? v << n : d.op === "asr" ? v >> n : v >>> n) | 0;
      const c = (left ? (v >>> (32 - n)) & 1 : (v >>> (n - 1)) & 1) ? L.C : 0;
      let vf = 0;
      if (d.op === "asl") {
        const top = v >> (31 - n); // arithmetic: 0 or -1 iff sign bits all equal
        vf = top === 0 || top === -1 ? 0 : L.V;
      }
      s[L.iD(d.dn)] = res;
      s[CCR] = (res < 0 ? L.N : 0) | (res === 0 ? L.Z : 0) | vf | c | (c ? L.X : 0);
      break;
    }
    case "eori": {
      // EORI #imm,Dn. N,Z; V=C=0; X preserved.
      const res = (s[L.iD(d.dn)] ^ d.imm) | 0;
      s[L.iD(d.dn)] = res;
      s[CCR] = (s[CCR] & L.X) | (res < 0 ? L.N : 0) | (res === 0 ? L.Z : 0);
      break;
    }
    case "tst": {
      // TST <ea> — flags from the value, no writeback; V=C=0; X preserved.
      const v = readEA(s, d.src);
      s[CCR] = (s[CCR] & L.X) | (v < 0 ? L.N : 0) | (v === 0 ? L.Z : 0);
      break;
    }
    case "clr": {
      // CLR <ea> — write 0; Z=1, N=V=C=0, X preserved.
      writeEA(s, d.dst, 0);
      s[CCR] = (s[CCR] & L.X) | L.Z;
      break;
    }
    case "adda": {
      const b = readEA(s, d.src); // src first (side effects), then read An
      s[L.iA(d.an)] = (s[L.iA(d.an)] + b) | 0; // no flags
      break;
    }
    case "suba": {
      const b = readEA(s, d.src);
      s[L.iA(d.an)] = (s[L.iA(d.an)] - b) | 0; // no flags
      break;
    }
    case "cmpa": {
      // An - src, flags only; X preserved.
      const b = readEA(s, d.src);
      const a = s[L.iA(d.an)];
      const res = (a - b) | 0;
      s[CCR] = (flagsSub(a, b, res) & ~L.X) | (s[CCR] & L.X);
      break;
    }
    case "lea": {
      s[L.iA(d.an)] = eaAddr(s, d.src) | 0; // effective address, no load, no flags
      break;
    }
    case "ext": {
      // EXT.L: sign-extend low word to long. N,Z; V=C=0; X preserved.
      const res = ((s[L.iD(d.dn)] << 16) >> 16) | 0;
      s[L.iD(d.dn)] = res;
      s[CCR] = (s[CCR] & L.X) | (res < 0 ? L.N : 0) | (res === 0 ? L.Z : 0);
      break;
    }
    case "swap": {
      // SWAP: exchange upper/lower words. N,Z on full 32-bit; V=C=0; X preserved.
      const x = s[L.iD(d.dn)];
      const res = (x >>> 16) | (x << 16) | 0;
      s[L.iD(d.dn)] = res;
      s[CCR] = (s[CCR] & L.X) | (res < 0 ? L.N : 0) | (res === 0 ? L.Z : 0);
      break;
    }
    default:
      throw new Error(`interp: unhandled ${d.op}`);
  }
}

// Evaluate a 68k condition code (0..15) against CCR in state s → boolean.
export function evalCond(cc, s) {
  const ccr = s[CCR];
  const C = (ccr & L.C) !== 0,
    V = (ccr & L.V) !== 0,
    Z = (ccr & L.Z) !== 0,
    N = (ccr & L.N) !== 0;
  switch (cc) {
    case 0:
      return true; // T
    case 1:
      return false; // F
    case 2:
      return !C && !Z; // HI
    case 3:
      return C || Z; // LS
    case 4:
      return !C; // CC/HS
    case 5:
      return C; // CS/LO
    case 6:
      return !Z; // NE
    case 7:
      return Z; // EQ
    case 8:
      return !V; // VC
    case 9:
      return V; // VS
    case 10:
      return !N; // PL
    case 11:
      return N; // MI
    case 12:
      return N === V; // GE
    case 13:
      return N !== V; // LT
    case 14:
      return !Z && N === V; // GT
    default:
      return Z || N !== V; // LE (15)
  }
}

// Execute a basic block (from blockAt) against state s, updating PC.
export function interpBlock(block, s) {
  for (const d of block.instrs) execOne(d, s);
  const t = block.term;
  if (!t) {
    s[L.iPC] = block.fallPC; // hit maxInstrs → fall through
    return;
  }
  if (t.op === "halt") {
    s[L.iPC] = L.HALT_PC;
    return;
  }
  const target = (t.pc + 2 + t.disp) | 0;
  if (t.op === "bcc") {
    s[L.iPC] = evalCond(t.cc, s) ? target : block.fallPC;
    return;
  }
  // dbcc: if cond true → fall through (no decrement); else decrement Dn.w and
  // branch unless it wrapped past 0 (word == -1).
  if (evalCond(t.cc, s)) {
    s[L.iPC] = block.fallPC;
  } else {
    const dn = s[L.iD(t.dn)];
    const cnt = (dn - 1) & 0xffff;
    s[L.iD(t.dn)] = (dn & 0xffff0000) | cnt;
    s[L.iPC] = cnt !== 0xffff ? target : block.fallPC;
  }
}

// Run a program (words) from state s.PC until HALT_PC or the block budget.
export function runProgram(words, s, budget = 100000) {
  let steps = 0;
  while (steps < budget && (s[L.iPC] & 0xffff) !== L.HALT_PC) {
    interpBlock(blockAt(words, s[L.iPC]), s);
    steps++;
  }
  return steps;
}

/** Run a straight-line block (raw words) against state s, in place. */
export function runInterp(words, s) {
  for (const d of decodeBlock(words)) execOne(d, s);
}
