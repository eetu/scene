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

- `layout.mjs` — shared memory map (D0..D7, A0..A7, CCR, guest RAM) used by both
  the interpreter and the recompiler so they can't drift.
- `decode.mjs` — cursor-based 68k decoder (consumes extension words; returns null
  for unhandled → interp fallback).
- `interp.mjs` — reference interpreter (the oracle).
- `recompile.mjs` — block → WASM `block()` over the shared layout.
- `difftest.mjs` — differential test: random programs on random state, recompiled
  WASM vs interpreter, assert identical D/A regs, CCR, and guest RAM.

## Status ✅

- **ALU (register .L):** MOVEQ, ADDQ.L, ADD/SUB Dy,Dx, AND/OR Dy,Dx, EOR Dx,Dy,
  CMP Dy,Dx (flags only), NOT/NEG Dn — full **CCR flags (X N Z V C)** in generated
  WASM (carry/borrow via `i32.lt_u`, signed overflow via the xor-and-sign trick;
  X:=C for add/sub/neg, X preserved for logic/moveq, CMP leaves X untouched).
- **Data movement + memory:** MOVE.L / MOVEA.L with **EA modes** Dn, An, (An),
  (An)+, -(An), (d16,An), abs.L, #imm — guest-RAM load/store inlined as
  `(GUEST_BASE + (addr & RAM_MASK))`, with (An)+/-(An) register side effects and
  MOVE's NZ/VC flags (MOVEA sets none).
- `difftest` compares **D0..D7, A0..A7, CCR, and the whole RAM region** →
  **40000/40000**. Codegen for results, flags, addressing, and memory is proven.

RAM is modelled as little-endian i32 cells here (both sides agree, so codegen is
validated); real big-endian byte-addressed 68k memory is handled at integration
via UAE's memory helpers — see `layout.mjs`.

## Next

- **Control flow** — Bcc/DBcc/JMP: end blocks at branches, chain blocks.
- **Wider opcode coverage** + interpreter fallback for the long tail.
- **Integration** — hook `libretro-uae`'s `newcpu` dispatch to try a JIT block
  then fall back; rebuild via `../core` CI with `-sALLOW_TABLE_GROWTH`.
