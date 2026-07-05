// Differential test: OUR JIT codegen (coreblock.mjs) vs a real 68020 (Musashi
// oracle binary) — the independent oracle our self-referential difftests lacked.
// Stage 1: REGISTER-ONLY instructions (no memory EA) so there's no memory-image
// alignment to worry about; this covers the likely-buggy ops (shifts/rotates with
// X/V, MUL, flag edges). Compares D0-7, A0-7, CCR (X N Z V C), and next PC.
//
//   node musashi-difftest.mjs [trials]
import { spawn } from "node:child_process";
import { recompileCoreBlock } from "../jit/coreblock.mjs";
import { blockAt } from "../jit/decode.mjs";
import * as L from "../jit/layout.mjs";

const ORACLE = "../m68k-oracle (build: see musashi-oracle.md)";
const TRIALS = Number(process.argv[2] || 20000);
const PC = 0x1000;
const RB = 1024,
  FB = 1024 + 64;

// deterministic RNG so failures reproduce
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = rng(0xc0ffee01);
const ri = (n) => Math.floor(rnd() * n);
const r32 = () => (rnd() * 4294967296) >>> 0;
const pick = (a) => a[ri(a.length)];
const bits = (mode, reg) => (mode << 3) | reg;
// brief index extension word (bit8=0): ireg<<12 | long<<11 | scale<<9 | disp8
const briefExt = () => ((ri(16) << 12) | (ri(2) ? 0x800 : 0) | (ri(4) << 9) | ri(256)) & 0xfeff;

// ---- register-only instruction generators (subset the JIT handles) ----
const dEA = () => ({ mode: 0, reg: ri(8), ext: [] });
const imm = (sz) =>
  sz === 4
    ? { mode: 7, reg: 4, ext: [ri(0x10000), ri(0x10000)] }
    : { mode: 7, reg: 4, ext: [ri(0x10000)] };
const w = (op, ea, extra = []) => [op | bits(ea.mode, ea.reg), ...(extra || []), ...ea.ext];

// control/address EAs for LEA (no memory access — pure address computation)
const ctlEA = () =>
  pick([
    () => ({ mode: 2, reg: ri(8), ext: [] }), // (An)
    () => ({ mode: 5, reg: ri(8), ext: [ri(0x10000)] }), // (d16,An)
    () => ({ mode: 6, reg: ri(8), ext: [briefExt()] }), // (d8,An,Xn)
    () => ({ mode: 7, reg: 0, ext: [ri(0x10000)] }), // abs.W (sign-extended!)
    () => ({ mode: 7, reg: 1, ext: [ri(0x10000), ri(0x10000)] }), // abs.L
  ])();

