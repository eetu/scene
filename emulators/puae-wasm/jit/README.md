# jit — 68k → WASM recompiler

The recompiler itself: decode 68k → generate a WASM `block()` that runs on the
core's shared linear memory. Built on the substrate proven in `../spike` +
`../phase1-abi` (runtime module, imported memory, growable table, fn-pointer
dispatch), using `../spike/emit.mjs` as the codegen backend.

Developed and validated **in isolation** (pure Node) against a reference
interpreter — no core rebuild needed until integration.

```sh
node difftest.mjs            # straight-line: recompiled block vs interpreter
node cftest.mjs              # control flow: multi-block program vs interpreter
```

## Pieces

- `layout.mjs` — shared memory map (D0..D7, A0..A7, CCR, PC, guest RAM) used by
  both the interpreter and the recompiler so they can't drift.
- `decode.mjs` — cursor-based 68k decoder (+ extension words) and `blockAt`, which
  splits a program into basic blocks (terminating at a branch).
- `interp.mjs` — reference interpreter (the oracle): `execOne`, `evalCond`,
  `interpBlock`, `runProgram`.
- `recompile.mjs` — block → WASM `block()`; `recompileBlock` also emits the
  terminator's PC update (branch-target select from CCR).
- `run.mjs` — WASM block-runner: recompile-on-miss, cache by PC, follow PC.
- `difftest.mjs` / `cftest.mjs` — differential tests vs the interpreter.

## Status ✅

- **ALU (.L):** ADD/SUB/AND/OR/CMP **`<ea>,Dn`** (source is any EA — Dn, (An),
  (An)+, -(An), (d16,An), abs.L, #imm; An too for add/sub/cmp), plus MOVEQ,
  ADDQ.L, EOR Dx,Dy, NOT/NEG Dn — full **CCR flags (X N Z V C)** in generated WASM
  (carry/borrow via `i32.lt_u`, signed overflow via the xor-and-sign trick; X:=C
  for add/sub/neg, X preserved for logic/moveq, CMP leaves X untouched).
- **Shifts (.L, immediate count 1..8):** ASL/ASR/LSL/LSR — C = last bit out, X:=C,
  N/Z from result, and ASL's V (set when the sign bit changes) via the
  `sar(val,31-n) ∉ {0,-1}` test.
- **Data movement + memory:** MOVE.L / MOVEA.L with **EA modes** Dn, An, (An),
  (An)+, -(An), (d16,An), abs.L, #imm — guest-RAM load/store inlined as
  `(GUEST_BASE + (addr & RAM_MASK))`, with (An)+/-(An) register side effects and
  MOVE's NZ/VC flags (MOVEA sets none).
- `difftest` compares **D0..D7, A0..A7, CCR, and the whole RAM region** →
  **40000/40000**. Codegen for results, flags, addressing, and memory is proven.

- **Control flow:** BRA, Bcc (all 16 condition codes evaluated from CCR via
  `select`), DBcc/DBRA (word-counter decrement + branch); blocks end at a branch
  and write PC; `run.mjs` follows PC and **caches blocks by PC** (a hot loop
  recompiles once). `cftest` runs generated programs with forward branches +
  bounded DBRA loops through both the interpreter and the WASM runner →
  **15000/15000** (final D/A regs, CCR, PC match).

RAM is modelled as little-endian i32 cells here (both sides agree, so codegen is
validated); real big-endian byte-addressed 68k memory is handled at integration
via UAE's memory helpers — see `layout.mjs`.

## Next

- **Wider opcode coverage** (ADD/SUB/AND/OR/CMP with memory EA, shifts, byte/word
  sizes) + interpreter fallback for the long tail.
- **Integration** — hook `libretro-uae`'s `newcpu` dispatch to try a JIT block
  then fall back; rebuild via `../core` CI with `-sALLOW_TABLE_GROWTH`.
