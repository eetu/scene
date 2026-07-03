# puae-wasm — fork + 68k→WASM recompiler (experimental)

Home for the experimental fork of the EmulatorJS **PUAE** (libretro-uae) Amiga
core plus a runtime **68020→WebAssembly block recompiler**, and the benchmark
harness that gates the whole effort.

This is a build-time toolchain + a runtime JS lib — neither a cargo backend nor a
yarn frontend package — so it lives in its own top-level `emulators/` bucket
rather than under `apps/`, `packages/`, or `services/`.

## Why

The vendored PUAE core (`apps/party/frontend/static/vendor/emulatorjs/cores/
puae-wasm.data`, EmulatorJS 4.2.3, PUAE 2.6.1 lineage) is **interpreter-only** in
WASM (`JIT=CPU=0`). UAE's own JIT emits x86; Cyclone/c68k are ARM/x86 assembly —
none build under Emscripten. Heavy AGA demos (e.g. Assembly '95's winner,
Parallax — *ZIF*) therefore run below their target 50 fps in-browser.

The only proven browser-JIT pattern is [v86](https://github.com/copy/v86)'s:
recompile guest basic blocks to WASM modules at runtime and hand them to
`WebAssembly.instantiate` (WASM can't generate executable code inside its own
sandbox — the host JS engine must instantiate). No m68k→WASM recompiler exists,
so a fork means *writing* it.

## Scoping insight

Two facts shrink "general Amiga JIT" to something buildable:

1. **JIT powers only the accelerated path.** The "Accurate" (cycle-exact) mode
   stays on the interpreter — cycle accuracy is exactly what a block dynarec is
   bad at. So the recompiler needs speed + correctness, not cycle timing.
2. **The content set is fixed and curated.** We target a known handful of heavy
   **AGA (68020)** demos. OCS/68000 demos already run full-speed cycle-exact. So
   the JIT only needs the common 68020 integer/addressing opcodes these demos
   actually execute, with an interpreter fallback for everything rare — no FPU
   JIT, no MMU, no 68000 JIT, no cycle-exact JIT.

## Phases (with a hard go/no-go gate)

- **Phase 0 — Baseline + integration spike (the gate). ✅ DONE — GO.**
  - `bench/` — harness that boots a real heavy AGA demo with our exact
    accelerated config and reports **effective fps** (distinct rendered frames;
    the vblank counter alone reads ~50 while a demo stutters). Baseline:
    Dreamscape (TG'96) opening effect ~1.5–2 fps, vblank ~33 (66% realtime);
    Thrilled a steady 38.9. CPU model 020→040 moves neither → host/interpreter
    bound. **The number a JIT must beat is set.**
  - `spike/` — proves the runtime-JIT substrate on V8: emit a WASM module at
    runtime, share the core's linear memory, install its export into a growable
    funcref table, `call_indirect` into it, shared-memory writes coherent both
    ways. **Passes.** `emit.mjs` is the seed of the codegen backend.
  - Residual risk carried into Phase 1: the *Emscripten* PUAE ABI (growable
    `__indirect_function_table`, memory import, fn-pointer==table-index). Needs
    `emcc` to confirm — first Phase-1 task.
- **Phase 1 — Reproducible core build. ✅ DONE.**
  - `phase1-abi/` — validated the three Emscripten hooks against a real
    emcc-compiled core: growable `__indirect_function_table`, a runtime block
    importing the core's `memory`, and fn-pointer==table-index C dispatch. The
    residual Phase-0 risk is retired — the JIT substrate is proven end-to-end.
  - `core/` — reproduces the puae core from source (`EmulatorJS/libretro-uae` +
    RetroArch, emsdk 3.1.74). **Built all 4 variants on CI**
    (`.github/workflows/puae-core.yml`, `ubuntu-latest`), each matching the
    vendored `puae-*.data` within ~0.3% and structurally identical (7z of
    `puae_libretro.{js,wasm}` + core.json). Local amd64 builds **deadlock under
    qemu-TCG on Apple Silicon** at emscripten's final JS link (the wasm compiles,
    then hangs at 0% CPU), so the core is built on the native-amd64 runner; the
    `core/` podman flow stays for local compile/iteration up to the wasm.
  - Next (Phase 2): rebuild with `-sALLOW_TABLE_GROWTH` + the recompiler hooks.
- **Phase 2 — Recompiler MVP.** 68020 decoder → IR → WASM codegen for the common
  integer/addressing subset; interpreter fallback for the rest; inline chip/fast
  RAM access, helper calls for custom-chip/IO regions. Validate against
  interpreter output.
- **Phase 3 — SMC invalidation + block-boundary cycle return.** Make heavy demos
  *correct* (self-modifying code + chipset sync are the top risks), then measure.
- **Phase 4 — Perf + integration.** Block chaining; wire the `EjsEmulator`
  accelerated-mode toggle; bump the bundle/cache version.

## Layout

```text
emulators/puae-wasm/
  README.md      this file (plan + go/no-go)
  bench/         Phase-0 baseline harness (boots a demo, reports emulated FPS)
  (later) core/  libretro-uae fork + Emscripten build pipeline
  (later) jit/   runtime 68k→WASM recompiler (JS emitter + integration glue)
```

## Fallback if the gate fails

Keep the accelerated-68030 + `normal` interpreter path for demos that run, and
pre-render the few that chug to video via the party app's existing
`video`-primary fallback — a perfect result for exactly the heavy AGA demos a JIT
would target, at ~zero engineering risk.
