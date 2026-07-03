# bench-jit — the payoff gate (JIT vs interpreter, both WASM)

Answers the strategic question *"is the recompiler worth integrating?"* with a
number, without touching the 20 MB core.

```sh
bash build.sh && node bench.mjs [iters]
```

Runs the **same** 8-instruction 68k hot loop (ALU + shift + memory, all computing
CCR flags) two ways, both V8-compiled WASM:

- **JIT** — our real recompiler output (`recompileLoop`), inlined into a counted
  WASM loop: operands baked in, zero per-iteration dispatch (an ideal chained JIT).
- **INTERP** — a C switch interpreter (`interp.c`) built by **emcc -O3**: the exact
  analog of PUAE (a C 68k interpreter compiled with emscripten), fetch/decode/
  dispatch per instruction, with the program loaded at runtime.

## Result

```
JIT     0.76–0.81 ns/instr
INTERP  2.37–2.51 ns/instr
speedup ≈ 3.1×   (stable across 20M / 50M iterations)
```

**A WASM JIT beats a lean WASM interpreter by ~3× on a representative hot loop.**
That's the structural win from eliminating fetch/decode/dispatch — real, and the
core of the payoff case.

## Reading it honestly

- **Conservative baseline.** `interp.c` is *lean* (pre-decoded, no memory-bank or
  chipset indirection). PUAE's real interpreter is heavier, so vs PUAE the CPU-
  dispatch win is **≥3×**.
- **Upside we're leaving on the table.** Our JIT computes **full CCR eagerly**
  every instruction; a real optimizing JIT drops dead flags — so 3× is a *floor*
  for the JIT's potential here.
- **But end-to-end is diluted.** A CPU JIT only speeds the CPU. A demo's frame
  time also includes memory access through UAE's banks and **chipset emulation**
  (blitter/copper/DMA) that the JIT doesn't touch. So a ~3× CPU speedup becomes
  *less* than 3× on a whole frame — how much less depends on how CPU-bound the
  demo is.

## What it means for integration

For CPU-bound sections, integration should give a **~3× (floor) speedup**, more
with lazy flags, less where a demo is memory/chipset-bound. So: Thrilled (38.9 →
plausibly ~50) is very likely reachable; the heaviest Dreamscape scene (~2 fps)
improves substantially but may still need the video fallback. Integration is
**worth doing** — the recompiler pays off — with realistic expectations.

## The bug this harness caught

First cut had `prog` as a compile-time `const`; emcc `-O3` **unrolled and
specialized** the interpreter loop into straight-line code (a compile-time JIT!),
making "INTERP" 11× *faster* than the JIT — a nonsense 0.09×. Loading the program
at runtime (`setprog`/`setn`) so the compiler can't assume it fixed the
measurement. A good reminder that interpreter microbenchmarks lie if the program
is constant-foldable.

`interp.mjs` / `interp.wasm` are emcc artifacts (gitignored) — rebuild with
`build.sh`.
