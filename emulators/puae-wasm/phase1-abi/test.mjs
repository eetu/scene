// Phase-1 ABI validation driver. Confirms, against a REAL emcc-compiled core
// (core.mjs), the three hooks the spike could only assume:
//   1. the core's __indirect_function_table is reachable + growable,
//   2. a runtime-emitted block can import the core's linear memory (guest RAM),
//   3. a C function pointer == table index, so core_call(idx) jumps to the block.
//
//   bash build.sh && node test.mjs
import createCore from "./core.mjs";
import * as w from "../spike/emit.mjs";

// A runtime "block": result = mem[ptr]*mul + add; mem[ptr+64] = result; return.
// Imports the core's memory so it reads/writes the SAME guest RAM.
function buildBlock({ mul, add }) {
  const types = w.section(w.S.TYPE, w.vec([w.funcType([w.I32], [w.I32])]));
  const imports = w.section(
    w.S.IMPORT,
    w.vec([w.concat(w.str("env"), w.str("memory"), [0x02], w.memType({ min: 1 }))]),
  );
  const funcs = w.section(w.S.FUNC, w.vec([w.uleb(0)]));
  const exports = w.section(w.S.EXPORT, w.vec([w.concat(w.str("block"), [0x00], w.uleb(0))]));
  const code = w.section(
    w.S.CODE,
    w.vec([
      w.body(
        [{ count: 1, type: w.I32 }], // local 1 = result (local 0 = ptr param)
        [
          w.op.localGet(0),
          w.op.i32Load(0), // v = mem[ptr]
          w.op.i32Const(mul),
          w.op.i32Mul(),
          w.op.i32Const(add),
          w.op.i32Add(),
          w.op.localSet(1),
          w.op.localGet(0),
          w.op.localGet(1),
          w.op.i32Store(64), // mem[ptr+64] = result
          w.op.localGet(1),
        ],
      ),
    ]),
  );
  return w.module([types, imports, funcs, exports, code]);
}

const Module = await createCore();

const table = Module.wasmTable; // __indirect_function_table
const mem = Module.wasmMemory;
if (!table || !table.grow)
  throw new Error("core has no growable wasmTable (need -sALLOW_TABLE_GROWTH + export)");
if (!mem || !mem.buffer) throw new Error("core has no importable wasmMemory");

const bufAddr = Module.ccall("core_bufaddr", "number", [], []);
const coreCall = Module.cwrap("core_call", "number", ["number", "number"]);
const heap = () => new Int32Array(mem.buffer);

const cases = [
  { mul: 3, add: 7, in: 11 },
  { mul: 5, add: -1, in: 100 },
];

let ok = true;
for (const c of cases) {
  heap()[bufAddr >> 2] = c.in; // write guest RAM from JS

  const block = await WebAssembly.instantiate(await WebAssembly.compile(buildBlock(c)), {
    env: { memory: mem }, // block shares the CORE's memory
  });
  const idx = table.grow(1); // grow the core's table; idx = new slot
  table.set(idx, block.exports.block); // install the runtime block (native fn, no JS wrapper)

  const ret = coreCall(idx, bufAddr); // C casts idx→fn pointer and calls it
  const expect = c.in * c.mul + c.add;
  const wrote = heap()[(bufAddr + 64) >> 2]; // block's write, seen in shared RAM

  const pass = ret === expect && wrote === expect;
  ok = ok && pass;
  console.log(
    `${pass ? "PASS" : "FAIL"}  slot ${idx}: core_call(idx,buf) → ${ret} (want ${expect}); ` +
      `guest RAM[+64] = ${wrote}`,
  );
}

console.log(
  ok
    ? "\n✅ Emscripten ABI confirmed: growable table + memory import + fn-pointer==index + shared RAM."
    : "\n❌ ABI mismatch — inspect core build flags.",
);
process.exit(ok ? 0 : 1);
