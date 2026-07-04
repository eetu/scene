// 68k decoder. Register/EA ALU ops (ADD/SUB/AND/OR/CMP/EOR), MOVE/MOVEA,
// TST/CLR/NEG/NOT, ADDQ/SUBQ, Scc, immediate ALU, shifts, MOVEM, and control
// flow — in .B/.W/.L sizes where the op has them (`sz` = 1/2/4 bytes on the
// instr). Returns null for unhandled opcodes (the JIT falls back to the
// interpreter there). Cursor-based so it consumes extension words.

export const sign8 = (v) => (v & 0x80 ? v - 0x100 : v) | 0;
export const sign16 = (v) => (v & 0x8000 ? v - 0x10000 : v) | 0;
const SZ = [1, 2, 4]; // size field 00/01/10 → bytes

// Effective address (mode, reg) at word index i, sized (for #imm width).
// ea: d|a|ind|pinc|pdec | {disp,n,d} | {abs,addr} | {absw,addr} | {imm,val}
function decodeEA(mode, reg, words, i, sz = 4) {
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
      if (reg === 0) return [{ ea: "absw", addr: sign16(words[i]) }, i + 1]; // abs.W
      if (reg === 1) return [{ ea: "abs", addr: (words[i] << 16) | words[i + 1] | 0 }, i + 2]; // abs.L
      if (reg === 4) {
        // #imm — width follows the operation size
        if (sz === 1) return [{ ea: "imm", val: words[i] & 0xff }, i + 1];
        if (sz === 2) return [{ ea: "imm", val: words[i] & 0xffff }, i + 1];
        return [{ ea: "imm", val: (words[i] << 16) | words[i + 1] | 0 }, i + 2];
      }
      return [null, i];
    default:
      return [null, i];
  }
}

export const isMem = (ea) => ea.ea !== "d" && ea.ea !== "a" && ea.ea !== "imm";
const isAlterableMem = (ea) => isMem(ea); // (An)/(An)+/-(An)/(d16,An)/abs — all writable
const dataAlterable = (ea) => ea.ea === "d" || isMem(ea); // no An, no imm, no PC-rel

