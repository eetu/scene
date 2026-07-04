// Micro-benchmark for coreblock codegen quality (no core rebuild): wrap a
// representative block body in an in-wasm loop that runs it N times, instantiate,
// and time it — measuring pure recompiled-code speed (no per-call JS overhead,
// like the in-core chain). Compare against interp.mjs on the same block. Used to
// quantify codegen optimisations (e.g. dead-flag elimination).
//
//   node bench.mjs [iters]
import * as w from "../spike/emit.mjs";
import { makeCodegen } from "./coreblock.mjs";
import { execOne } from "./interp.mjs";
import * as L from "./layout.mjs";

const ITERS = Number(process.argv[2] || 20_000_000);
const RB = 1024,
  FB = 1024 + 64;
const abi = { regsBase: RB, regflagsBase: FB };

// A representative reg-only hot loop body: 4 flag-setting .L ALU ops. Only the
// LAST cznv (and the last X) is ever read (by nothing here / the block end), so
// dead-flag elimination should drop most of the flag computation.
const BODY = [
  { op: "add", dn: 0, src: { ea: "d", n: 1 }, sz: 4 },
  { op: "sub", dn: 2, src: { ea: "d", n: 3 }, sz: 4 },
  { op: "eor", dn: 4, dy: 5, sz: 4 }, // eor uses dn (Dx) + dst
  { op: "add", dn: 6, src: { ea: "d", n: 7 }, sz: 4 },
];
// eor in the new IR is {op:"eor", dn:Dx, dst:{ea:d,n:Dy}} — fix shape:
BODY[2] = { op: "eor", dn: 5, dst: { ea: "d", n: 4 }, sz: 4 };

// Build a module: run the body ITERS times in a wasm loop; block():i32 returns 0.
function loopModule(instrs) {
  const cg = makeCodegen(abi);
  const body = instrs.flatMap((it) => cg.emitInstr(it));
  const LCOUNT = 7; // extra local beyond coreblock's 0..6 scratch
  const NLOCALS = 8;
  const code = [
    w.op.i32Const(ITERS),
    w.op.localSet(LCOUNT),
    ...w.op.loop(),
    ...body,
    w.op.localGet(LCOUNT),
    w.op.i32Const(1),
    w.op.i32Sub(),
    w.op.localTee(LCOUNT),
    ...w.op.brIf(0),
    ...w.op.end(),
    w.op.i32Const(0),
  ];
  const types = w.section(
    w.S.TYPE,
    w.vec([w.funcType([w.I32], [w.I32]), w.funcType([w.I32, w.I32], []), w.funcType([], [w.I32])]),
  );
  const imp = (n, t) => w.concat(w.str("env"), w.str(n), [0x00], w.uleb(t));
  const imports = w.section(
    w.S.IMPORT,
    w.vec([
      w.concat(w.str("env"), w.str("memory"), [0x02], w.memType({ min: 1 })),
      imp("get_byte", 0),
      imp("get_word", 0),
      imp("get_long", 0),
      imp("put_byte", 1),
      imp("put_word", 1),
      imp("put_long", 1),
    ]),
  );
  const funcs = w.section(w.S.FUNC, w.vec([w.uleb(2)]));
  const exports = w.section(w.S.EXPORT, w.vec([w.concat(w.str("block"), [0x00], w.uleb(6))]));
  const codeS = w.section(w.S.CODE, w.vec([w.body([{ count: NLOCALS, type: w.I32 }], code)]));
  return { bytes: w.module([types, imports, funcs, exports, codeS]), bodyLen: body.length };
}

const stub = () => 0;
const env = {
  get_byte: stub,
  get_word: stub,
  get_long: stub,
  put_byte: stub,
  put_word: stub,
  put_long: stub,
};

function benchJit() {
  const { bytes, bodyLen } = loopModule(BODY);
  const mem = new WebAssembly.Memory({ initial: 1 });
  const dv = new DataView(mem.buffer);
  for (let i = 0; i < 8; i++) dv.setInt32(RB + i * 4, (i * 2654435761) | 0, true);
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
    env: { memory: mem, ...env },
  });
  const t0 = process.hrtime.bigint();
  inst.exports.block();
  const t1 = process.hrtime.bigint();
  const secs = Number(t1 - t0) / 1e9;
  return {
    secs,
    minsnPerSec: (ITERS * BODY.length) / secs / 1e6,
    bodyBytes: bytes.length,
    bodyLen,
  };
}

