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

## Step 2b — real blocks (next)

Replace the self-test with the real path: on a miss, decode the guest block at
`pc` from the core's memory (via `../jit/decode.mjs` over `_jit_get_word`),
`recompileCore` it, install, cache `pc→slot`, and return the slot. Blocks with
any unsupported opcode fall back to the interpreter (return -1). Then verify JIT
vs interpreter parity on the live demo and measure the fps delta in `../bench/`.
