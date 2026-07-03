# jit-runtime — browser-side JIT driver for the M1 core

The last mile: wire the JIT into the **running** core. The M1 core (built by
`.github/workflows/puae-core-jit.yml`) carries an EM_JS hook in `m68k_run_2_020`
that calls `Module.ejsJitGet(pc)` every instruction and, when it returns a
non-negative table index, casts it to a function pointer and runs that block
instead of the interpreter. This directory supplies the JS that answers.

- **`runtime.mjs`** — the driver the hook delegates to. Reaches the real core
  ABI (`_jit_abi_regs/pc/regflags`, `_jit_get/put_long`), emits blocks with the
  Node-validated codegen (`../jit/coretarget.mjs`), and installs them into the
  core's `wasmTable`. Blocks are tiny, so they compile **synchronously**
  (`new WebAssembly.Module/Instance`) — required, since the hook call is
  synchronous and can't await.
- **`harness.html`** — boots a demo on the **non-threaded** M1 core (so its
  Module lives on the main thread, reachable at
  `EJS_emulator.gameManager.Module`) and installs `ejsJitGet` the moment the ABI
  is up.
- **`server.mjs`** — serves the harness, the JIT ESM modules at their real paths,
  the M1 vendor core, one demo, and the Kickstart. Sends **no** COOP/COEP so
  `crossOriginIsolated` is false → EmulatorJS picks the non-threaded core.
- **`drive.mjs`** — headless CDP driver; boots it all and reports the result.

## Step 2a — substrate self-test (done ✅)

`runtime.mjs` currently installs a one-shot, **non-destructive** self-test as
`ejsJitGet`: on the first hook call it snapshots the real regs/flags, runs a
known reg-only block against them, verifies against the oracle, restores, and
returns -1 forever (demo keeps running on the interpreter). This proves the whole
path **in-situ**: EM_JS hook → JS → real ABI → block in the core's table →
correct mutation of the real 68k register file + md-generic flags.

```
node drive.mjs --vendor <m1-vendor-dir> \
  --demo "…/Dreamscape (AGA).hdf" --kick "…/kick40068.A1200"
# → ✅ M1 substrate proven IN-SITU  (firstPc 0xf80112, slot 39088, exact oracle match)
```

Build the `<m1-vendor-dir>` by copying the vendored EmulatorJS and swapping the
four `puae-*.data` cores for the `puae-wasm-jit-m1` artifact.

## Coverage probe — what the live demo actually needs

Before writing more codegen, `installProbe` (run: `node drive.mjs --mode probe`)
decodes the real basic block at every unique RAM `pc` the hook sees (reading
guest words through `_jit_get_word`) and tallies decoder coverage + the opcodes
that dominate the misses. Never activates a block.

