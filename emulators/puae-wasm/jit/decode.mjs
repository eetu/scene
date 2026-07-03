// 68k instruction decoder — MVP subset: straight-line data-register longword ops.
// Opcodes are 16-bit big-endian words. Returns null for anything unhandled (the
// real JIT will fall back to the interpreter for those). This is deliberately a
// small, authentic slice: MOVEQ, ADDQ.L, ADD.L Dy,Dx, SUB.L Dy,Dx — enough to
// prove decode → recompile → execute against a reference. Flags/EA-modes/control
// flow come next.

/** Sign-extend an 8-bit value to a JS int. */
export function sign8(v) {
  return v & 0x80 ? v - 0x100 : v;
}

/** Decode one opcode word → an instruction object, or null if unhandled. */
export function decodeOne(w) {
  // MOVEQ #imm8,Dn : 0111 rrr0 dddddddd
  if ((w & 0xf100) === 0x7000) {
    return { op: "moveq", dn: (w >> 9) & 7, imm: sign8(w & 0xff) };
  }
  // ADDQ.L #d,Dn (Dn direct) : 0101 ddd0 10 000 nnn  (d==0 means 8)
  if ((w & 0xf1f8) === 0x5080) {
    const d = (w >> 9) & 7;
    return { op: "addq", imm: d === 0 ? 8 : d, dn: w & 7 };
  }
  // ADD.L Dy,Dx (result→Dx) : 1101 xxx0 10 000 yyy
  if ((w & 0xf1f8) === 0xd080) {
    return { op: "add", dx: (w >> 9) & 7, dy: w & 7 };
  }
  // SUB.L Dy,Dx (Dx - Dy → Dx) : 1001 xxx0 10 000 yyy
  if ((w & 0xf1f8) === 0x9080) {
    return { op: "sub", dx: (w >> 9) & 7, dy: w & 7 };
  }
  return null;
}

/** Decode a straight-line block of words. Throws on an unhandled opcode. */
export function decodeBlock(words) {
  return words.map((w) => {
    const d = decodeOne(w);
    if (!d) throw new Error(`unhandled opcode 0x${w.toString(16).padStart(4, "0")}`);
    return d;
  });
}
