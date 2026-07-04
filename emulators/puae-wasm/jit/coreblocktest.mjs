// Differential test for the real-ABI sized codegen (coreblock.mjs) vs the
// reference interpreter (interp.mjs). Random body op (any size/EA) + terminator,
// random state + guest RAM; run both; compare D/A regs, flags (md-generic↔packed),
// guest RAM, and next PC. Guest RAM is a byte-addressable big-endian buffer with
// masked addressing (any address wraps in-bounds), used identically by both sides
// — this validates the codegen (address + value + flags), not the memory system.
//
//   node coreblocktest.mjs [trials] [maxlen]
import { recompileCoreBlock } from "./coreblock.mjs";
import { interpBlock } from "./interp.mjs";
import { blockAt } from "./decode.mjs";
import * as L from "./layout.mjs";

const RB = 1024,
  FB = 1024 + 64;
const BUFBITS = 16,
  BUFSIZE = 1 << BUFBITS,
  BUFMASK = BUFSIZE - 1;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const TRIALS = Number(process.argv[2] || 30000);
const MAXLEN = Number(process.argv[3] || 6);
const rnd = rng(0x5eed1234);
const ri = (n) => Math.floor(rnd() * n);
const r32 = () => (rnd() * 4294967296) | 0;
const pick = (a) => a[ri(a.length)];

// byte-addressable big-endian guest RAM, masked addressing
function mkMem(seed) {
  const buf = Uint8Array.from(seed);
  const get = (a, sz) => {
    let v = 0;
    for (let i = 0; i < sz; i++) v = ((v << 8) | buf[(a + i) & BUFMASK]) >>> 0;
    return v >>> 0;
  };
  const put = (a, sz, val) => {
    for (let i = 0; i < sz; i++) buf[(a + sz - 1 - i) & BUFMASK] = (val >>> (8 * i)) & 0xff;
  };
  return { buf, get, put };
}

// ---- instruction word generators ----
const bits = (mode, reg) => (mode << 3) | reg;
const memEA = () => {
  switch (ri(6)) {
    case 0:
      return { mode: 2, reg: ri(8), ext: [] };
    case 1:
      return { mode: 3, reg: ri(8), ext: [] };
    case 2:
      return { mode: 4, reg: ri(8), ext: [] };
    case 3:
      return { mode: 5, reg: ri(8), ext: [ri(0x10000)] };
    case 4: {
      const a = r32() >>> 0;
      return { mode: 7, reg: 1, ext: [(a >>> 16) & 0xffff, a & 0xffff] };
    }
    default: {
      const a = ri(0x8000);
      return { mode: 7, reg: 0, ext: [a] };
    } // abs.W (positive)
  }
};
const dEA = () => ({ mode: 0, reg: ri(8), ext: [] });
const aEA = () => ({ mode: 1, reg: ri(8), ext: [] });
const immEA = (sz) => {
  if (sz === 1) return { mode: 7, reg: 4, ext: [ri(0x10000)] };
  if (sz === 2) return { mode: 7, reg: 4, ext: [ri(0x10000)] };
  const v = r32();
  return { mode: 7, reg: 4, ext: [(v >>> 16) & 0xffff, v & 0xffff] };
};
const dataSrc = (sz) => pick([memEA, dEA, () => immEA(sz)])();
const anySrc = (sz) => pick([memEA, dEA, aEA, () => immEA(sz)])();
const dataAlt = () => pick([memEA, dEA])(); // data-alterable dst
const word = (op, ea, extra = []) => [op | bits(ea.mode, ea.reg), ...ea.ext, ...extra];

