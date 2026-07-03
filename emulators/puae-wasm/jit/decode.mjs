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
  // EOR.L Dx,Dy (Dy ^= Dx) : 1011 xxx1 10 000 yyy  (checked before the general
  // <ea>,Dn forms below, which require opmode 010)
  if ((w & 0xf1f8) === 0xb180) return [{ op: "eor", dx: (w >> 9) & 7, dy: w & 7 }, i + 1];
  // ADD/SUB/AND/OR/CMP.L <ea>,Dn : cccc nnn 010 mmm rrr  (opmode 010 = long, →Dn)
  // The old Dy,Dx forms are the ea=Dn (mode 000) special case of these.
  {
    const eaAlu = { 0xd080: "add", 0x9080: "sub", 0xc080: "and", 0x8080: "or", 0xb080: "cmp" };
    const op = eaAlu[w & 0xf1c0];
    if (op) {
      const [src, j] = decodeEA((w >> 3) & 7, w & 7, words, i + 1);
      if (src) return [{ op, dn: (w >> 9) & 7, src }, j];
    }
  }
  // NOT.L Dn : 0100 0110 10 000 nnn
  if ((w & 0xfff8) === 0x4680) return [{ op: "not", dn: w & 7 }, i + 1];
  // NEG.L Dn : 0100 0100 10 000 nnn
  if ((w & 0xfff8) === 0x4480) return [{ op: "neg", dn: w & 7 }, i + 1];
  // EXT.L Dn : 0100 1000 11 000 nnn ; SWAP Dn : 0100 1000 01 000 nnn
  if ((w & 0xfff8) === 0x48c0) return [{ op: "ext", dn: w & 7 }, i + 1];
  if ((w & 0xfff8) === 0x4840) return [{ op: "swap", dn: w & 7 }, i + 1];
  // Immediate ALU .L → Dn : ORI/ANDI/SUBI/ADDI/EORI/CMPI #imm32,Dn (dst mode 000)
  {
    const imm = {
      0x0080: "or",
      0x0280: "and",
      0x0480: "sub",
      0x0680: "add",
      0x0a80: "eori",
      0x0c80: "cmp",
    };
    const op = imm[w & 0xfff8];
    if (op) {
      const val = (words[i + 1] << 16) | words[i + 2] | 0;
      if (op === "eori") return [{ op: "eori", dn: w & 7, imm: val }, i + 3];
      return [{ op, dn: w & 7, src: { ea: "imm", val } }, i + 3];
    }
  }
  // TST.L <ea> : 0100 1010 10 mmm rrr
  if ((w & 0xffc0) === 0x4a80) {
    const [src, j] = decodeEA((w >> 3) & 7, w & 7, words, i + 1);
    if (src && src.ea !== "a") return [{ op: "tst", src }, j];
  }
  // CLR.L <ea> : 0100 0010 10 mmm rrr
  if ((w & 0xffc0) === 0x4280) {
    const [dst, j] = decodeEA((w >> 3) & 7, w & 7, words, i + 1);
    if (dst && dst.ea !== "a" && dst.ea !== "imm") return [{ op: "clr", dst }, j];
  }
  // ADDA/SUBA/CMPA.L <ea>,An (opmode 111) ; LEA <ea>,An
  {
    const aOps = { 0xd1c0: "adda", 0x91c0: "suba", 0xb1c0: "cmpa", 0x41c0: "lea" };
    const op = aOps[w & 0xf1c0];
    if (op) {
      const [src, j] = decodeEA((w >> 3) & 7, w & 7, words, i + 1);
      // LEA needs a control address (no Dn/An/imm/(An)+/-(An))
      const okLea = src && (src.ea === "ind" || src.ea === "disp" || src.ea === "abs");
      if (op === "lea" ? okLea : src) return [{ op, an: (w >> 9) & 7, src }, j];
    }
  }
  // Shift/rotate .L, immediate count : 1110 ccc d 10 0 tt nnn  (cnt 1..8, 0→8)
  {
    const shf = { 0xe080: "asr", 0xe180: "asl", 0xe088: "lsr", 0xe188: "lsl" };
    const op = shf[w & 0xf1f8];
    if (op) {
      const c = (w >> 9) & 7;
      return [{ op, cnt: c === 0 ? 8 : c, dn: w & 7 }, i + 1];
    }
  }
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
  // Control-flow terminators — the JIT compiles the straight-line body BEFORE
  // one of these, returns the terminator's own PC, and lets the interpreter take
  // the actual transfer (so JSR/RTS/JMP linkage + stack stay the interpreter's
  // job). Recognising them here is the biggest coverage lever (probe: JMP/JSR/RTS
  // are ~80% of live decode misses). New ops → codegen adds them in M2; until
  // then a block that reaches one still JITs everything up to it.
  if (w === 0x4e75) return [{ op: "rts", term: true }, i + 1];
  if (w === 0x4e73) return [{ op: "rte", term: true }, i + 1];
  if (w === 0x4e77) return [{ op: "rtr", term: true }, i + 1];
  if (w === 0x4e71) return [{ op: "nop" }, i + 1]; // no-op (non-terminator)
  {
    const isJsr = (w & 0xffc0) === 0x4e80;
    const isJmp = (w & 0xffc0) === 0x4ec0;
    if (isJsr || isJmp) {
      // length from the control-addressing EA, so fallPC/next stay correct
      const mode = (w >> 3) & 7,
        reg = w & 7;
      let ext = 0;
      if (mode === 5 || mode === 6) ext = 1; // (d16,An) / (d8,An,Xn)
      else if (mode === 7 && reg === 0) ext = 1; // abs.W
      else if (mode === 7 && reg === 1) ext = 2; // abs.L
      else if (mode === 7 && (reg === 2 || reg === 3)) ext = 1; // (d16,PC)/(d8,PC,Xn)
      return [{ op: isJsr ? "jsr" : "jmp", term: true }, i + 1 + ext];
    }
  }
  // ILLEGAL 0x4AFC — used here as a HALT sentinel for the runner/tests.
  if (w === 0x4afc) return [{ op: "halt", term: true }, i + 1];
  // Bcc / BRA : 0110 cccc dddddddd  (cc=0 BRA; cc=1 BSR, unsupported)
  if ((w & 0xf000) === 0x6000) {
    const cc = (w >> 8) & 0xf;
    if (cc === 1) {
      // BSR — a terminator like JSR (interpreter takes the call + stack push)
      const d8b = w & 0xff;
      if (d8b === 0) return [{ op: "bsr", disp: sign16(words[i + 1]), len: 4, term: true }, i + 2];
      return [{ op: "bsr", disp: sign8(d8b), len: 2, term: true }, i + 1];
    }
    const d8 = w & 0xff;
    // pc0 = byte address of this instruction; targets are relative to pc0+2.
    if (d8 === 0) {
      const disp = sign16(words[i + 1]);
      return [{ op: "bcc", cc, disp, len: 4, term: true }, i + 2];
    }
    return [{ op: "bcc", cc, disp: sign8(d8), len: 2, term: true }, i + 1];
  }
  // DBcc : 0101 cccc 11 001 rrr  + 16-bit disp
  if ((w & 0xf0f8) === 0x50c8) {
    const cc = (w >> 8) & 0xf;
    const disp = sign16(words[i + 1]);
    return [{ op: "dbcc", cc, dn: w & 7, disp, len: 4, term: true }, i + 2];
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
 * Split the basic block starting at byte address `pcByte` from a program (array
 * of words). Collects non-terminator instructions until a control-flow op
 * (term:true) or `maxInstrs`. Returns { startPC, instrs, term, fallPC } where
 * term is the terminator instr (with .pc set) or null (block hit maxInstrs), and
 * fallPC is the byte address immediately after the block (the not-taken path).
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
