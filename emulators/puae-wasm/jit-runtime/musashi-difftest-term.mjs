// Stage 3: TERMINATOR difftest vs Musashi. Blocks end in Bcc/DBcc/BRA; the
// terminator computes the block's next PC from the flags. A wrong condition test
// or target = wrong next PC → execution derails → black. Untested until now.
// Pure (no memory): compare final PC + D regs + CCR. PC=0 both sides (direct cmp).
//   node musashi-difftest-term.mjs [trials]
import { spawn } from "node:child_process";
import { recompileCoreBlock } from "../jit/coreblock.mjs";
import { blockAt } from "../jit/decode.mjs";
import * as L from "../jit/layout.mjs";

const ORACLE = process.env.M68K_ORACLE || "./m68k-oracle";
const TRIALS = Number(process.argv[2] || 20000);
const RB = 1024,
  FB = 1024 + 64;
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = rng(0x7e210001);
const ri = (n) => Math.floor(rnd() * n);
const r32 = () => (rnd() * 4294967296) >>> 0;
const hx = (n) => (n >>> 0).toString(16);

// terminator generators (cc 2..15 for Bcc; DBcc uses cc 0..15). small signed disp.
function gen() {
  const disp8 = () => (ri(0x100) - 0x80) & 0xff || 0x10; // nonzero for Bcc.B
  const disp16 = () => ri(0x10000);
  switch (ri(6)) {
    case 0: {
      // Bcc.B (cc 2..15), BRA/BSR excluded from .B here to keep cc coverage
      const cc = 2 + ri(14);
      return [0x6000 | (cc << 8) | disp8()];
    }
    case 1: {
      // Bcc.W
      const cc = 2 + ri(14);
      return [0x6000 | (cc << 8), disp16()];
    }
    case 2: // BRA.B / .W
      return ri(2) ? [0x6000 | disp8()] : [0x6000, disp16()];
    case 3: {
      // DBcc Dn (cc 0..15)
      const cc = ri(16);
      return [0x50c8 | (cc << 8) | ri(8), disp16()];
    }
    case 4: {
      // Bcc.B again (more cc coverage)
      const cc = 2 + ri(14);
      return [0x6000 | (cc << 8) | disp8()];
    }
    default: {
      // a body op + Bcc terminator (real block shape)
      const cc = 2 + ri(14);
      return [0x7000 | (ri(8) << 9) | ri(256), 0x6000 | (cc << 8) | disp8()]; // MOVEQ ; Bcc.B
    }
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
function makeOracle() {
  const p = spawn(ORACLE, [], { stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const w = [];
  p.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const r = w.shift();
      if (r) r(l.trim());
    }
  });
  return {
    ask: (l) =>
      new Promise((res) => {
        w.push(res);
        p.stdin.write(l + "\n");
      }),
    kill: () => p.kill(),
  };
}

async function main() {
  const oracle = makeOracle();
  const failsByOp = new Map();
  let pass = 0,
    fail = 0,
    skip = 0;
  for (let t = 0; t < TRIALS; t++) {
    const words = gen();
    let block;
    try {
      block = blockAt(words, 0);
    } catch {
      skip++;
      continue;
    }
    const op = block.term
      ? block.term.op + (block.term.cc != null ? ":" + block.term.cc : "")
      : "(none)";
    const D = Array.from({ length: 8 }, () => (ri(4) ? r32() : ri(0x10000) & 0xffff)); // some small Dn for DBcc
    const A = Array.from({ length: 8 }, () => r32());
    const ccr = ri(32);
    // OUR
    const mem = new WebAssembly.Memory({ initial: 1 });
    const dv = new DataView(mem.buffer);
    for (let i = 0; i < 8; i++) {
      dv.setInt32(RB + i * 4, D[i], true);
      dv.setInt32(RB + 32 + i * 4, A[i], true);
    }
    const md = packedToMd(ccr);
    dv.setUint32(FB, md.cznv, true);
    dv.setUint32(FB + 4, md.x, true);
    const z = () => 0;
    const env = {
      memory: mem,
      get_byte: z,
      get_word: z,
      get_long: z,
      put_byte: z,
      put_word: z,
      put_long: z,
    };
    let gotPC = 0,
      cbErr = null;
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
      const r = failsByOp.get(op) || { n: 0, ex: [] };
      r.n++;
      if (r.ex.length < 3) r.ex.push({ words: words.map(hx), err: cbErr });
      failsByOp.set(op, r);
      fail++;
      continue;
    }
    const ourD = Array.from({ length: 8 }, (_, i) => dv.getInt32(RB + i * 4, true) >>> 0);
    const ourCcr = mdToPacked(dv.getUint32(FB, true) >>> 0, dv.getUint32(FB + 4, true) >>> 0);
    // MUSASHI (PC=0)
    const sr = 0x2000 | ccr;
    const line =
      [...D, ...A, sr, 0].map(hx).join(" ") +
      " " +
      hx(words.length) +
      " " +
      words.map((x) => hx(x & 0xffff)).join(" ") +
      " 0";
    const res = (await oracle.ask(line)).split(/\s+/).map((x) => parseInt(x, 16) >>> 0);
    const mD = res.slice(0, 8),
      mSr = res[16],
      mPC = res[17];
    const bad = [];
    if (gotPC >>> 0 !== mPC) bad.push(`PC:${hx(gotPC)}≠${hx(mPC)}`);
    for (let i = 0; i < 8; i++)
      if (ourD[i] !== mD[i]) bad.push(`D${i}:${hx(ourD[i])}≠${hx(mD[i])}`);
    if (ourCcr !== (mSr & 0x1f)) bad.push(`CCR:${hx(ourCcr)}≠${hx(mSr & 0x1f)}`);
    if (!bad.length) pass++;
    else {
      fail++;
      const r = failsByOp.get(op) || { n: 0, ex: [] };
      r.n++;
      if (r.ex.length < 5)
        r.ex.push({ words: words.map((x) => hx(x & 0xffff)), ccrIn: hx(ccr), bad });
      failsByOp.set(op, r);
    }
  }
  oracle.kill();
  console.log(
    `\nMusashi TERMINATOR difftest: ${pass} pass, ${fail} fail, ${skip} skipped, of ${TRIALS}`,
  );
  if (failsByOp.size) {
    const sorted = [...failsByOp.entries()].sort((a, b) => b[1].n - a[1].n);
    console.log(`\nFAILING TERMINATORS:`);
    for (const [op, r] of sorted) console.log(`  ${op.padEnd(12)} ${r.n}`);
    console.log(`\nEXAMPLES:`);
    for (const [op, r] of sorted.slice(0, 10)) {
      console.log(`\n### ${op}`);
      for (const ex of r.ex) console.log("  " + JSON.stringify(ex));
    }
    process.exit(1);
  }
  console.log("✅ our terminators match Musashi.");
}
main().catch((e) => (console.error(e), process.exit(1)));
