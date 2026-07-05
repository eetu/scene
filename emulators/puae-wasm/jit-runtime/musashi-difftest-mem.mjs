// Stage 2: memory-access difftest vs Musashi. Registers + address computation
// already match (stage 1); this exercises actual loads/stores/RMW/MOVEM. All EAs
// are constrained to a small seeded window [BASE,BASE+WSIZE) so both sides share
// identical memory; we compare final window bytes + regs + PC-delta.
//   node musashi-difftest-mem.mjs [trials]
import { spawn } from "node:child_process";
import { recompileCoreBlock } from "../jit/coreblock.mjs";
import { blockAt } from "../jit/decode.mjs";
import * as L from "../jit/layout.mjs";

const ORACLE = process.env.M68K_ORACLE || "./m68k-oracle";
const TRIALS = Number(process.argv[2] || 20000);
const PC = 0x1000; // Musashi code addr (outside the data window)
const RB = 1024,
  FB = 1024 + 64;
const BASE = 0x3000,
  WSIZE = 96; // data window (Musashi presets)
const MEMSZ = 0x4000;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = rng(0xbead1122);
const ri = (n) => Math.floor(rnd() * n);
const r32 = () => (rnd() * 4294967296) >>> 0;
const pick = (a) => a[ri(a.length)];
const bits = (mode, reg) => (mode << 3) | reg;
const hx = (n) => (n >>> 0).toString(16);

// window-safe memory EA + which An it uses; returns {ea, an} (an = base reg 0..7 or null)
function memEA() {
  const an = ri(8);
  switch (ri(5)) {
    case 0:
      return { ea: { mode: 2, reg: an, ext: [] }, an, anVal: BASE + 8 + ri(48) }; // (An)
    case 1:
      return { ea: { mode: 3, reg: an, ext: [] }, an, anVal: BASE + ri(48) }; // (An)+
    case 2:
      return { ea: { mode: 4, reg: an, ext: [] }, an, anVal: BASE + 16 + ri(48) }; // -(An)
    case 3: {
      const d = ri(33) - 16;
      return { ea: { mode: 5, reg: an, ext: [d & 0xffff] }, an, anVal: BASE + 32 };
    } // (d16,An)
    default:
      return { ea: { mode: 7, reg: 0, ext: [(BASE + ri(48)) & 0xffff] }, an: null }; // abs.W
  }
}
const dEA = () => ({ ea: { mode: 0, reg: ri(8), ext: [] }, an: null });
const imm = (sz) => ({
  ea:
    sz === 4
      ? { mode: 7, reg: 4, ext: [ri(0x10000), ri(0x10000)] }
      : { mode: 7, reg: 4, ext: [ri(0x10000)] },
  an: null,
});