function genRegOnly() {
  switch (ri(30)) {
    case 24:
    case 25:
    case 26:
    case 27: {
      // LEA <ea>,An — isolates EA address computation (index mode, abs.W sign-ext)
      const ea = ctlEA();
      return [0x41c0 | (ri(8) << 9) | bits(ea.mode, ea.reg), ...ea.ext];
    }
    case 0:
      return [0x7000 | (ri(8) << 9) | ri(256)]; // MOVEQ
    case 1: {
      // MOVE.B/W/L Dn,Dn  (also imm src)
      const sf = pick([1, 3, 2]);
      const src = pick([dEA, () => imm(sf === 1 ? 1 : sf === 3 ? 2 : 4)])();
      const dr = ri(8);
      return [(sf << 12) | (dr << 9) | (0 << 6) | bits(src.mode, src.reg), ...src.ext];
    }
    case 2: {
      // MOVEA.W/L <ea>,An (Dn or An or imm src)
      const sf = pick([3, 2]);
      const src = pick([
        dEA,
        () => ({ mode: 1, reg: ri(8), ext: [] }),
        () => imm(sf === 3 ? 2 : 4),
      ])();
      return [(sf << 12) | (ri(8) << 9) | (1 << 6) | bits(src.mode, src.reg), ...src.ext];
    }
    case 3:
    case 4:
    case 5: {
      // ADD/SUB/CMP <ea>,Dn   (opm 0..2)
      const base = pick([0xd000, 0x9000, 0xb000]);
      const opm = ri(3);
      const src = pick([dEA, () => imm([1, 2, 4][opm])])();
      return [base | (ri(8) << 9) | (opm << 6) | bits(src.mode, src.reg), ...src.ext];
    }
    case 6: {
      // AND/OR <ea>,Dn
      const base = pick([0xc000, 0x8000]);
      const opm = ri(3);
      const src = pick([dEA, () => imm([1, 2, 4][opm])])();
      return [base | (ri(8) << 9) | (opm << 6) | bits(src.mode, src.reg), ...src.ext];
    }
    case 7: {
      // ADD/SUB/AND/OR Dn,Dn  (opm 4..6, dst = Dn)
      const base = pick([0xd000, 0x9000, 0xc000, 0x8000]);
      const opm = pick([4, 5, 6]);
      return [base | (ri(8) << 9) | (opm << 6) | bits(0, ri(8))];
    }
    case 8: {
      // EOR Dn,Dn (opm 4..6)
      const opm = pick([4, 5, 6]);
      return [0xb000 | (ri(8) << 9) | (opm << 6) | bits(0, ri(8))];
    }
    case 9: {
      // immediate ALU: ORI/ANDI/SUBI/ADDI/EORI/CMPI #,Dn
      const of = pick([0, 1, 2, 3, 5, 6]);
      const size = ri(3);
      const sz = [1, 2, 4][size];
      const immw = sz === 4 ? [ri(0x10000), ri(0x10000)] : [ri(0x10000)];
      return [(of << 9) | (size << 6) | bits(0, ri(8)), ...immw];
    }
    case 10: {
      // ADDQ/SUBQ #,Dn  and  #,An
      const size = ri(3);
      const dst = pick([dEA, () => ({ mode: 1, reg: ri(8), ext: [] })])();
      if (dst.mode === 1 && size === 0) return genRegOnly();
      return [0x5000 | (ri(8) << 9) | (ri(2) << 8) | (size << 6) | bits(dst.mode, dst.reg)];
    }
    case 11: {
      // ADDA/SUBA/CMPA <ea>,An
      const opm = pick([3, 7]);
      const src = pick([
        dEA,
        () => ({ mode: 1, reg: ri(8), ext: [] }),
        () => imm(opm === 3 ? 2 : 4),
      ])();
      return [
        pick([0xd0c0, 0x90c0, 0xb0c0]) | (ri(8) << 9) | ((opm & 4) << 6) | bits(src.mode, src.reg),
        ...src.ext,
      ];
    }
    case 12:
      return [0x4a00 | (ri(3) << 6) | bits(0, ri(8))]; // TST Dn
    case 13:
      return [0x4200 | (ri(3) << 6) | bits(0, ri(8))]; // CLR Dn
    case 14:
      return [0x4400 | (ri(3) << 6) | bits(0, ri(8))]; // NEG Dn
    case 15:
      return [0x4000 | (ri(3) << 6) | bits(0, ri(8))]; // NEGX Dn
    case 16:
      return [0x4600 | (ri(3) << 6) | bits(0, ri(8))]; // NOT Dn
    case 17:
      return [0x4880 | ((ri(2) ? 1 : 0) << 6) | ri(8)]; // EXT.W/.L
    case 18:
      return [0x4840 | ri(8)]; // SWAP
    case 19: {
      // shift/rotate: imm or reg count, all 8 types, size B/W/L, on Dn
      const size = ri(3);
      const type = ri(4); // 0 AS,1 LS,2 ROX,3 RO
      const left = ri(2);
      if (ri(2)) {
        const cnt = ri(8); // imm count (0→8)
        return [0xe000 | (cnt << 9) | (left << 8) | (size << 6) | (type << 3) | ri(8)];
      }
      const cr = ri(8); // reg count
      return [0xe000 | (cr << 9) | (left << 8) | (size << 6) | (1 << 5) | (type << 3) | ri(8)];
    }
    case 20: {
      // MULU/MULS <ea>,Dn (Dn or imm src)
      const base = ri(2) ? 0xc0c0 : 0xc1c0;
      const src = pick([dEA, () => imm(2)])();
      return [base | (ri(8) << 9) | bits(src.mode, src.reg), ...src.ext];
    }
    case 21:
      return [0x50c0 | (pick([0, 1, 2, 3, 4, 5, 6, 7, 12, 13]) << 8) | bits(0, ri(8))]; // Scc Dn
    case 22: {
      // static bit op on Dn: 0000 1000 tt 000 rrr + bit#
      const tt = ri(4);
      return [0x0800 | (tt << 6) | bits(0, ri(8)), ri(256)];
    }
    case 23: {
      // dynamic bit op on Dn
      const tt = ri(4);
      return [0x0100 | (ri(8) << 9) | (tt << 6) | bits(0, ri(8))];
    }
    default:
      return [0x4e71];
  }
}

