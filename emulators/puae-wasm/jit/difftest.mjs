// Differential test: for many random programs + random register states, run the
// recompiled WASM block and the reference interpreter and assert identical
// D0..D7 AND CCR (index 16). This is how we know the recompiler's codegen —
// results and condition-code flags — is correct without a running core.
//
//   node difftest.mjs [trials] [maxlen]
import { recompile } from "./recompile.mjs";
import { runInterp, CCR } from "./interp.mjs";
import { decodeBlock } from "./decode.mjs";

// seeded PRNG (mulberry32) — reproducible runs
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TRIALS = Number(process.argv[2] || 2000);
const MAXLEN = Number(process.argv[3] || 12);
const rnd = rng(0x5ce7e); // fixed seed
const ri = (n) => Math.floor(rnd() * n);

// emit a random supported opcode word
function randWord() {
  const x = ri(8),
    y = ri(8);
  switch (ri(4)) {
    case 0:
      return 0x7000 | (x << 9) | ri(256); // MOVEQ #imm8,Dx
    case 1:
      return 0x5080 | (ri(8) << 9) | x; // ADDQ.L #d,Dx
    case 2:
      return 0xd080 | (x << 9) | y; // ADD.L Dy,Dx
    default:
      return 0x9080 | (x << 9) | y; // SUB.L Dy,Dx
  }
}

let pass = 0;
let fail = 0;
const failures = [];

for (let t = 0; t < TRIALS; t++) {
  const words = Array.from({ length: 1 + ri(MAXLEN) }, randWord);
  // register file: D0..D7 + CCR at index 16 (seed CCR too, to test X preservation)
  const init = new Int32Array(17);
  for (let i = 0; i < 8; i++) init[i] = (rnd() * 4294967296) | 0;
  init[CCR] = ri(32); // X N Z V C

  // oracle
  const expect = Int32Array.from(init);
  runInterp(words, expect);

  // recompiled block on shared memory
  const mem = new WebAssembly.Memory({ initial: 1 });
  const inst = await WebAssembly.instantiate(
    await WebAssembly.compile(recompile(decodeBlock(words))),
    { env: { memory: mem } },
  );
  const view = new Int32Array(mem.buffer);
  for (let i = 0; i < 8; i++) view[i] = init[i];
  view[CCR] = init[CCR];
  inst.exports.block();

  let ok = view[CCR] === expect[CCR];
  for (let i = 0; i < 8; i++) if (view[i] !== expect[i]) ok = false;
  if (ok) pass++;
  else {
    fail++;
    if (failures.length < 3)
      failures.push({
        words: words.map((w) => "0x" + w.toString(16)),
        expectRegs: [...expect.subarray(0, 8)],
        gotRegs: [...view.subarray(0, 8)],
        expectCCR: expect[CCR],
        gotCCR: view[CCR],
      });
  }
}

console.log(`68k→WASM recompiler difftest: ${pass}/${TRIALS} passed, ${fail} failed`);
if (fail) {
  console.log(JSON.stringify(failures, null, 2));
  process.exit(1);
}
console.log("✅ recompiled blocks match the reference interpreter on random programs.");
