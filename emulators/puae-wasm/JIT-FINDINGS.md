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
| JIT block codegen | ❌ **PROVEN CORRECT** | difftested vs a real 68020 (Musashi), 40000+ cases, 0 real failures |
| **JIT↔interpreter integration/handoff** | ✅ **remaining suspect** | codegen + ABI + memory routing all match, yet blocks-on is black → a real-core-only handoff bug |

## The Musashi oracle result — the codegen is NOT the bug

The self-referential difftests (codegen vs our own `interp.mjs`) couldn't rule out a
*shared misunderstanding*, so we built an independent oracle: the **Musashi** m68k
core (see [`musashi-oracle.md`](musashi-oracle.md)). Difftesting our codegen against
it:

| class | cases | result |
| --- | --- | --- |
| registers (MOVEQ/ALU/shift/MUL/EXT/SWAP/Scc/bit) | 7071 | 0 fail |
| addressing (LEA: index mode, abs.W sign-ext, disp) | 10919 | 0 fail |
| memory (loads/stores/RMW/MOVEM/imm-ALU) | 19657 | 0 fail |
| terminators (Bcc/DBcc/BRA, all conditions) | — | 0 real fail |

**The recompiler is sound.** This overturns the earlier "codegen diverges"
hypothesis. Also verified statically: the ABI the JIT assumes matches the real core
— `regs[16]` (D0-7,A0-7), `flag_struct{cznv,x}`, and md-generic little-endian CCR
packing (`N15 Z14 C8 V0`, X@bit8 of x; WASM → not `__x86_64__` → `md-generic`) — and
the JIT's `get_word`/`put_word` are the *same* accessors the mode-0 interpreter
handlers (`cpuemu_0.c`) use.

## Remaining suspect — the JIT→interpreter handoff (real-core only)

Codegen ✅, ABI ✅, memory routing ✅ — yet `ramMax=0` (no blocks) renders and
blocks-on is black. So the corruption is a side effect of the *block execution path*
in the running core, not the instruction semantics: some CPU-loop state the block
path doesn't reproduce that the next interpreted instruction (or the chipset) needs
— e.g. prefetch/`pc_p` vs `pc` consistency after `m68k_setpc`, `ipl`/interrupt
latch state, or a chip-side effect of the fetch the block skips. **This is invisible
offline** (Musashi runs instructions in isolation); it needs real-core runtime
debugging.

## What a real fix requires now

Real-core runtime bisection (each is a ~16-min CI build):
1. **Runtime gate vs the real interpreter** — run a block, then run the real
   `cpufunctbl` handlers for the same instructions and compare regs/mem; fall back +
   log on mismatch. Finds *and* fixes, but hard in C (side-effect isolation).
2. **`ramMax` address bisection** — narrow which code region's blocks break it, then
   read that code.
3. **Handoff instrumentation** — after each block, log pc/pc_p/prefetch/spcflags and
   compare to the interpreter's expectations.

Weigh against payoff: **the JIT's speedup was never measured on a rendered demo**
(the old "~2.5×" was `vblankFps` on a black screen). Kept as genuine improvements:
the `8×CYCLE_UNIT` charge, the SMC guard, and — most valuably — the **Musashi
difftest oracle**, a real-68020 codegen gate the project never had.

## Kept for a future attempt

- `render-check.mjs` — the pixel-truth oracle (use it as the gate; never trust
  vblank again).
- SMC invalidation in `m3-jit-scaffold.py` (`code0` + `ejs_smc_hits`) — correct and
  worth keeping even though it wasn't the bug.
- This document + the `puae-jit-investigation` branch history (the diagnostic builds:
  cycle magnitude, SMC guard, 1-instr blocks, `ramMax=0`, and the interp-vs-JIT cycle
  instrumentation).