const packedToMd = (ccr) => ({
  cznv:
    ((ccr & L.N ? 1 << 15 : 0) |
      (ccr & L.Z ? 1 << 14 : 0) |
      (ccr & L.C ? 1 << 8 : 0) |
      (ccr & L.V ? 1 : 0)) >>>
    0,
  x: ccr & L.X ? 1 << 8 : 0,
});
const mdToPacked = (cznv, x) =>
  ((cznv >>> 15) & 1 ? L.N : 0) |
  ((cznv >>> 14) & 1 ? L.Z : 0) |
  ((cznv >>> 8) & 1 ? L.C : 0) |
  (cznv & 1 ? L.V : 0) |
  ((x >>> 8) & 1 ? L.X : 0);
const hx = (n) => (n >>> 0).toString(16);

// ---- persistent oracle process with line request/response ----
function makeOracle() {
  const p = spawn(ORACLE, [], { stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const waiters = [];
  p.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const wr = waiters.shift();
      if (wr) wr(line.trim());
    }
  });
  const ask = (line) =>
    new Promise((res) => {
      waiters.push(res);
      p.stdin.write(line + "\n");
    });
  return { ask, kill: () => p.kill() };
}

async function main() {
  const oracle = makeOracle();
  const failsByOp = new Map();
  let pass = 0,
    fail = 0,
    skip = 0;

  for (let t = 0; t < TRIALS; t++) {
    const words = genRegOnly();
    let block;
    try {
      block = blockAt(words, 0); // decode at word-array offset 0; startPC=0
    } catch {
      skip++;
      continue;
    }
    if (!block.instrs.length) {
      skip++;
      continue;
    }
    const op = block.instrs[0].op + "." + (block.instrs[0].sz || 4);

    const D = Array.from({ length: 8 }, () => r32());
    const A = Array.from({ length: 8 }, () => r32());
    const ccr = ri(32); // random X N Z V C

    // OUR codegen
    let gotPC = 0,
      cbErr = null;
    const mem = new WebAssembly.Memory({ initial: 1 });
    const dv = new DataView(mem.buffer);
    for (let i = 0; i < 8; i++) {
      dv.setInt32(RB + i * 4, D[i], true);
      dv.setInt32(RB + 32 + i * 4, A[i], true);
    }
    const md = packedToMd(ccr);
    dv.setUint32(FB, md.cznv, true);
    dv.setUint32(FB + 4, md.x, true);
    const dummy = () => 0;
    const env = {
      memory: mem,
      get_byte: dummy,
      get_word: dummy,
      get_long: dummy,
      put_byte: dummy,
      put_word: dummy,
      put_long: dummy,
    };
    try {
      const inst = await WebAssembly.instantiate(
        await WebAssembly.compile(recompileCoreBlock(block, { regsBase: RB, regflagsBase: FB })),
        { env },
      );
      gotPC = inst.exports.block() | 0;
    } catch (e) {
      cbErr = String(e);
    }
    if (cbErr) {
      if (/unhandled|unsupported/.test(cbErr)) {
        skip++;
        continue;
      }
      // real codegen crash — record
      const rec = failsByOp.get(op) || { n: 0, ex: [] };
      rec.n++;
      if (rec.ex.length < 3) rec.ex.push({ words: words.map(hx), err: cbErr });
      failsByOp.set(op, rec);
      fail++;
      continue;
    }
    const ourD = Array.from({ length: 8 }, (_, i) => dv.getInt32(RB + i * 4, true) >>> 0);
    const ourA = Array.from({ length: 8 }, (_, i) => dv.getInt32(RB + 32 + i * 4, true) >>> 0);
    const ourCcr = mdToPacked(dv.getUint32(FB, true) >>> 0, dv.getUint32(FB + 4, true) >>> 0);

    // MUSASHI oracle
    const sr = 0x2000 | ccr; // supervisor + CCR
    const line =
      [...D, ...A, sr, PC].map((x) => hx(x)).join(" ") +
      " " +
      hx(words.length) +
      " " +
      words.map((x) => hx(x & 0xffff)).join(" ") +
      " 0";
    const res = (await oracle.ask(line)).split(/\s+/).map((x) => parseInt(x, 16) >>> 0);
    const mD = res.slice(0, 8);
    const mA = res.slice(8, 16);
    const mSr = res[16];
    const mPC = res[17];
    const mCcr = mSr & 0x1f;

    // compare
    const bad = [];
    for (let i = 0; i < 8; i++)
      if (ourD[i] !== mD[i]) bad.push(`D${i}:${hx(ourD[i])}≠${hx(mD[i])}`);
    for (let i = 0; i < 8; i++)
      if (ourA[i] !== mA[i]) bad.push(`A${i}:${hx(ourA[i])}≠${hx(mA[i])}`);
    if (ourCcr !== mCcr) bad.push(`CCR:${hx(ourCcr)}≠${hx(mCcr)}`);
    // our block startPC=0 → gotPC is the byte length; Musashi ran at PC, so its
    // advance is mPC-PC. Compare the deltas (reg-only has no PC-relative EAs).
    if (gotPC >>> 0 !== (mPC - PC) >>> 0) bad.push(`PCΔ:${hx(gotPC)}≠${hx((mPC - PC) >>> 0)}`);

    if (bad.length === 0) pass++;
    else {
      fail++;
      const rec = failsByOp.get(op) || { n: 0, ex: [] };
      rec.n++;
      if (rec.ex.length < 4)
        rec.ex.push({
          words: words.map((x) => hx(x & 0xffff)),
          D: D.map(hx),
          A: A.map(hx),
          ccrIn: hx(ccr),
          bad,
        });
      failsByOp.set(op, rec);
    }
  }

  oracle.kill();
  console.log(
    `\nMusashi difftest (reg-only): ${pass} pass, ${fail} fail, ${skip} skipped, of ${TRIALS}`,
  );
  if (failsByOp.size) {
    const sorted = [...failsByOp.entries()].sort((a, b) => b[1].n - a[1].n);
    console.log(`\nFAILING OPS (by count):`);
    for (const [op, rec] of sorted) console.log(`  ${op.padEnd(12)} ${rec.n}`);
    console.log(`\nEXAMPLES:`);
    for (const [op, rec] of sorted.slice(0, 8)) {
      console.log(`\n### ${op}`);
      for (const ex of rec.ex) console.log("  " + JSON.stringify(ex));
    }
    process.exit(1);
  }
  console.log("✅ our codegen matches Musashi on all reg-only cases.");
}
main().catch((e) => (console.error(e), process.exit(1)));
