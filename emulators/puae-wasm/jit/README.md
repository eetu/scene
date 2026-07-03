# jit — 68k → WASM recompiler

The recompiler itself: decode 68k → generate a WASM `block()` that runs on the
core's shared linear memory. Built on the substrate proven in `../spike` +
`../phase1-abi` (runtime module, imported memory, growable table, fn-pointer
dispatch), using `../spike/emit.mjs` as the codegen backend.

Developed and validated **in isolation** (pure Node) against a reference
interpreter — no core rebuild needed until integration.

```sh
node difftest.mjs            # 2000 random programs, recompiled vs interpreter
node difftest.mjs 20000 20   # more trials / longer blocks
```

## Pieces

- `decode.mjs` — 68k opcode decoder (returns null for unhandled → interp fallback).
- `interp.mjs` — reference interpreter (the oracle).
- `recompile.mjs` — block → WASM `block()`; Dn lives at byte offset `n*4` in the
  shared memory, read/written with i32.load/store.
- `difftest.mjs` — differential test: random programs on random register state,
  recompiled WASM vs interpreter, assert identical D0..D7.

## Status (MVP) ✅

Straight-line data-register longword ops: **MOVEQ, ADDQ.L, ADD.L Dy,Dx,
SUB.L Dy,Dx**. `difftest` passes 2000/2000. This proves the codegen pipeline is
correct; it's the skeleton the rest hangs off.

## Next

- **Flags (CCR N/Z/V/C)** — needed for conditionals; each op computes them.
- **Effective-address modes** — immediate/absolute/indirect/(An)+/-(An)/disp, so
  ops touch guest RAM, not just registers. Plain chip/fast RAM inlines as
  load/store; custom-chip/IO regions call a UAE bank helper (import).
- **Control flow** — Bcc/DBcc/JMP: end blocks at branches, chain blocks.
- **Wider opcode coverage** + interpreter fallback for the long tail.
- **Integration** — hook `libretro-uae`'s `newcpu` dispatch to try a JIT block
  then fall back; rebuild via `../core` CI with `-sALLOW_TABLE_GROWTH`.