function benchInterp() {
  const s = new Int32Array(L.RAM_CELL0 + 8);
  for (let i = 0; i < 8; i++) s[L.iD(i)] = (i * 2654435761) | 0;
  const N = Math.min(ITERS, 3_000_000); // interp is slower; scale down then normalise
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < N; k++) for (const d of BODY) execOne(d, s);
  const t1 = process.hrtime.bigint();
  const secs = Number(t1 - t0) / 1e9;
  return { minsnPerSec: (N * BODY.length) / secs / 1e6, s0: s[0] };
}

// memory-heavy body: load, alu, store — exercises the imported get/put_long path
const MEMBODY = [
  { op: "move", dst: { ea: "d", n: 0 }, src: { ea: "ind", n: 0 }, sz: 4 }, // move.l (a0),d0
  { op: "add", dn: 1, src: { ea: "d", n: 0 }, sz: 4 },
  { op: "move", dst: { ea: "ind", n: 1 }, src: { ea: "d", n: 1 }, sz: 4 }, // move.l d1,(a1)
];
function benchMem() {
  const cg = makeCodegen(abi);
  const body = MEMBODY.flatMap((it) => cg.emitInstr(it));
  const NLOCALS = 8,
    LCOUNT = 7;
  const N = 8_000_000;
  const code = [
    w.op.i32Const(N),
    w.op.localSet(LCOUNT),
    ...w.op.loop(),
    ...body,
    w.op.localGet(LCOUNT),
    w.op.i32Const(1),
    w.op.i32Sub(),
    w.op.localTee(LCOUNT),
    ...w.op.brIf(0),
    ...w.op.end(),
    w.op.i32Const(0),
  ];
  const types = w.section(
    w.S.TYPE,
    w.vec([w.funcType([w.I32], [w.I32]), w.funcType([w.I32, w.I32], []), w.funcType([], [w.I32])]),
  );
  const imp = (n, t) => w.concat(w.str("env"), w.str(n), [0x00], w.uleb(t));
  const imports = w.section(
    w.S.IMPORT,
    w.vec([
      w.concat(w.str("env"), w.str("memory"), [0x02], w.memType({ min: 1 })),
      imp("get_byte", 0),
      imp("get_word", 0),
      imp("get_long", 0),
      imp("put_byte", 1),
      imp("put_word", 1),
      imp("put_long", 1),
    ]),
  );
  const funcs = w.section(w.S.FUNC, w.vec([w.uleb(2)]));
  const exports = w.section(w.S.EXPORT, w.vec([w.concat(w.str("block"), [0x00], w.uleb(6))]));
  const codeS = w.section(w.S.CODE, w.vec([w.body([{ count: NLOCALS, type: w.I32 }], code)]));
  const bytes = w.module([types, imports, funcs, exports, codeS]);
  const mem = new WebAssembly.Memory({ initial: 1 });
  const dv = new DataView(mem.buffer);
  dv.setInt32(RB + 32, 8000, true); // A0
  dv.setInt32(RB + 36, 9000, true); // A1
  const ram = new Int32Array(1 << 16); // JS-backed guest RAM (like the core's wrapper cost)
  const g4 = (a) => ram[(a >>> 2) & 0xffff];
  const p4 = (a, v) => (ram[(a >>> 2) & 0xffff] = v | 0);
  const menv = {
    memory: mem,
    get_byte: g4,
    get_word: g4,
    get_long: g4,
    put_byte: p4,
    put_word: p4,
    put_long: p4,
  };
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: menv });
  const t0 = process.hrtime.bigint();
  inst.exports.block();
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  return { minsnPerSec: (N * MEMBODY.length) / secs / 1e6 };
}

const jit = benchJit();
const mem = benchMem();
const interp = benchInterp();
console.log(
  `body: ${BODY.length} instrs → ${jit.bodyBytes} wasm bytes, ${jit.bodyLen} body opcodes`,
);
console.log(
  `JIT:    ${jit.minsnPerSec.toFixed(1)} Minsn/s  (${jit.secs.toFixed(2)}s for ${ITERS}×${BODY.length})`,
);
console.log(
  `JIT (mem load/alu/store, imported get/put_long): ${mem.minsnPerSec.toFixed(1)} Minsn/s`,
);
console.log(`interp: ${interp.minsnPerSec.toFixed(1)} Minsn/s`);
console.log(
  `JIT vs interp (isolated, no dispatch): ${(jit.minsnPerSec / interp.minsnPerSec).toFixed(2)}×`,
);