function randBody() {
  const g = ri(24);
  switch (g) {
    case 0:
      return [0x7000 | (ri(8) << 9) | ri(256)]; // MOVEQ
    case 1: {
      // MOVE.B/W/L
      const sf = pick([1, 3, 2]);
      const sz = sf === 1 ? 1 : sf === 3 ? 2 : 4;
      const src = sz === 1 ? pick([memEA, dEA, () => immEA(1)])() : anySrc(sz);
      const dst = dataAlt();
      return [
        (sf << 12) | (dst.reg << 9) | (dst.mode << 6) | bits(src.mode, src.reg),
        ...src.ext,
        ...dst.ext,
      ];
    }
    case 2: {
      // MOVEA.W/L
      const sf = pick([3, 2]);
      const sz = sf === 3 ? 2 : 4;
      const src = anySrc(sz);
      return [(sf << 12) | (ri(8) << 9) | (1 << 6) | bits(src.mode, src.reg), ...src.ext];
    }
    case 3:
    case 4:
    case 5: {
      // ADD/SUB/CMP <ea>,Dn (An src ok for W/L)
      const base = pick([0xd000, 0x9000, 0xb000]);
      const opm = ri(3);
      const sz = [1, 2, 4][opm];
      const src = sz === 1 ? dataSrc(1) : anySrc(sz);
      return [base | (ri(8) << 9) | (opm << 6) | bits(src.mode, src.reg), ...src.ext];
    }
    case 6:
    case 7: {
      // AND/OR <ea>,Dn (no An)
      const base = pick([0xc000, 0x8000]);
      const opm = ri(3);
      const sz = [1, 2, 4][opm];
      const src = dataSrc(sz);
      return [base | (ri(8) << 9) | (opm << 6) | bits(src.mode, src.reg), ...src.ext];
    }
    case 8: {
      // ADD/SUB/AND/OR Dn,<ea>  (memory dst)
      const base = pick([0xd000, 0x9000, 0xc000, 0x8000]);
      const opm = pick([4, 5, 6]);
      const sz = [1, 2, 4][opm - 4];
      const dst = memEA();
      return [base | (ri(8) << 9) | (opm << 6) | bits(dst.mode, dst.reg), ...dst.ext];
    }
    case 9: {
      // immediate ALU
      const map = [
        [0, "or"],
        [1, "and"],
        [2, "sub"],
        [3, "add"],
        [5, "eor"],
        [6, "cmp"],
      ];
      const [of] = pick(map);
      const size = ri(3);
      const sz = [1, 2, 4][size];
      const dst = dataAlt();
      const imm = sz === 4 ? [(r32() >>> 16) & 0xffff, r32() & 0xffff] : [ri(0x10000)];
      return [(of << 9) | (size << 6) | bits(dst.mode, dst.reg), ...imm, ...dst.ext];
    }
    case 10: {
      // ADDQ/SUBQ
      const size = ri(3);
      const dst = pick([memEA, dEA, aEA])();
      if (dst.mode === 1 && size === 0) return randBody(); // ADDQ.B to An invalid
      return [
        0x5000 | (ri(8) << 9) | (ri(2) << 8) | (size << 6) | bits(dst.mode, dst.reg),
        ...dst.ext,
      ];
    }
    case 11: {
      // TST
      const size = ri(3);
      const s = dataSrc([1, 2, 4][size]);
      return [0x4a00 | (size << 6) | bits(s.mode, s.reg), ...s.ext];
    }
    case 12: {
      const size = ri(3);
      const d = dataAlt();
      return [0x4200 | (size << 6) | bits(d.mode, d.reg), ...d.ext];
    } // CLR
    case 13: {
      const size = ri(3);
      const d = dataAlt();
      return [0x4400 | (size << 6) | bits(d.mode, d.reg), ...d.ext];
    } // NEG
    case 14: {
      const size = ri(3);
      const d = dataAlt();
      return [0x4600 | (size << 6) | bits(d.mode, d.reg), ...d.ext];
    } // NOT
    case 15: {
      const opm = pick([3, 7]);
      const sz = opm === 3 ? 2 : 4;
      const s = anySrc(sz);
      return [
        pick([0xd0c0, 0x90c0, 0xb0c0]) | (ri(8) << 9) | ((opm & 4) << 6) | bits(s.mode, s.reg),
        ...s.ext,
      ];
    } // ADDA/SUBA/CMPA
    case 16: {
      const opm = pick([4, 5, 6]);
      const d = dataAlt();
      return [0xb000 | (ri(8) << 9) | (opm << 6) | bits(d.mode, d.reg), ...d.ext];
    } // EOR Dn,<ea>
    case 17: {
      const size = ri(3);
      const d = dataAlt();
      const imm = [ri(0x10000)];
      return [
        0x0a00 | (size << 6) | bits(d.mode, d.reg),
        ...(size === 2 ? [(r32() >>> 16) & 0xffff, r32() & 0xffff] : imm),
        ...d.ext,
      ];
    } // EORI
    case 18:
      return [0x4880 | ((ri(2) ? 1 : 0) << 6) | ri(8)]; // EXT.W/.L
    case 19:
      return [0x4840 | ri(8)]; // SWAP
    case 20: {
      const s = pick([
        () => ({ mode: 2, reg: ri(8), ext: [] }),
        () => ({ mode: 5, reg: ri(8), ext: [ri(0x10000)] }),
      ])();
      return [0x41c0 | (ri(8) << 9) | bits(s.mode, s.reg), ...s.ext];
    } // LEA
    case 21: {
      const size = ri(3);
      const type = ri(2);
      const left = ri(2);
      const cnt = ri(8);
      return [0xe000 | (cnt << 9) | (left << 8) | (size << 6) | (type << 3) | ri(8)];
    } // shift imm
    case 22: {
      const d = dataAlt();
      return [0x50c0 | (pick([2, 3, 6, 7, 12, 13]) << 8) | bits(d.mode, d.reg), ...d.ext];
    } // Scc
    default:
      return [0x4e71]; // NOP
  }
}
function randTerm() {
  switch (ri(6)) {
    case 0:
      return [0x6000 | (ri(0x80) + 1)];
    case 1:
      return [0x6000 | (2 << 8) | (ri(0x80) + 1)];
    case 2:
      return [0x6700, ri(0x10000)];
    case 3:
      return [0x50c8 | (ri(16) << 8) | ri(8), ri(0x10000)];
    case 4:
      return [0x4e75]; // RTS
    default: {
      const a = r32();
      return [0x4ef9, (a >>> 16) & 0xffff, a & 0xffff];
    } // JMP abs.L
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

let pass = 0,
  fail = 0;
const failures = [];

for (let t = 0; t < TRIALS; t++) {
  const body = [];
  const n = 1 + ri(MAXLEN);
  for (let k = 0; k < n; k++) {
    try {
      body.push(...randBody());
    } catch {
      /* skip */
    }
  }
  const words = [...body, ...randTerm()];
  let block;
  try {
    block = blockAt(words, 0);
  } catch {
    continue;
  }
  if (!block.instrs.length) continue;

  const D = Array.from({ length: 8 }, () => r32());
  const A = Array.from({ length: 8 }, () => r32());
  const ccr = ri(32);
  const seed = Array.from({ length: BUFSIZE }, () => ri(256));

  // reference
  const s = new Int32Array(18);
  for (let i = 0; i < 8; i++) {
    s[L.iD(i)] = D[i];
    s[L.iA(i)] = A[i];
  }
  s[L.iCCR] = ccr;
  const im = mkMem(seed);
  s.__mem = im;
  let interpErr = null;
  try {
    interpBlock(block, s);
  } catch (e) {
    interpErr = String(e);
  }

  // coreblock
  const mem = new WebAssembly.Memory({ initial: 1 });
  const dv = new DataView(mem.buffer);
  for (let i = 0; i < 8; i++) {
    dv.setInt32(RB + i * 4, D[i], true);
    dv.setInt32(RB + 32 + i * 4, A[i], true);
  }
  const md = packedToMd(ccr);
  dv.setUint32(FB, md.cznv, true);
  dv.setUint32(FB + 4, md.x, true);
  const cm = mkMem(seed);
  const env = {
    memory: mem,
    get_byte: (a) => cm.get(a >>> 0, 1),
    get_word: (a) => cm.get(a >>> 0, 2),
    get_long: (a) => cm.get(a >>> 0, 4),
    put_byte: (a, v) => cm.put(a >>> 0, 1, v >>> 0),
    put_word: (a, v) => cm.put(a >>> 0, 2, v >>> 0),
    put_long: (a, v) => cm.put(a >>> 0, 4, v >>> 0),
  };
  let cbErr = null,
    gotPC = 0;
  try {
    const inst = await WebAssembly.instantiate(
      await WebAssembly.compile(recompileCoreBlock(block, { regsBase: RB, regflagsBase: FB })),
      { env },
    );
    gotPC = inst.exports.block() | 0;
  } catch (e) {
    cbErr = String(e);
  }

  // if coreblock can't emit an op (movem/reg-shift), it throws → that's a
  // deliberate fallback, not a failure; skip those trials.
  if (cbErr && /unhandled|unsupported/.test(cbErr)) continue;

  let ok = !interpErr && !cbErr && gotPC === (s[L.iPC] | 0);
  const bad = [];
  if (interpErr) bad.push("interpErr:" + interpErr);
  if (cbErr) bad.push("cbErr:" + cbErr);
  if (ok) {
    for (let i = 0; i < 8; i++)
      if (dv.getInt32(RB + i * 4, true) !== s[L.iD(i)]) ((ok = false), bad.push(`D${i}`));
    for (let i = 0; i < 8; i++)
      if (dv.getInt32(RB + 32 + i * 4, true) !== s[L.iA(i)]) ((ok = false), bad.push(`A${i}`));
    const gc = mdToPacked(dv.getUint32(FB, true) >>> 0, dv.getUint32(FB + 4, true) >>> 0);
    if (gc !== (s[L.iCCR] & 0x1f))
      ((ok = false), bad.push(`ccr got ${gc} want ${s[L.iCCR] & 0x1f}`));
    for (let i = 0; i < BUFSIZE; i++)
      if (im.buf[i] !== cm.buf[i]) {
        ok = false;
        bad.push(`mem@${i}`);
        break;
      }
  }
  if (gotPC !== (s[L.iPC] | 0)) bad.push(`pc ${gotPC >>> 0} want ${s[L.iPC] >>> 0}`);

  if (ok) pass++;
  else {
    fail++;
    if (failures.length < 5)
      failures.push({
        words: words.map((x) => "0x" + (x & 0xffff).toString(16)),
        ops: block.instrs.map((i) => `${i.op}.${i.sz || 4}`),
        bad,
      });
  }
}

console.log(`coreblock sized difftest vs interp: ${pass}/${pass + fail} passed, ${fail} failed`);
if (fail) {
  console.log(JSON.stringify(failures, null, 2));
  process.exit(1);
}
console.log(
  "✅ sized real-ABI blocks match the reference interpreter (regs, flags, RAM, next PC).",
);
