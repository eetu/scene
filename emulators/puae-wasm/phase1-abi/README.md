# Phase-1 ABI validation

Confirms — against a **real emcc-compiled core** (not just V8 in the abstract) —
the three Emscripten hooks a runtime 68k→WASM JIT depends on. This retires the
only residual risk the Phase-0 spike left open.

```sh
bash build.sh && node test.mjs
```

`core.c` is a stand-in for the Emscripten PUAE core: it exposes a shared buffer
(guest RAM) and `core_call(idx, ptr)`, which casts an integer to a function
pointer and calls it — exactly how UAE's `newcpu` dispatch will jump into a
recompiled block. `test.mjs` emits a block at runtime (via the Phase-0
`emit.mjs`), imports the core's memory, installs it in the core's table, and has
C call it.

## Result ✅

```
PASS  slot 1: core_call(idx,buf) → 40  (want 40);  guest RAM[+64] = 40
PASS  slot 2: core_call(idx,buf) → 499 (want 499); guest RAM[+64] = 499
✅ Emscripten ABI confirmed: growable table + memory import + fn-pointer==index + shared RAM.
```

Confirmed:

1. **Growable table** — built with `-sALLOW_TABLE_GROWTH`; `Module.wasmTable.grow(1)`
   returns a fresh slot and `table.set(idx, block)` installs a runtime WASM
   function (a native funcref — **no JS wrapper**, so no per-call overhead).
2. **Memory import** — the block imports `env.memory = Module.wasmMemory`, so it
   reads/writes the core's real linear memory (the emulated chip/fast RAM).
3. **fn-pointer == table-index** — `core_call` casts the JS-chosen `idx` to
   `int(*)(int)` and the `call_indirect` lands in our block, types matching.

## Build flags that matter (carry into the fork)

```
-sALLOW_TABLE_GROWTH
-sEXPORTED_RUNTIME_METHODS=...,wasmTable,wasmMemory   # reach the table + memory from JS
```

`core.mjs` / `core.wasm` are build artifacts (gitignored) — regenerate with
`build.sh`.

## What's left in Phase 1

The mechanism is proven; the remaining work is plumbing it into the actual core:
fork `libretro-uae` + the EmulatorJS core-build, rebuild `puae-wasm.data` with
these flags, boot our demos unchanged, then start the recompiler (Phase 2) using
`emit.mjs` as the codegen seed.
