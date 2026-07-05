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
| JIT→interpreter handoff | ❌ ruled out | instrumented: npc always correct, 0 odd, opcodes valid — no derail |
| **chipset/DMA/interrupt timing** | ✅ **root cause** | demo hangs in a scan/wait loop for a value the cycle-driven chipset never produces under JIT timing |

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

## Root cause — a chipset/timing hang, NOT the handoff (confirmed by instrumentation)

Handoff instrumentation (logging entry pc → returned npc, spcflags, opcode-at-npc
for the first ~120 block executions) shows the handoff is **completely sane**: npc
is always correct, **0 odd/misaligned**, opcodes valid — no derail. Instead the demo
is **stuck in a tight loop forever**, bouncing between two blocks with `spcflags=1`:

```
pc=221624 len=7 → npc=221624   op@npc=0x0c92 = CMPI.L #imm,(A2)
pc=2219b0 len=2 → npc=2219b0   op@npc=0x588a = ADDQ.L #4,A2
```

i.e. `while ((A2).L != IMM) A2 += 4` — a memory scan/wait loop spinning forever. The
codegen is correct and the loop executes exactly right; it is **waiting for a value
that never arrives**. Under the interpreter (`ramMax=0`) the value arrives and the
demo proceeds; under the JIT it never does.

So the black screen is a **chipset/DMA/interrupt-timing interaction**: the demo
waits for something the cycle-driven chipset produces (a DMA/blitter result, or a
flag set by a copper/vblank interrupt handler), and under the JIT's block-execution
timing that value/event never materializes as the demo expects → infinite wait →
black. This matches the day-one signature (clean uniform hang, vblank ticking, 0
gate-fails) and is now pinned to a concrete stuck loop. It is likely **fundamental
to block-JIT-ing a cycle-timing-sensitive Amiga** (the interpreter interleaves
CPU↔chipset per instruction; a block dynarec cannot without defeating its own
purpose), which is also why even 1-instruction blocks hang.

## What a real fix requires now

The fix is no longer about the recompiler — it's about giving JIT-executed code the
**same fine-grained CPU↔chipset timing the interpreter provides**, so waited-for
DMA/blitter/interrupt results actually appear. That likely means either:
- confirming the exact wait (instrument the stuck loop: dump A2 + `(A2)` + who writes
  the target — a DMA/blitter/interrupt), then
- making the JIT interleave chipset/event processing at (near) per-instruction
  granularity while executing blocks — which erodes the JIT's speed advantage, the
  core tension of block-JIT-ing a cycle-exact-ish Amiga.

Given that, the honest recommendation is to **keep the JIT shelved**: the recompiler
is validated and reusable, but making the chipset timing match is deep and the
speed payoff is unproven.

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
