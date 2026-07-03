// JIT-vs-interpreter throughput benchmark — the payoff gate.
//
// Runs the SAME 8-instruction 68k hot loop (ALU + shift + memory, all computing
// CCR) two ways, both as V8-compiled WASM:
//   • JIT  — our real recompiler output, inlined into a counted WASM loop
//            (recompileLoop): zero per-iteration dispatch (an ideal chained JIT).
//   • INTERP — a C switch interpreter (interp.c) compiled by emcc -O3: the exact
//            analog of PUAE (C 68k interpreter → WASM), fetch/decode/dispatch
//            per instruction.
// The ratio ≈ the structural speedup a full JIT would give by eliminating
// dispatch. It's the honest answer to "is this effort paying off?".
//
//   bash build.sh && node bench.mjs [iters]
import { recompileLoop, ITERS_OFF } from "../jit/recompile.mjs";
import * as L from "../jit/layout.mjs";
import createInterp from "./interp.mjs";

const ITERS = Number(process.argv[2] || 20_000_000);
const OPS_PER_ITER = 8;

// The JIT body — identical semantics to interp.c's `prog`.
const body = [
  { op: "add", dn: 0, src: { ea: "d", n: 1 } }, // D0 += D1
  { op: "sub", dn: 3, src: { ea: "d", n: 2 } }, // D3 -= D2
  { op: "and", dn: 5, src: { ea: "d", n: 4 } }, // D5 &= D4
  { op: "eor", dx: 6, dy: 7 }, // D7 ^= D6
  { op: "lsl", cnt: 3, dn: 2 }, // D2 <<= 3
  { op: "move", dst: { ea: "ind", n: 0 }, src: { ea: "d", n: 0 } }, // ram[A0] = D0
  { op: "move", dst: { ea: "d", n: 6 }, src: { ea: "ind", n: 0 } }, // D6 = ram[A0]
  { op: "addq", imm: 1, dn: 1 }, // D1 += 1
];

function seed(view) {
  for (let i = 0; i < 8; i++) view[L.iD(i)] = (i * 2654435761) | 0; // D0..D7
  view[L.iA(0)] = 12345; // A0
  view[L.iCCR] = 0;
}

async function buildJit() {
  const mem = new WebAssembly.Memory({ initial: 1 });
  const inst = await WebAssembly.instantiate(await WebAssembly.compile(recompileLoop(body)), {
    env: { memory: mem },
  });
  const view = new Int32Array(mem.buffer);
  return {
    run(iters) {
      seed(view);
      view[ITERS_OFF / 4] = iters; // loop counter cell
      return inst.exports.run();
    },
  };
}

function timeit(fn, iters) {
  const t0 = performance.now();
  const r = fn(iters);
  const ms = performance.now() - t0;
  return { ms, r };
}

async function main() {
  const jit = await buildJit();
  const Module = await createInterp();
  // Load the SAME body into the interpreter at runtime (op,a,b triples). Ops:
  // ADD=0 SUB=1 AND=2 EOR=3 LSL=4 STORE=5 LOAD=6 ADDI=7.
  // prettier-ignore
  const prog = [
    0, 0, 1,  // D0 += D1
    1, 3, 2,  // D3 -= D2
    2, 5, 4,  // D5 &= D4
    3, 7, 6,  // D7 ^= D6
    4, 2, 3,  // D2 <<= 3
    5, 0, 0,  // ram[A0] = D0
    6, 6, 0,  // D6 = ram[A0]
    7, 1, 1,  // D1 += 1
  ];
  prog.forEach((v, i) => Module._setprog(i, v));
  Module._setn(prog.length);
  const interp = (iters) => Module._run(iters);

  // warm up V8 tiers
  jit.run(200_000);
  interp(200_000);

  // best-of-3
  const best = (fn) => {
    let b = Infinity;
    let r;
    for (let i = 0; i < 3; i++) {
      const t = timeit(fn, ITERS);
      if (t.ms < b) b = t.ms;
      r = t.r;
    }
    return { ms: b, r };
  };

  const j = best(jit.run);
  const it = best(interp);
  const totalOps = ITERS * OPS_PER_ITER;
  const jns = (j.ms * 1e6) / totalOps;
  const ins = (it.ms * 1e6) / totalOps;

  console.log(`hot loop: ${OPS_PER_ITER} 68k instrs/iter × ${ITERS.toLocaleString()} iters`);
  console.log("");
  console.log(
    `  JIT     ${j.ms.toFixed(1).padStart(8)} ms   ${jns.toFixed(2)} ns/instr   (checksum ${j.r | 0})`,
  );
  console.log(
    `  INTERP  ${it.ms.toFixed(1).padStart(8)} ms   ${ins.toFixed(2)} ns/instr   (checksum ${it.r | 0})`,
  );
  console.log("");
  console.log(`  speedup: ${(it.ms / j.ms).toFixed(2)}×  (JIT vs emcc -O3 C interpreter)`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
