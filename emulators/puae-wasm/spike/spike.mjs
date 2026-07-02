// Phase-0 integration spike — the make-or-break for the whole JIT.
//
// Proves, on the same V8 engine the browser runs, the substrate a runtime
// 68k→WASM recompiler needs:
//   1. emit a WASM module at RUNTIME (bytes → WebAssembly.instantiate),
//   2. have it share the HOST core's linear memory (guest RAM must be coherent),
//   3. install its exported function into the host's GROWABLE function table,
//   4. call it from the host via CALL_INDIRECT (a function-pointer dispatch),
//   5. get the right result AND see its writes in shared memory.
//
// The "host" here stands in for the PUAE core; the "block" for a recompiled 68k
// basic block. If this works (it does), the pattern is sound; the remaining
// unknown is whether the *Emscripten* PUAE build exposes the table/memory the
// same way — that needs emcc and is the Phase-1 validation (see spike README).
import * as w from "./emit.mjs";

const TYPE_DISPATCH = 0; // (idx:i32, arg:i32) -> i32
const TYPE_BLOCK = 1; // (arg:i32) -> i32

// ── HOST module: owns memory + a growable funcref table, and a dispatch()
//    that call_indirects table[idx](arg). Stands in for the emulator core. ──
function buildHost() {
  const types = w.section(
    w.S.TYPE,
    w.vec([w.funcType([w.I32, w.I32], [w.I32]), w.funcType([w.I32], [w.I32])]),
  );
  const funcs = w.section(w.S.FUNC, w.vec([w.uleb(TYPE_DISPATCH)]));
  const table = w.section(w.S.TABLE, w.vec([w.tableType({ min: 1 })])); // no max ⇒ growable
  const mem = w.section(w.S.MEM, w.vec([w.memType({ min: 1 })]));
  const exports = w.section(
    w.S.EXPORT,
    w.vec([
      w.concat(w.str("memory"), [0x02], w.uleb(0)),
      w.concat(w.str("table"), [0x01], w.uleb(0)),
      w.concat(w.str("dispatch"), [0x00], w.uleb(0)),
    ]),
  );
  // dispatch(idx,arg){ return table[idx](arg); }
  const code = w.section(
    w.S.CODE,
    w.vec([
      w.body(
        [],
        [
          w.op.localGet(1), // arg
          w.op.localGet(0), // idx (call_indirect takes the table index last)
          w.op.callIndirect(TYPE_BLOCK, 0),
        ],
      ),
    ]),
  );
  return w.module([types, funcs, table, mem, exports, code]);
}

// ── BLOCK module: emitted at RUNTIME. Imports the host memory, reads guest RAM,
//    computes, writes back, returns — the shape of a recompiled 68k block. ──
function buildBlock({ mul, add }) {
  const types = w.section(w.S.TYPE, w.vec([w.funcType([w.I32], [w.I32])]));
  const imports = w.section(
    w.S.IMPORT,
    w.vec([w.concat(w.str("env"), w.str("memory"), [0x02], w.memType({ min: 1 }))]),
  );
  const funcs = w.section(w.S.FUNC, w.vec([w.uleb(0)]));
  const exports = w.section(w.S.EXPORT, w.vec([w.concat(w.str("block"), [0x00], w.uleb(0))]));
  // local 0 = arg (param); local 1 = result
  // result = mem[arg*4]*mul + add;  mem[arg*4 + 64] = result;  return result
  const code = w.section(
    w.S.CODE,
    w.vec([
      w.body(
        [{ count: 1, type: w.I32 }],
        [
          w.op.localGet(0),
          w.op.i32Const(4),
          w.op.i32Mul(), // addr = arg*4
          w.op.i32Load(0), // v = mem[addr]
          w.op.i32Const(mul),
          w.op.i32Mul(),
          w.op.i32Const(add),
          w.op.i32Add(), // v*mul+add
          w.op.localSet(1), // result = …
          w.op.localGet(0),
          w.op.i32Const(4),
          w.op.i32Mul(), // addr again
          w.op.localGet(1), // result
          w.op.i32Store(64), // mem[addr+64] = result
          w.op.localGet(1), // return result
        ],
      ),
    ]),
  );
  return w.module([types, imports, funcs, exports, code]);
}

async function main() {
  // instantiate(Module, imports) resolves to the Instance directly.
  const host = await WebAssembly.instantiate(await WebAssembly.compile(buildHost()), {});
  const mem = host.exports.memory;
  const table = host.exports.table;
  const dispatch = host.exports.dispatch;
  const view = new Int32Array(mem.buffer);

  const cases = [
    { arg: 5, in: 11, mul: 3, add: 7 },
    { arg: 9, in: 100, mul: 5, add: -1 }, // second runtime block → table grows again
  ];

  let ok = true;
  for (const c of cases) {
    view[c.arg] = c.in;
    // RUNTIME: emit + compile + instantiate a block sharing the host memory.
    const block = await WebAssembly.instantiate(await WebAssembly.compile(buildBlock(c)), {
      env: { memory: mem },
    });
    // Install into the host's growable table; grow() returns the new slot index.
    const idx = table.grow(1);
    table.set(idx, block.exports.block);

    const ret = dispatch(idx, c.arg); // host → call_indirect → runtime block
    const expect = c.in * c.mul + c.add;
    const wrote = view[c.arg + 16]; // addr+64 bytes = +16 i32 slots (shared memory)

    const pass = ret === expect && wrote === expect;
    ok = ok && pass;
    console.log(
      `${pass ? "PASS" : "FAIL"}  slot ${idx}: dispatch(${c.arg}) → ${ret} (want ${expect}); ` +
        `shared mem[${c.arg + 16}] = ${wrote}`,
    );
  }

  console.log(
    ok
      ? "\n✅ GO: runtime WASM emit → instantiate → table.grow → call_indirect → shared memory all work."
      : "\n❌ NO-GO: substrate broken.",
  );
  process.exit(ok ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
