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

### Data-ranked M2 scope

1. **Terminator-ify JMP/JSR/BSR/RTS/RTE** in `../jit/decode.mjs` — JIT the
   straight-line body, return `fallPC`, let the interpreter take the transfer.
   Unblocks ~80% of the 0x4xxx misses (the single biggest coverage jump).
2. **PC-relative / more EA modes** (`d16(PC)`, indexed) — LEA table,An is
   ubiquitous.
3. **.W / .B sizes** for MOVE/TST/CLR/CMP (the core already exports
   `_jit_get_word`/`_jit_get_byte` + put variants).
4. **SUBQ, Scc, immediate/bit ops.**

Strategic caveat: because blocks are short, single-block JIT with per-block
`hook → JS → call_indirect` overhead won't beat the interpreter on its own —
**block chaining / linking (M3)** is what turns coverage into an fps win (the
3.1× payoff was on a hot *loop*, not scattered 1-instr blocks).

## Step 2b — real blocks (next)

After the M2 codegen port, replace the self-test with the real path: on a miss,
decode the block at `pc`, `recompileCore` it (now with correct `fallPC` return +
full op/size coverage), install, cache `pc→slot`, return the slot; unsupported
blocks fall back (return -1). Then verify JIT vs interpreter parity on the live
demo and measure the fps delta in `../bench/`.