/** Decode one instruction at words[i]. Returns [instr, nextIndex] or [null, i]. */
export function decodeAt(words, i) {
  const w = words[i];
  const size2 = (w >> 6) & 3; // common size field
  const regHi = (w >> 9) & 7;
  const eaMode = (w >> 3) & 7;
  const eaReg = w & 7;

  // MOVEQ #imm8,Dn : 0111 rrr0 dddddddd (always .L)
  if ((w & 0xf100) === 0x7000)
    return [{ op: "moveq", dn: regHi, imm: sign8(w & 0xff), sz: 4 }, i + 1];

  // MOVE.B/.W/.L + MOVEA.W/.L : 00 ss (dstReg dstMode)(srcMode srcReg)
  //   size: 01=B, 11=W, 10=L (MOVE's own encoding, not the common field)
  {
    const ms = w >> 12;
    if (ms === 1 || ms === 2 || ms === 3) {
      const sz = ms === 1 ? 1 : ms === 3 ? 2 : 4;
      const dstReg = regHi;
      const dstMode = (w >> 6) & 7;
      const [src, j] = decodeEA(eaMode, eaReg, words, i + 1, sz);
      if (!src) return [null, i];
      if (src.ea === "a" && sz === 1) return [null, i]; // byte can't read An
      if (dstMode === 1) {
        if (sz === 1) return [null, i]; // MOVEA is .W/.L only
        return [{ op: "movea", dst: { ea: "a", n: dstReg }, src, sz }, j];
      }
      const [dst, k] = decodeEA(dstMode, dstReg, words, j, sz);
      if (!dst || !dataAlterable(dst)) return [null, i];
      return [{ op: "move", dst, src, sz }, k];
    }
  }

  // ADDQ/SUBQ #d,<ea> : 0101 ddd s ss mmm rrr  (s: 0=ADDQ 1=SUBQ; ss size)
  if ((w & 0xf000) === 0x5000 && size2 !== 3) {
    const [ea, j] = decodeEA(eaMode, eaReg, words, i + 1, SZ[size2]);
    if (ea && ea.ea !== "imm" && (ea.ea === "a" || dataAlterable(ea))) {
      const d = regHi;
      return [
        { op: (w >> 8) & 1 ? "subq" : "addq", imm: d === 0 ? 8 : d, dst: ea, sz: SZ[size2] },
        j,
      ];
    }
  }
  // Scc <ea> : 0101 cccc 11 mmm rrr (size field 11, mode != 001 which is DBcc)
  if ((w & 0xf0c0) === 0x50c0 && eaMode !== 1) {
    const [ea, j] = decodeEA(eaMode, eaReg, words, i + 1, 1);
    if (ea && dataAlterable(ea)) return [{ op: "scc", cc: (w >> 8) & 0xf, dst: ea, sz: 1 }, j];
  }

  // Standard ALU: OR=8 SUB=9 CMP/EOR=B AND=C ADD=D
  {
    const fam = { 0x8: "or", 0x9: "sub", 0xb: "cmpeor", 0xc: "and", 0xd: "add" }[w >> 12];
    if (fam) {
      const opmode = (w >> 6) & 7;
      if (opmode === 3 || opmode === 7) {
        // <ea>,An : opmode 3=word, 7=long — ADDA/SUBA/CMPA (AND/OR have no An form)
        const sz = opmode === 3 ? 2 : 4;
        const aOp = { or: null, and: null, add: "adda", sub: "suba", cmpeor: "cmpa" }[fam];
        if (aOp) {
          const [src, j] = decodeEA(eaMode, eaReg, words, i + 1, sz);
          if (src) return [{ op: aOp, an: regHi, src, sz }, j];
        }
      } else if (opmode < 3) {
        // <ea>,Dn (result→Dn) size 0/1/2
        const sz = SZ[opmode];
        const [src, j] = decodeEA(eaMode, eaReg, words, i + 1, sz);
        // An source is only legal for ADD/SUB/CMP (.W/.L), never AND/OR
        const anOk =
          src && src.ea === "a"
            ? sz !== 1 && (fam === "add" || fam === "sub" || fam === "cmpeor")
            : true;
        if (src && anOk) return [{ op: fam === "cmpeor" ? "cmp" : fam, dn: regHi, src, sz }, j];
      } else {
        // opmode 4/5/6 → Dn,<ea> (result→ea). For fam B this is EOR (+ CMPM at mode 001).
        const sz = SZ[opmode - 4];
        if (fam === "cmpeor") {
          if (eaMode === 1) {
            // CMPM (An)+,(An)+ — skip for now
          } else {
            const [dst, j] = decodeEA(eaMode, eaReg, words, i + 1, sz);
            if (dst && dataAlterable(dst)) return [{ op: "eor", dn: regHi, dst, sz }, j];
          }
        } else if (fam !== "cmpeor") {
          const [dst, j] = decodeEA(eaMode, eaReg, words, i + 1, sz);
          if (dst && isAlterableMem(dst)) return [{ op: fam, dn: regHi, dst, memDst: true, sz }, j];
        }
      }
    }
  }

  // Immediate ALU #imm,<ea> : 0000 op ss mmm rrr — ORI/ANDI/SUBI/ADDI/EORI/CMPI
  {
    // op field = bits 11-9: ORI=0 ANDI=1 SUBI=2 ADDI=3 EORI=5 CMPI=6
    const immOp = { 0: "or", 1: "and", 2: "sub", 3: "add", 5: "eor", 6: "cmp" }[(w >> 9) & 7];
    if ((w & 0xf000) === 0x0000 && immOp !== undefined && size2 !== 3 && ((w >> 8) & 1) === 0) {
      const sz = SZ[size2];
      const val =
        sz === 4
          ? (words[i + 1] << 16) | words[i + 2] | 0
          : sz === 2
            ? words[i + 1] & 0xffff
            : words[i + 1] & 0xff;
      const j = i + 1 + (sz === 4 ? 2 : 1);
      const [dst, k] = decodeEA(eaMode, eaReg, words, j, sz);
      if (dst && dataAlterable(dst)) {
        if (immOp === "eor") return [{ op: "eori", dst, imm: val, sz }, k];
        return [{ op: immOp, dn: null, dst, src: { ea: "imm", val }, sz, immForm: true }, k];
      }
    }
  }

  // NOT/NEG/TST/CLR .B/.W/.L <ea> : 0100 0110/0100/1010/0010 ss mmm rrr
  {
    const misc = { 0x46: "not", 0x44: "neg", 0x4a: "tst", 0x42: "clr" }[(w >> 8) & 0xff];
    if (misc && size2 !== 3) {
      const sz = SZ[size2];
      const [ea, j] = decodeEA(eaMode, eaReg, words, i + 1, sz);
      if (ea && (misc === "tst" ? ea.ea !== "a" : dataAlterable(ea)))
        return [{ op: misc, dst: ea, sz }, j];
    }
  }

  // EXT.W/.L Dn : 0100 1000 1s 000 nnn (s: 0=W(byte→word) 1=L(word→long)); SWAP
  if ((w & 0xffb8) === 0x4880 && eaMode === 0)
    return [{ op: "ext", dn: eaReg, sz: (w >> 6) & 1 ? 4 : 2 }, i + 1];
  if ((w & 0xfff8) === 0x4840) return [{ op: "swap", dn: eaReg, sz: 4 }, i + 1];

  // LEA <ea>,An : 0100 nnn 111 mmm rrr
  if ((w & 0xf1c0) === 0x41c0) {
    const [src, j] = decodeEA(eaMode, eaReg, words, i + 1, 4);
    if (src && (src.ea === "ind" || src.ea === "disp" || src.ea === "abs" || src.ea === "absw"))
      return [{ op: "lea", an: regHi, src, sz: 4 }, j];
  }

  // MOVEM <list>,<ea> / <ea>,<list> : 0100 1d00 1s mmm rrr + mask word (s:0=W 1=L)
  if ((w & 0xfb80) === 0x4880) {
    const toMem = ((w >> 10) & 1) === 0; // bit10: 0=reg→mem, 1=mem→reg
    const sz = (w >> 6) & 1 ? 4 : 2;
    const mask = words[i + 1];
    const [ea, j] = decodeEA(eaMode, eaReg, words, i + 2, 4);
    if (ea && isMem(ea)) {
      // reg→mem allows -(An)/control-alterable; mem→reg allows (An)+/control
      const okDir = toMem
        ? ea.ea === "pdec" ||
          ea.ea === "ind" ||
          ea.ea === "disp" ||
          ea.ea === "abs" ||
          ea.ea === "absw"
        : ea.ea === "pinc" ||
          ea.ea === "ind" ||
          ea.ea === "disp" ||
          ea.ea === "abs" ||
          ea.ea === "absw";
      if (okDir) return [{ op: "movem", toMem, mask, ea, sz }, j];
    }
  }

  // Shift/rotate .B/.W/.L, reg (Dn) : 1110 ccc d ss i tt nnn
  //   i=0 immediate count (ccc, 0→8); i=1 count in D[ccc]; tt: 00 AS 01 LS 10 ROX 11 RO
  if ((w & 0xf000) === 0xe000 && size2 !== 3 && ((w >> 3) & 3) < 2) {
    const type = (w >> 3) & 3; // 0 arithmetic, 1 logical (skip ROX/RO = 2/3)
    const left = (w >> 8) & 1;
    const opBy = [
      ["asr", "asl"],
      ["lsr", "lsl"],
    ][type][left];
    const byReg = (w >> 5) & 1;
    const sz = SZ[size2];
    if (!byReg) return [{ op: opBy, cnt: regHi === 0 ? 8 : regHi, dn: eaReg, sz }, i + 1];
    return [{ op: opBy, cntReg: regHi, dn: eaReg, sz }, i + 1]; // count = D[regHi] mod 64
  }

  // ---- control flow / terminators (unchanged) ----
  if (w === 0x4e75) return [{ op: "rts", term: true }, i + 1];
  if (w === 0x4e73) return [{ op: "rte", term: true }, i + 1];
  if (w === 0x4e77) return [{ op: "rtr", term: true }, i + 1];
  if (w === 0x4e71) return [{ op: "nop" }, i + 1];
  {
    const isJsr = (w & 0xffc0) === 0x4e80;
    const isJmp = (w & 0xffc0) === 0x4ec0;
    if (isJsr || isJmp) {
      const mode = eaMode,
        reg = eaReg;
      let ext = 0;
      if (mode === 5 || mode === 6) ext = 1;
      else if (mode === 7 && reg === 0) ext = 1;
      else if (mode === 7 && reg === 1) ext = 2;
      else if (mode === 7 && (reg === 2 || reg === 3)) ext = 1;
      return [{ op: isJsr ? "jsr" : "jmp", term: true }, i + 1 + ext];
    }
  }
  if (w === 0x4afc) return [{ op: "halt", term: true }, i + 1];
  if ((w & 0xf000) === 0x6000) {
    const cc = (w >> 8) & 0xf;
    if (cc === 1) {
      const d8b = w & 0xff;
      if (d8b === 0) return [{ op: "bsr", disp: sign16(words[i + 1]), len: 4, term: true }, i + 2];
      return [{ op: "bsr", disp: sign8(d8b), len: 2, term: true }, i + 1];
    }
    const d8 = w & 0xff;
    if (d8 === 0) return [{ op: "bcc", cc, disp: sign16(words[i + 1]), len: 4, term: true }, i + 2];
    return [{ op: "bcc", cc, disp: sign8(d8), len: 2, term: true }, i + 1];
  }
  if ((w & 0xf0f8) === 0x50c8) {
    const cc = (w >> 8) & 0xf;
    return [{ op: "dbcc", cc, dn: eaReg, disp: sign16(words[i + 1]), len: 4, term: true }, i + 2];
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

/**
 * Split the basic block starting at byte address `pcByte`. Collects
 * non-terminator instructions until a control-flow op (term:true) or maxInstrs.
 * Returns { startPC, instrs, term, fallPC }.
 */
export function blockAt(words, pcByte, maxInstrs = 64) {
  let i = pcByte >> 1;
  const instrs = [];
  let term = null;
  while (instrs.length < maxInstrs && i < words.length) {
    const iByte = i * 2;
    const [instr, next] = decodeAt(words, i);
    if (!instr)
      throw new Error(`unhandled opcode 0x${words[i].toString(16).padStart(4, "0")} @${iByte}`);
    instr.pc = iByte;
    instr.len = (next - i) * 2;
    i = next;
    if (instr.term) {
      term = instr;
      break;
    }
    instrs.push(instr);
  }
  return { startPC: pcByte, instrs, term, fallPC: i * 2 };
}
