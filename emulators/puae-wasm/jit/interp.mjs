// Reference 68k interpreter for the MVP subset — the ORACLE the recompiler is
// validated against (jit/difftest.mjs). Operates on an Int32Array `s` laid out
// per layout.mjs (D0..D7, A0..A7, CCR, guest RAM cells).
import * as L from "./layout.mjs";
import { decodeBlock } from "./decode.mjs";

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

/** Run a block (raw words) against state s (Int32Array), in place. */
export function runInterp(words, s) {
  for (const d of decodeBlock(words)) {
    switch (d.op) {
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
      case "add": {
        const a = s[L.iD(d.dx)];
        const b = s[L.iD(d.dy)];
        const res = (a + b) | 0;
        s[L.iD(d.dx)] = res;
        s[CCR] = flagsAdd(a, b, res);
        break;
      }
      case "sub": {
        const a = s[L.iD(d.dx)];
        const b = s[L.iD(d.dy)];
        const res = (a - b) | 0;
        s[L.iD(d.dx)] = res;
        s[CCR] = flagsSub(a, b, res);
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
      case "and":
      case "or":
      case "eor": {
        // AND/OR to Dx; EOR of Dx into Dy. N,Z from result; V=C=0; X preserved.
        const dst = d.op === "eor" ? d.dy : d.dx;
        const a = s[L.iD(dst)];
        const b = d.op === "eor" ? s[L.iD(d.dx)] : s[L.iD(d.dy)];
        const res = (d.op === "and" ? a & b : d.op === "or" ? a | b : a ^ b) | 0;
        s[L.iD(dst)] = res;
        s[CCR] = (s[CCR] & L.X) | (res < 0 ? L.N : 0) | (res === 0 ? L.Z : 0);
        break;
      }
      case "cmp": {
        // Dx - Dy, flags only (no writeback). CMP does NOT affect X.
        const a = s[L.iD(d.dx)];
        const b = s[L.iD(d.dy)];
        const res = (a - b) | 0;
        s[CCR] = (flagsSub(a, b, res) & ~L.X) | (s[CCR] & L.X);
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
      default:
        throw new Error(`interp: unhandled ${d.op}`);
    }
  }
}
