# puae-wasm — fork + 68k→WASM recompiler

A fork of the EmulatorJS **PUAE** (libretro-uae) Amiga core with a runtime
**68020→WebAssembly block recompiler**, plus the toolchain that builds, validates,
and benchmarks it. **Status: the JIT is disabled — it renders AGA demos black (see
below); the party app ships the stock non-JIT PUAE core.** The recompiler and its
investigation live on here.

This is a build-time toolchain + a runtime JS lib — neither a cargo backend nor a
yarn frontend package — so it lives in its own top-level `emulators/` bucket
rather than under `apps/`, `packages/`, or `services/`.

## Status — JIT disabled (renders black); stock core ships ⚠️

The recompiler is baked into the core (`--post-js`, self-installs on the m68k
thread) and *was* vendored + on by default. But it **renders AGA demos black**: it
hangs the demo at boot while the vblank counter keeps ticking and the runtime
parity gate reports **0 failures** — proven pixel-for-pixel by
[`jit-runtime/render-check.mjs`](jit-runtime/render-check.mjs) (ZIF on the stock
core → 292 distinct colours; on the JIT core → 2, flat black). So the app now
vendors the **stock non-JIT PUAE core** (renders correctly, normal interpreter
speed); the JIT is parked pending a real fix.

**Why every earlier test said "working":** the difftests (60000/60000) and the
runtime parity gate are **compile-time, per-block** checks of registers + memory
writes. They structurally cannot see (a) cycle/chipset **timing** (the JIT charges
a flat `len×4` cycles per block and advances the chipset only at block
boundaries), (b) **self-modifying-code** reuse (a block re-run after its backing
memory changed — decrunchers, part loaders), or (c) block **chaining**. And the
old benchmarks measured `vblankFps`, which keeps ticking on a black hang — so the
"~2.5×" numbers were speed-on-a-black-screen and are withdrawn. `render-check.mjs`
closes that hole by reading actual canvas pixels; root-cause work + candidate
fixes (starting with SMC invalidation) are on the `fix/emu-render-truth` branch.
Full M1→M4 build-up lives in [`jit-runtime/README.md`](jit-runtime/README.md).

### Operational finding — AGA demos must be HDF, not ADF

Validating the JIT across the party archive surfaced a machine-selection bug
independent of the JIT: lr-puae picks the Amiga model **per media**
(`puae_model_fd` for floppies = **A500/ECS** default; `puae_model_hd` for hard
drives = A1200/AGA), and EmulatorJS writes every option at its default, so the
`(AGA)` filename tag alone can't force AGA on an ADF. AGA demos wrapped in `.adf`
therefore booted a non-AGA A500 and their config-checkers aborted. Fix: **package
every AGA prod as a bootable `.hdf`** (proven — the same prod fails as `.adf`,
launches as `.hdf`). All 36 `(AGA)` ADFs across the four parties were converted;
the `.support/AGA-images-README.md` in each party's data tree documents the rule +
recipe. `jit-runtime/batch.mjs` is the headless launch-checker that found it.

### Operational note — WebGL2 core selection (a red herring for the black screen)

EmulatorJS ships each core in **four builds** — {non-threaded, threaded} ×
{modern (WebGL2), `-legacy` (WebGL1)} — and picks one at load time:

```js
s = (supportsWebgl2 && webgl2Enabled) ? "" : "-legacy";   // → puae[-thread][-legacy]-wasm.data
```

`webgl2Enabled` is `null` unless a saved per-origin setting or the report JSON
(`options.defaultWebGL2`) supplies one — ours has neither (and it 404s in prod) —
so a fresh origin fell to the `-legacy` build. `EjsEmulator.svelte` pins
`webgl2Enabled: "enabled"` so the modern core loads everywhere. This is kept as
reasonable hygiene (consistent modern renderer across deployments).

**But WebGL2 was NOT the black-screen fix — that was a misdiagnosis.** The A/B
that "confirmed" it only checked which *variant* downloaded, never the pixels. The
black screen is the **JIT** (see Status), which is baked into *all four* builds
(`ejsJitGet` verified present in each `.data`; the legacy core in prod also logged
`JIT active`) — so it blacks out AGA on WebGL1 *and* WebGL2. Forcing WebGL2 does
not fix, and never fixed, the black screen; swapping to the stock non-JIT core
does. Lesson baked into `render-check.mjs`: verify pixels, not which file loaded.

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
- **Phase 2 — Recompiler MVP. ✅ DONE.** 68020 decoder → IR → WASM codegen
  (`jit/`) for the common integer/addressing/bit/mul/shift subset, sized .B/.W/.L,
  MOVEM, Bcc/DBcc terminators; interpreter fallback for the rest; inline RAM
  access via imported sized get/put. Validated against a reference interpreter —
  60000/60000 difftests.
- **Phase 3 — In-situ correctness + in-C dispatch (M1–M3). ✅ DONE.** Real decoded
  guest blocks execute live on the core's register file + memory, **parity-gated**
  per block (`jit-runtime/`). Dispatch + block chaining moved into C
  (`m3-jit-scaffold.py`) to kill the per-instruction wasm→JS tax.
- **Phase 4 — Baked, threaded, integrated (M4). ✅ DONE.** Recompiler bundled into
  the core via `--post-js` (`core/ejs-jit/`) so it self-installs on the emulation
  worker (shared-memory block imports for the threaded core); vendored into the
  party app; `EjsEmulator` defaults it on with a forgiving settings override.

## Layout

```text
emulators/puae-wasm/
  README.md      this file — plan, status, results
  INTEGRATION.md notes on wiring the JIT into the running core
  bench/         baseline harness (boots a demo, reports emulated FPS)
  spike/         runtime-JIT substrate proof + emit.mjs (the WASM encoder)
  phase1-abi/    validates the Emscripten hooks (table growth, memory import)
  jit/           the recompiler: decode → interp (oracle) → coreblock codegen + difftests
  core/          reproducible core build; patches/ (M1–M4 hooks) + ejs-jit/ (baked bundle)
  jit-runtime/   in-browser driver, harness, headless drivers (drive.mjs, batch.mjs)
```

## If you're picking this up

- Detailed results + the "codegen isn't the in-core bottleneck" analysis:
  [`jit-runtime/README.md`](jit-runtime/README.md).
- To rebuild the core: the M4 CI workflow (`.github/workflows/puae-core-jit-m4.yml`)
  bundles `core/ejs-jit/` and builds via the `core/patches/` scripts.
- To re-verify demos launch: `node jit-runtime/batch.mjs --dir <party>/amiga`.
