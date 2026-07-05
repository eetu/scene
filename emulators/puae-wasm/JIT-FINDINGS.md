# Why the JIT renders AGA demos black (investigation, 2026-07)

**Status: JIT shelved.** The app ships the **stock non-JIT PUAE core** (renders
correctly at interpreter speed). This records what's wrong so a future attempt
doesn't restart from zero.

## Symptom

Every AGA demo renders **black** on the baked-JIT core: it hangs at boot while the
vblank counter keeps ticking (`vblank 60`), the runtime parity gate reports **0
failures**, and the CPU busy-loops. Every earlier signal said "working" because
none of them looked at pixels.

## The oracle that finally told the truth

[`jit-runtime/render-check.mjs`](jit-runtime/render-check.mjs) — boots a demo in
**real-GL headless Chrome-for-Testing** (not `chrome-headless-shell`, which is
GPU-less → swiftshader → every frame black) and reads the **actual canvas colour
histogram**. Verdict from distinct-colour count. On ZIF: stock core → **292**
colours (RENDERED); JIT core → **2** (BLACK). This is the test the project was
missing — `batch.mjs` only measured `vblankFps`, which ticks even on a black hang.

## What was ruled out (each via a CI rebuild + render-check, real-GL pixels)

| suspect | verdict | evidence |
| --- | --- | --- |
| Self-modifying code | ❌ | added code-write invalidation (`code0`/`ejs_smc_hits`) → still black, only 2–19 SMC hits |
| Cycle magnitude | ❌ (real, insufficient) | measured JIT charged **0.49×** the interpreter (we apply `adjust_cycles` on `4×CYCLE_UNIT`; the interpreter feeds `handler>>16 ≈ 8×CYCLE_UNIT`). Fixed to `8×CYCLE_UNIT` → ratio **0.99×**, **still black** |
| Cycle/interrupt batching (granularity) | ❌ | capped blocks to 1 instruction (per-instruction `do_cycles` + `do_specialties`) with correct cycles → **still black** |
| Dispatch scaffolding | ❌ | `ramMax=0` (scaffolding runs, **zero blocks compiled**) → **RENDERS** (295 colours). The `m68k_run_2_020` weaving is benign |
| **JIT block codegen** | ✅ **root cause** | blocks on → black; blocks off → renders. The compiled blocks corrupt at runtime |

## Root cause — block codegen diverges from the real 68020, and our tests can't see it

With every other factor eliminated (`ramMax=0` renders, blocks-on is black), the
**compiled blocks themselves are wrong at runtime** — yet difftests are 60000/60000
and the in-core gate reports `0` failures. The reason both are blind:

> **The difftests *and* the in-core parity gate (`install-src.js` `parityOk`) both
> compare the JIT codegen against our OWN JS reference interpreter (`interp.mjs`),
> not against the real UAE interpreter.** A *shared misunderstanding* — the same
> wrong 68020 semantics in both the codegen (`coreblock.mjs`) and the JS interp —
> passes every test but diverges from the real `cpufunctbl` handlers at runtime →
> corruption → black.

The arithmetic/flag codegen (N/Z/V/C/X, add/sub overflow, carry/borrow) was reviewed
and looks correct, so the culprit is a subtler or specific opcode/addressing-mode
case the self-referential tests don't exercise.

## What a real fix requires

An **independent 68020 oracle** to locate the diverging opcode — the current tests
can't, by construction. Options, cheapest first:
1. **Offline**: difftest the exact opcodes ZIF compiles against a real 68k reference
   (e.g. Musashi built to WASM/native, or captured golden traces). Finds the bug
   *if* it's also reproducible offline.
2. **Runtime gate vs the real interpreter**: run each block, then run the real
   `cpufunctbl` interpreter for the same instructions on shadow memory and compare;
   fall back + log on mismatch. Powerful (finds *and* fixes) but hard in C
   (side-effect isolation).
3. **Bisect opcode coverage** across CI builds (disable JIT for opcode classes until
   it renders) — many 16-min builds.

Weigh against payoff: **the JIT's speedup was never measured on a rendered demo**
(the old "~2.5×" was `vblankFps` on a black screen). The cycle magnitude fix
(`8×CYCLE_UNIT`) and SMC guard are genuine and kept, but the codegen bug blocks any
real measurement. Recommend building the oracle (option 1/2) only if the JIT is
worth reviving; otherwise the stock core ships and this stays shelved.

## Kept for a future attempt

- `render-check.mjs` — the pixel-truth oracle (use it as the gate; never trust
  vblank again).
- SMC invalidation in `m3-jit-scaffold.py` (`code0` + `ejs_smc_hits`) — correct and
  worth keeping even though it wasn't the bug.
- This document + the `puae-jit-investigation` branch history (the diagnostic builds:
  cycle magnitude, SMC guard, 1-instr blocks, `ramMax=0`, and the interp-vs-JIT cycle
  instrumentation).
