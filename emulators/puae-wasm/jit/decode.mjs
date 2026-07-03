// 68k decoder (MVP subset), cursor-based so it can consume extension words.
// Handles register ALU ops (MOVEQ/ADDQ/ADD/SUB, register forms) and MOVE.L /
// MOVEA.L with effective-address modes. Returns null for unhandled opcodes (the
// real JIT falls back to the interpreter there).

export const sign8 = (v) => (v & 0x80 ? v - 0x100 : v);
export const sign16 = (v) => (v & 0x8000 ? v - 0x10000 : v);

// Decode an effective address (mode, reg) starting at word index i.
// Returns [ea, nextIndex] or [null, i] if the mode is unsupported.
//   ea: {ea:'d'|'a'|'ind'|'pinc'|'pdec', n} | {ea:'disp', n, d} |
//       {ea:'abs', addr} | {ea:'imm', val}
function decodeEA(mode, reg, words, i) {
  switch (mode) {
    case 0:
      return [{ ea: "d", n: reg }, i];
    case 1:
      return [{ ea: "a", n: reg }, i];
    case 2:
      return [{ ea: "ind", n: reg }, i];
    case 3:
      return [{ ea: "pinc", n: reg }, i];
    case 4:
      return [{ ea: "pdec", n: reg }, i];
    case 5:
      return [{ ea: "disp", n: reg, d: sign16(words[i]) }, i + 1];
    case 7:
      if (reg === 1) return [{ ea: "abs", addr: (words[i] << 16) | words[i + 1] | 0 }, i + 2]; // abs.L
      if (reg === 4) return [{ ea: "imm", val: (words[i] << 16) | words[i + 1] | 0 }, i + 2]; // #imm.L
      return [null, i];
    default:
      return [null, i];
  }
}

export const isMem = (ea) => ea.ea !== "d" && ea.ea !== "a" && ea.ea !== "imm";

/** Decode one instruction at words[i]. Returns [instr, nextIndex] or [null, i]. */
export function decodeAt(words, i) {
  const w = words[i];
  // MOVEQ #imm8,Dn : 0111 rrr0 dddddddd
  if ((w & 0xf100) === 0x7000)
    return [{ op: "moveq", dn: (w >> 9) & 7, imm: sign8(w & 0xff) }, i + 1];
  // ADDQ.L #d,Dn : 0101 ddd0 10 000 nnn
  if ((w & 0xf1f8) === 0x5080) {
    const d = (w >> 9) & 7;
    return [{ op: "addq", imm: d === 0 ? 8 : d, dn: w & 7 }, i + 1];
  }
  // ADD.L Dy,Dx : 1101 xxx0 10 000 yyy
  if ((w & 0xf1f8) === 0xd080) return [{ op: "add", dx: (w >> 9) & 7, dy: w & 7 }, i + 1];
  // SUB.L Dy,Dx : 1001 xxx0 10 000 yyy
  if ((w & 0xf1f8) === 0x9080) return [{ op: "sub", dx: (w >> 9) & 7, dy: w & 7 }, i + 1];
  // MOVE.L / MOVEA.L : 0010 (dstReg dstMode) (srcMode srcReg)
  if ((w & 0xf000) === 0x2000) {
    const dstReg = (w >> 9) & 7;
    const dstMode = (w >> 6) & 7;
    const srcMode = (w >> 3) & 7;
    const srcReg = w & 7;
    const [src, j] = decodeEA(srcMode, srcReg, words, i + 1);
    if (!src) return [null, i];
    if (dstMode === 1) return [{ op: "movea", dst: { ea: "a", n: dstReg }, src }, j]; // MOVEA.L
    const [dst, k] = decodeEA(dstMode, dstReg, words, j);
    if (!dst || dst.ea === "imm") return [null, i];
    return [{ op: "move", dst, src }, k];
  }
  return [null, i];
}

/** Decode a straight-line block (array of words). Throws on unhandled opcode. */
export function decodeBlock(words) {
  const out = [];
  let i = 0;
  while (i < words.length) {
    const [instr, next] = decodeAt(words, i);
    if (!instr)
      throw new Error(`unhandled opcode 0x${words[i].toString(16).padStart(4, "0")} @${i}`);
    out.push(instr);
    i = next;
  }
  return out;
}
