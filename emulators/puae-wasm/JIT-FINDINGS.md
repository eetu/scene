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

## What was ruled out (each via a CI rebuild + render-check)

| suspect | verdict | evidence |
| --- | --- | --- |
| Codegen | ❌ | 60000/60000 difftests; `0` runtime gate-fails |
| Self-modifying code | ❌ | added code-write invalidation (`m3-jit-scaffold.py` `code0`/`ejs_smc_hits`) → still black, only 2–19 SMC hits |
| Cycle-timing granularity | ❌ | capped blocks to 1 instruction (per-instruction `do_cycles`) → still black (but vblank moved 60→38, so the cycle model *does* matter) |

## Root cause — cycle accounting is incompatible with UAE's

The interpreter charges cycles **per opcode**: `cpu_cycles = (*cpufunctbl[op])(op)
>> 16; adjust_cycles(cpu_cycles); do_cycles(...)` (`newcpu.c` `m68k_run_2_020`).
The value comes from UAE's gencpu 020 cycle tables and is specific per instruction.

The JIT (`m3-jit-scaffold.py` dispatch hook) throws that away and charges a **flat
`len × 4 × CYCLE_UNIT`** per block, then `do_cycles` once. That is the wrong
magnitude/encoding, so the chipset (copper/blitter/DMA) advances out of sync with
the CPU. AGA demos are raster/DMA-timed to the cycle, so their render collapses →
black. The block-size experiment confirms it: changing the JIT-vs-interp cycle
ratio changed the emulated timing but never rendered — wrong in magnitude, not just
granularity.

## What a real fix requires

Make each compiled block charge the **sum of the real per-instruction 020 cycle
costs** the interpreter would (matching gencpu's tables + the `>>16`/`adjust_cycles`
convention), not a flat constant — computed at compile time and returned alongside
the block. Non-trivial (essentially porting UAE's 020 timing into the recompiler).

Weigh it against the payoff: **the JIT's speedup was never actually measured** — no
demo has rendered under it, and the old "~2.5×" numbers were `vblankFps` on a black
screen. Measure a real, rendered speedup on a couple of demos before investing in
the cycle-accounting port.

## Kept for a future attempt

- `render-check.mjs` — the pixel-truth oracle (use it as the gate; never trust
  vblank again).
- SMC invalidation in `m3-jit-scaffold.py` (`code0` + `ejs_smc_hits`) — correct and
  worth keeping even though it wasn't the bug.
- This document + the `fix/emu-render-truth` branch history (the diagnostic builds).