**Dreamscape (TG'96), ~80s:**

- **954 unique RAM blocks**, and the set stabilises in ~3s → the hot code is a
  small, static working set. Perfect for a `pc→slot` block cache (compile once,
  reuse thousands of times).
- **Decoder coverage 24.4%** (233/954). Blocks are **short**: avg ~1 straight-line
  instr, max 7; every decoded block ends in a branch (230 Bcc, 3 DBcc).
- **Misses are dominated by the 0x4xxx family (586/721 = 81%)**, and within it by
  control flow: `0x4ef9` JMP abs.L (328), `0x4eae` JSR d16(A6) — library calls
  (144), `0x4e75` RTS (25), plus `0x43fa`/`0x41fa` LEA d16(PC),An (18). Then
  SUBQ/Scc/DBcc (35), MOVE.B (23), immediate/bit (16), CMP.W (16), MOVE.W (15).

### Data-ranked M2 scope (with measured results)

1. **Terminator-ify JMP/JSR/BSR/RTS/RTE** in `../jit/decode.mjs` — JIT the
   straight-line body before the transfer, return the terminator's PC, let the
   interpreter take the transfer. **Done → decoder coverage 24.4% → 80.1%**
   (decoded 233 → 764, failed 721 → 190). Node difftests still 4000/4000 +
   cftest + coretest 40000/40000.
2. **SUBQ/Scc/DBcc** (35 remaining misses), **MOVE.B** (23), **immediate/bit**
   (16), **CMP.W** (16), **MOVE.W** (15), residual **0x4xxx** (60: MOVEM,
   TST.W/CLR.W, PC-rel/indexed LEA, PEA).
3. **.W / .B sizes** for MOVE/TST/CLR/CMP (the core already exports
   `_jit_get_word`/`_jit_get_byte` + put variants).

### Sharpened strategic finding

After terminator-ifying, `avgBlockLen` is **0.7 straight-line instrs** (max 8):
Dreamscape's hot code is tiny blocks separated by constant subroutine/library
calls (`JSR d16(A6)` = graphics.library etc.). So a plain basic-block JIT would
execute ~1 JIT instr, then bounce to the interpreter for the transfer, every
block — the `hook → JS → call_indirect` + interpreter-transfer overhead would
dominate and likely LOSE to the pure interpreter.

The fps win therefore depends on **block chaining across transfers** (M3): link
each compiled block directly to its successors (both Bcc targets; and ideally JIT
JSR/RTS with inline stack ops so calls stay in JIT'd code) so hot loops run many
blocks without returning to the dispatcher. The 3.1× payoff was on a hot *loop*;
realising it here means keeping control flow inside the JIT, not just covering
opcodes. This reorders the plan: **coverage (M2) is necessary but not sufficient;
chaining (M3) is on the critical path to any measured speedup.**

## Step 2b — real blocks execute live (done ✅)

`installJit` runs the real path: on a miss it decodes the block at `pc` (guest
words via `_jit_get_word`), recompiles it with `../jit/coreblock.mjs` (real ABI,
md-generic flags, imported `get_long`/`put_long`, block returns next PC),
**parity-checks it against `interp.mjs`** from the same entry snapshot (shadow
memory on both sides so real RAM is never mutated; the JIT block runs on the real
reg file, then is restored), installs it into the core's `wasmTable`, caches
`pc→slot`, and returns the slot so the M1 hook runs it. Empty / unsupported /
parity-mismatch → fall back to the interpreter (-1).

Run: `node drive.mjs --mode jit --ff 24` (and `--mode off` for the interpreter
control).

### Measured on Dreamscape (TG'96)

- **132 blocks compiled, 132 activated, 0 parity-gate failures** over 38055 unique
  pcs (436 empty, 190 decode-fallback). Real decoded guest blocks execute through
  the JIT with verified parity; the demo is byte-for-byte stable (mode=off and
  mode=jit behave identically).
- **Emulation throughput (FF): interpreter 65.5 vs JIT 62.8 emulated-frames/
  wall-sec — the JIT is ~4% SLOWER.** Exactly the predicted pre-chaining result.

### Why it's slower, and what M3 must fix

Two compounding costs, both independent of opcode coverage:

1. **Per-instruction wasm→JS tax.** The M1 hook calls `ejs_jit_get(pc)` — an
   EM_JS function, i.e. a wasm→JS crossing — *before every instruction*. Even a
   cached `-1` pays that crossing every instruction. (This design was chosen so
   the recompiler iterates with zero core rebuilds; it is not how a production
   dispatch should work.)
2. **Tiny blocks.** avg ~1 straight-line instr per block, so a JIT'd block does
   ~1 instruction of useful work then returns to the (JS) dispatcher.

So the payoff needs the dispatch + chaining to live **in wasm**, not JS: a future
core build should check a `pc→slot` table in C and `call_indirect` on a hit (no
JS crossing for interpreted instructions), and compiled blocks should **chain**
directly to their successors (Bcc targets; JIT'd JSR/RTS) so hot loops never
return to the dispatcher. That is the M3 work; single-block JIT through the
JS hook cannot win, as measured.

> Note: this baseline is the idle/loader phase — the heavy AGA effect couldn't be
> measured because these demos render a static frame under headless swiftshader
> (vblank advances, canvas frozen, in both interp and JIT). The throughput metric
> (emulated-frames/wall-sec under FF) is rendering-independent and is the fair
> JIT-vs-interp speed comparison.
