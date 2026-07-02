# Phase-0 integration spike

The go/no-go for the whole JIT: can we compile a WASM module **at runtime**, wire
it into a running "core" module, and call it — sharing linear memory — the way a
68k→WASM recompiler would? This is v86's pattern in miniature.

```sh
node spike.mjs
```

## What it proves ✅

`spike.mjs` builds two modules with the hand-rolled encoder in `emit.mjs`:

- **host** — owns a `memory` + a **growable `funcref` table** and a `dispatch(idx,
  arg)` that `call_indirect`s `table[idx](arg)`. Stands in for the PUAE core.
- **block** — emitted **at runtime**, imports the host `memory`, reads guest RAM,
  computes, writes back, returns. Stands in for a recompiled 68k basic block.

The run then, at runtime: emits block bytes → `WebAssembly.compile/instantiate`
(sharing the host memory) → `table.grow(1)` → `table.set(idx, block)` →
`dispatch(idx, arg)` → verifies both the return value and that the block's writes
are visible in the host's shared memory. Passes for two independent blocks (table
grows twice):

```
PASS  slot 1: dispatch(5) → 40  (want 40);  shared mem[21] = 40
PASS  slot 2: dispatch(9) → 499 (want 499); shared mem[25] = 499
✅ GO
```

So the substrate is sound: **runtime codegen, dynamic instantiation, table
growth, indirect dispatch, and shared-memory coherency all work on V8** (same
engine as the browser; Node 26 here).

`emit.mjs` is deliberately the seed of the real codegen backend — the recompiler
will emit 68k blocks as WASM the same way, just with more opcodes.

## What it does NOT yet prove (Phase-1 validation, needs emcc)

The residual risk isn't the engine — it's whether the **Emscripten PUAE build**
exposes the same hooks:

1. The core's `__indirect_function_table` is reachable and **growable**
   (`-sALLOW_TABLE_GROWTH`), and a runtime module can import/extend it.
2. A runtime block can import the core's `memory` (so it reads the real emulated
   chip/fast RAM), and the **function-pointer == table-index** ABI holds so UAE's
   C dispatch can jump to a JIT block.
3. Placing a block: Emscripten's `addFunction` / dynamic-linking (side-module)
   path, and reconciling **async** `instantiate` with the **synchronous**
   emulation loop (compile-on-miss → interpret this pass → JIT next pass, or a
   worker).

These are documented-to-work in Emscripten (`ALLOW_TABLE_GROWTH`, `addFunction`,
`MAIN_MODULE`/side modules) but must be confirmed against the actual core build.
That's the first task once the toolchain (`emcc`) is in — see the top-level
`../README.md` Phase-1.
