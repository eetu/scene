// Reproduce the in-core parity gate with SOURCE modules + a fake Module, logging
// the first mismatch — to tell whether the ~1/3 bundle gateFail is a codegen bug,
// a gate-logic bug, or a fake-Module bug (moveq fails too, so it's not codegen).
import { blockAt } from "../../jit/decode.mjs";
import { interpBlock } from "../../jit/interp.mjs";
import { recompileCoreBlock } from "../../jit/coreblock.mjs";
import * as L from "../../jit/layout.mjs";

const mem = new WebAssembly.Memory({ initial: 4 });
const dvm = new DataView(mem.buffer);
const REGS = 4096,
  FLAGS = REGS + 64;
const GSIZE = 1 << 18,
  GMASK = GSIZE - 1;
const g = new Uint8Array(GSIZE);
const gget = (a, sz) => {
  let v = 0;
  for (let i = 0; i < sz; i++) v = ((v << 8) | g[(a + i) & GMASK]) >>> 0;
  return v >>> 0;
};
const gput = (a, sz, val) => {
  for (let i = 0; i < sz; i++) g[(a + sz - 1 - i) & GMASK] = (val >>> (8 * i)) & 0xff;
};
const abi = { regsBase: REGS, regflagsBase: FLAGS };
const packedFromMd = (cznv, x) =>
  ((cznv >>> 15) & 1 ? L.N : 0) |
  ((cznv >>> 14) & 1 ? L.Z : 0) |
  ((cznv >>> 8) & 1 ? L.C : 0) |
  (cznv & 1 ? L.V : 0) |
  ((x >>> 8) & 1 ? L.X : 0);
const words = new Proxy(
  {},
  { get: (_, p) => (p === "length" ? 0x40000000 : gget(Number(p) * 2, 2) & 0xffff) },
);
const env = {
  memory: mem,
  get_byte: (a) => gget(a, 1),
  get_word: (a) => gget(a, 2),
  get_long: (a) => gget(a, 4),
  put_byte: (a, v) => gput(a, 1, v),
  put_word: (a, v) => gput(a, 2, v),
  put_long: (a, v) => gput(a, 4, v),
};

function rng(s) {
  let a = s >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = rng(0xc0ffee);
const ri = (n) => Math.floor(rnd() * n);
const r32 = () => (rnd() * 4294967296) | 0;

let fail = 0;
for (let t = 0; t < 3000 && fail < 3; t++) {
  const PC = 0x2000 + t * 64;
  const prog = [0x7000 | (ri(8) << 9) | ri(256)]; // MOVEQ
  prog.push(...[[0x6000 | (ri(0x80) + 1)], [0x6700, ri(0x10000)], [0x4e75]][ri(3)]);
  for (let i = 0; i < prog.length; i++) gput(PC + i * 2, 2, prog[i] & 0xffff);
  for (let i = 0; i < 16; i++) dvm.setInt32(REGS + i * 4, r32(), true);
  dvm.setUint32(FLAGS, ri(0x10000), true);
  dvm.setUint32(FLAGS + 4, ri(0x200), true);

  const blk = blockAt(words, PC, 64);
  // snapshot
  const D0 = [],
    A0 = [];
  for (let i = 0; i < 8; i++) D0.push(dvm.getInt32(REGS + i * 4, true));
  for (let i = 0; i < 8; i++) A0.push(dvm.getInt32(REGS + 32 + i * 4, true));
  const cz0 = dvm.getUint32(FLAGS, true) >>> 0,
    x0 = dvm.getUint32(FLAGS + 4, true) >>> 0;
  // interp
  const s = new Int32Array(18);
  for (let i = 0; i < 8; i++) {
    s[L.iD(i)] = D0[i];
    s[L.iA(i)] = A0[i];
  }
  s[L.iCCR] = packedFromMd(cz0, x0);
  s[L.iPC] = blk.startPC;
  interpBlock(blk, s);
  // jit
  const inst = new WebAssembly.Instance(new WebAssembly.Module(recompileCoreBlock(blk, abi)), {
    env,
  });
  const jitPC = inst.exports.block() | 0;
  const gc = packedFromMd(dvm.getUint32(FLAGS, true) >>> 0, dvm.getUint32(FLAGS + 4, true) >>> 0);
  let ok = jitPC === (s[L.iPC] | 0) && gc === (s[L.iCCR] & 0x1f);
  for (let i = 0; i < 8; i++) if (dvm.getInt32(REGS + i * 4, true) !== s[L.iD(i)]) ok = false;
  // restore
  for (let i = 0; i < 8; i++) dvm.setInt32(REGS + i * 4, D0[i], true);
  for (let i = 0; i < 8; i++) dvm.setInt32(REGS + 32 + i * 4, A0[i], true);
  dvm.setUint32(FLAGS, cz0, true);
  dvm.setUint32(FLAGS + 4, x0, true);
  if (!ok) {
    fail++;
    console.log(
      "FAIL",
      prog.map((w) => "0x" + (w & 0xffff).toString(16)),
      {
        jitPC,
        wantPC: s[L.iPC],
        gc,
        wantCcr: s[L.iCCR] & 0x1f,
        term: blk.term && blk.term.op,
        startPC: blk.startPC,
        instrs: blk.instrs.map((i) => i.op + "@" + i.pc),
      },
    );
  }
}
console.log(fail ? `${fail} moveq failures` : "✅ moveq gate clean");