// generate a memory-touching instruction; returns { words, overrides:[[reg,val]] }
function gen() {
  const ov = [];
  const useMem = () => {
    const m = memEA();
    if (m.an != null) ov.push([8 + m.an, m.anVal]);
    return m;
  };
  switch (ri(12)) {
    case 0:
    case 1:
    case 2: {
      // MOVE.B/W/L  <mem>->Dn / Dn-><mem> / <mem>-><mem>
      const sf = pick([1, 3, 2]);
      const dir = ri(3);
      const src = dir === 1 ? dEA() : useMem();
      const dst = dir === 0 ? dEA() : useMem();
      if (dst.ea.mode === 0)
        return {
          words: [
            (sf << 12) | (dst.ea.reg << 9) | (0 << 6) | bits(src.ea.mode, src.ea.reg),
            ...src.ea.ext,
          ],
          ov,
        };
      return {
        words: [
          (sf << 12) | (dst.ea.reg << 9) | (dst.ea.mode << 6) | bits(src.ea.mode, src.ea.reg),
          ...src.ea.ext,
          ...dst.ea.ext,
        ],
        ov,
      };
    }
    case 3:
    case 4: {
      // ADD/SUB/CMP/AND/OR <mem>,Dn
      const base = pick([0xd000, 0x9000, 0xb000, 0xc000, 0x8000]);
      const opm = ri(3);
      const m = useMem();
      return {
        words: [base | (ri(8) << 9) | (opm << 6) | bits(m.ea.mode, m.ea.reg), ...m.ea.ext],
        ov,
      };
    }
    case 5: {
      // ADD/SUB/AND/OR Dn,<mem>
      const base = pick([0xd000, 0x9000, 0xc000, 0x8000]);
      const opm = pick([4, 5, 6]);
      const m = useMem();
      return {
        words: [base | (ri(8) << 9) | (opm << 6) | bits(m.ea.mode, m.ea.reg), ...m.ea.ext],
        ov,
      };
    }
    case 6: {
      // immediate ALU to <mem>
      const of = pick([0, 1, 2, 3, 5, 6]);
      const size = ri(3);
      const sz = [1, 2, 4][size];
      const m = useMem();
      const iw = sz === 4 ? [ri(0x10000), ri(0x10000)] : [ri(0x10000)];
      return {
        words: [(of << 9) | (size << 6) | bits(m.ea.mode, m.ea.reg), ...iw, ...m.ea.ext],
        ov,
      };
    }
    case 7: {
      // CLR/NEG/NOT/TST/NEGX <mem>
      const opw = pick([0x4200, 0x4400, 0x4600, 0x4a00, 0x4000]);
      const size = ri(3);
      const m = useMem();
      return { words: [opw | (size << 6) | bits(m.ea.mode, m.ea.reg), ...m.ea.ext], ov };
    }
    case 8: {
      // static bit op on <mem> (byte)
      const tt = ri(4);
      const m = useMem();
      return { words: [0x0800 | (tt << 6) | bits(m.ea.mode, m.ea.reg), ri(8), ...m.ea.ext], ov };
    }
    case 9: {
      // dynamic bit op on <mem> (byte)
      const tt = ri(4);
      const m = useMem();
      return {
        words: [0x0100 | (ri(8) << 9) | (tt << 6) | bits(m.ea.mode, m.ea.reg), ...m.ea.ext],
        ov,
      };
    }
    case 10:
    case 11: {
      // MOVEM <list>,<mem> / <mem>,<list>  (reg <-> memory)
      const toMem = ri(2) === 0;
      const long = ri(2) === 1;
      const base = (toMem ? 0x4880 : 0x4c80) | (long ? 0x40 : 0);
      // use (An) / (An)+ / -(An) with a base low in the window so the whole list fits
      const an = ri(8);
      const mode = toMem ? pick([2, 4]) : pick([2, 3]);
      const anVal = mode === 4 ? BASE + WSIZE - 8 : BASE + 4;
      ov.push([8 + an, anVal]);
      const mask = ri(0x10000) & 0x0f0f; // few regs so it fits the window
      return { words: [base | bits(mode, an), mask, ...(mode === 5 ? [ri(0x10000)] : [])], ov };
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
  const waiters = [];
  p.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const wr = waiters.shift();
      if (wr) wr(line.trim());
    }
  });
  return {
    ask: (l) =>
      new Promise((res) => {
        waiters.push(res);
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
    const { words, ov } = gen();
    let block;
    try {
      block = blockAt(words, 0);
    } catch {
      skip++;
      continue;
    }
    if (!block.instrs.length) {
      skip++;
      continue;
    }
    const op = block.instrs[0].op + "." + (block.instrs[0].sz || 4);

    // registers: window bases from overrides, rest random
    const D = Array.from({ length: 8 }, () => r32());
    const A = Array.from({ length: 8 }, () => r32());
    for (const [reg, val] of ov) {
      if (reg < 8) D[reg] = val >>> 0;
      else A[reg - 8] = val >>> 0;
    }
    const ccr = ri(32);
    // seed the data window identically
    const win = Array.from({ length: WSIZE }, () => ri(256));

    // OUR codegen — env over a big-endian buffer
    const membuf = new Uint8Array(MEMSZ);
    for (let i = 0; i < WSIZE; i++) membuf[BASE + i] = win[i];
    const getB = (a, sz) => {
      let v = 0;
      for (let i = 0; i < sz; i++) v = ((v << 8) | membuf[(a + i) & (MEMSZ - 1)]) >>> 0;
      return v >>> 0;
    };
    const putB = (a, sz, val) => {
      for (let i = 0; i < sz; i++)
        membuf[(a + sz - 1 - i) & (MEMSZ - 1)] = (val >>> (8 * i)) & 0xff;
    };
    const mem = new WebAssembly.Memory({ initial: 1 });
    const dv = new DataView(mem.buffer);
    for (let i = 0; i < 8; i++) {
      dv.setInt32(RB + i * 4, D[i], true);
      dv.setInt32(RB + 32 + i * 4, A[i], true);
    }
    const md = packedToMd(ccr);
    dv.setUint32(FB, md.cznv, true);
    dv.setUint32(FB + 4, md.x, true);
    const env = {
      memory: mem,
      get_byte: (a) => getB(a >>> 0, 1),
      get_word: (a) => getB(a >>> 0, 2),
      get_long: (a) => getB(a >>> 0, 4),
      put_byte: (a, v) => putB(a >>> 0, 1, v >>> 0),
      put_word: (a, v) => putB(a >>> 0, 2, v >>> 0),
      put_long: (a, v) => putB(a >>> 0, 4, v >>> 0),
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
    const ourWin = Array.from({ length: WSIZE }, (_, i) => membuf[BASE + i]);

    // MUSASHI: presets = the window; code at PC
    const sr = 0x2000 | ccr;
    const presets = [];
    for (let i = 0; i < WSIZE; i++) presets.push(BASE + i, win[i]);
    const line =
      [...D, ...A, sr, PC].map(hx).join(" ") +
      " " +
      hx(words.length) +
      " " +
      words.map((x) => hx(x & 0xffff)).join(" ") +
      " " +
      hx(WSIZE) +
      " " +
      presets.map(hx).join(" ");
    const res = (await oracle.ask(line)).split(/\s+/).map((x) => parseInt(x, 16) >>> 0);
    const mD = res.slice(0, 8),
      mA = res.slice(8, 16),
      mSr = res[16],
      mPC = res[17];
    const nw = res[18];
    // apply Musashi writes to a copy of the window
    const mWin = win.slice();
    for (let k = 0, o = 19; k < nw; k++) {
      const wa = res[o++],
        ws = res[o++],
        wv = res[o++];
      for (let b = 0; b < ws; b++) {
        const addr = wa + b;
        if (addr >= BASE && addr < BASE + WSIZE)
          mWin[addr - BASE] = (wv >>> (8 * (ws - 1 - b))) & 0xff;
      }
    }

    const bad = [];
    for (let i = 0; i < 8; i++)
      if (ourD[i] !== mD[i]) bad.push(`D${i}:${hx(ourD[i])}≠${hx(mD[i])}`);
    for (let i = 0; i < 8; i++)
      if (ourA[i] !== mA[i]) bad.push(`A${i}:${hx(ourA[i])}≠${hx(mA[i])}`);
    if (ourCcr !== (mSr & 0x1f)) bad.push(`CCR:${hx(ourCcr)}≠${hx(mSr & 0x1f)}`);
    if (gotPC >>> 0 !== (mPC - PC) >>> 0) bad.push(`PCΔ:${hx(gotPC)}≠${hx((mPC - PC) >>> 0)}`);
    for (let i = 0; i < WSIZE; i++)
      if (ourWin[i] !== mWin[i]) {
        bad.push(`mem+${i}:${hx(ourWin[i])}≠${hx(mWin[i])}`);
        break;
      }

    if (bad.length === 0) pass++;
    else {
      fail++;
      const rec = failsByOp.get(op) || { n: 0, ex: [] };
      rec.n++;
      if (rec.ex.length < 4) rec.ex.push({ words: words.map((x) => hx(x & 0xffff)), bad });
      failsByOp.set(op, rec);
    }
  }
  oracle.kill();
  console.log(`\nMusashi MEM difftest: ${pass} pass, ${fail} fail, ${skip} skipped, of ${TRIALS}`);
  if (failsByOp.size) {
    const sorted = [...failsByOp.entries()].sort((a, b) => b[1].n - a[1].n);
    console.log(`\nFAILING OPS:`);
    for (const [op, r] of sorted) console.log(`  ${op.padEnd(12)} ${r.n}`);
    console.log(`\nEXAMPLES:`);
    for (const [op, r] of sorted.slice(0, 8)) {
      console.log(`\n### ${op}`);
      for (const ex of r.ex) console.log("  " + JSON.stringify(ex));
    }
    process.exit(1);
  }
  console.log("✅ our codegen matches Musashi on all memory cases.");
}
main().catch((e) => (console.error(e), process.exit(1)));
