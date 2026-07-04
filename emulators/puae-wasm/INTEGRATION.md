# Integration scope — running PUAE with the JIT-modified core

> **Status: done.** This is the design/recon record for welding the recompiler to
> the real core. It played out as M1 (in-situ, JS hook) → M3 (in-C dispatch +
> chaining) → M4 (baked into the core, threaded). For the final state, results,
> and how it ships, see [`README.md`](README.md) and
> [`jit-runtime/README.md`](jit-runtime/README.md). The R0 findings below are
> still accurate; the milestone plan is kept as history.

Goal of this phase: **a modified `libretro-uae` core that boots a demo and
executes guest 68k code through our runtime WASM recompiler**, then measures fps
against the `bench/` baseline. We already have the two halves — a verified `.L`
recompiler (`jit/`) and a validated Emscripten ABI (`phase1-abi/`); this phase
welds them to the real core.

## What the real core gives us (recon of the cloned source)

`core/external/build/compile/puae/sources/src`:

- **Dispatch** (`newcpu.c`): `cpuop_func *cpufunctbl[65536]` indexed by opcode; the
  run loop fetches an opcode and calls `cpufunctbl[opcode](opcode)`. Our hook goes
  at the top of the per-instruction step: *is there a JIT block for this PC? run
  it; else interpret.*
- **Registers** (`newcpu.h` `struct regstruct`): `uae_u32 regs[16]` (D0–D7 =
  0..7, A0–A7 = 8..15), `uae_u32 pc`, and `uae_u8 *pc_p` — a **direct host pointer
  to the guest code stream** (`get_real_address`). The flat `regs[16]` matches our
  JIT's register-file model; `pc_p` lets the compiler read guest opcodes cheaply.
- **Memory** (`memory.h`): `get_long`/`put_long` (bank-dispatched, **big-endian**,
  handle chip/fast/custom/IO) plus JIT fast-path variants `get_long_jit` /
  `put_long_jit`. They're `STATIC_INLINE`, so we add non-inline exported wrappers.
- **Flags** (`CFLG()/ZFLG()/NFLG()/VFLG()/XFLG()` macros): the store lives in a
  machdep flag header — **the one ABI unknown to pin down** (packed vs separate
  ints; UAE historically keeps them separate/lazy for speed).
- **Bonus:** UAE already carries JIT-era scaffolding (`*_jit` accessors, `pc_p`),
  i.e. the core was built anticipating a JIT — hook points exist.

## Architecture (who calls whom)

Our recompiler is **JS**; the core is **C→WASM**. So compilation happens JS-side,
triggered by the core:

- Core **imports** from JS: `jit_get(pc) -> i32` — return a table index for a
  compiled block at `pc`, or `-1`. On miss it decodes (via `pc_p`), recompiles
  (our `jit/`), **synchronously** instantiates the block sharing the core's
  memory + `__indirect_function_table`, installs it, caches `pc→idx`, returns idx.
- Core then `call_indirect`s `table[idx]()` (the block), exactly as validated in
  `phase1-abi/`. Block reads/writes `regs[16]`, flags, and memory in place.
- Block **imports** from the core: `jit_get_long/jit_put_long` (+ word/byte)
  wrappers, so memory access is correct (banks/IO/endian). Fast-path inlining for
  plain chip/fast RAM comes later.

**Sync vs async compile:** `new WebAssembly.Module`/`Instance` are synchronous;
the main-thread 4 KB limit doesn't bite because (a) basic blocks are small and
(b) the Amiga core already runs in a **Web Worker** (threaded EmulatorJS core),
where synchronous instantiation is unrestricted. So no async plumbing in the hot
loop — compile-on-miss returns an index the same tick.

## The hard parts (ranked)

1. **Flag representation.** Our recompiler emits packed CCR; UAE stores flags its
   own way. Resolve in R0: either emit UAE's representation directly, or keep
   packed CCR and convert at block entry/exit. (Biggest correctness risk.)
2. **Real memory + endianness.** Route block memory through `jit_*_long` wrappers
   first (correct, slower). This replaces the LE-cell placeholder in `layout.mjs`.
3. **Self-modifying code.** Demos rewrite code; a cached block can go stale.
   Invalidate on writes to compiled pages (coarse page flush first).
4. **Cycle accounting / chipset sync.** The interpreter runs copper/blitter/DMA
   via `x_do_cycles` per step; a block must advance cycles by its total and yield
   at block boundaries so timing-driven effects don't break.
5. **ABI offsets are build-specific.** Emit an ABI descriptor from the core build
   (offsets of `regs`, `pc`, flags; wrapper signatures) and feed it to the JS
   recompiler so it targets the real struct.

## Milestones

- **R0 — ABI recon + descriptor.** Pin down `offsetof` for `regs`/`pc`/flags, the
  flag representation, the memory-wrapper signatures, and the exact hook line in
  the run loop. Output: a small `abi.json` the recompiler consumes. *(No behaviour
  change; pure study + a generated header.)*
- **M0 — modified core boots, hook live, JIT off.** Fork `newcpu`: add the
  `jit_get(pc)` call at the dispatch point, but stub it to always return `-1`
  (interpret). Add the imported/exported symbols + `-sALLOW_TABLE_GROWTH`. Rebuild
  via `core/` CI, boot Dreamscape/Thrilled in `bench/`, confirm **identical
  baseline fps**. This proves the build + C↔JS wiring with zero correctness risk —
  *"the emulator runs with the modified core."*
- **M1 — one real block through the JIT.** Implement `jit_get` with our recompiler
  (real regs offsets, flag handling, `jit_*_long` memory). JIT a single hot basic
  block; verify the demo behaves identically (diff vs interpreter). Everything
  unsupported still interprets.
- **M2 — correctness at coverage.** Add `.B`/`.W` (now that real byte-addressable
  memory exists), SMC invalidation, cycle accounting. Broaden until most hot-loop
  instructions JIT.
- **M3 — perf + measure.** Inline chip/fast-RAM fast path, block chaining, lazy
  flags. Re-run `bench/` on Dreamscape/Thrilled and compare to baseline (the real
  end-to-end payoff number, vs the ~3× microbench prediction).

## First step

Do **R0 + M0 together**: they're the "modified core boots and runs" milestone and
they de-risk everything (build, hook, ABI) before any JIT-correctness work. If M0
boots at baseline, the rest is incremental and always falls back to the
interpreter for anything not yet handled.

## R0 findings (resolved) ✅

- **Dispatch:** the live runners in `newcpu.c` are `#ifdef`-tangled and the plain
  `m68k_run_2` is an empty stub in this build; the real per-instruction dispatch
  is `cpu_cycles = (*cpufunctbl[regs.opcode])(regs.opcode)` inside the config's
  runner. M1 hooks *there* (check a PC→block cache before the interpreter call).
- **Registers (`struct regstruct`, global `regs`):** `uae_u32 regs[16]` (D0–D7 =
  0..7, A0–A7 = 8..15), `uae_u32 pc`, `uae_u8 *pc_p` (direct host pointer to the
  guest code stream — the compiler reads opcodes through it).
- **Flags:** `newcpu.h → machdep/m68k.h → retrodep/machdep/m68k.h`, which
  dispatches by host arch and for **wasm falls to `md-generic`**. Layout (global
  `struct flag_struct regflags`, little-endian):
  `cznv` (u32) with **N=bit15, Z=bit14, C=bit8, V=bit0**; `x` (u32) with X=bit8.
  Our packed CCR (X=16 N=8 Z=4 V=2 C=1) maps by a fixed scatter:
  `cznv = (N<<15)|(Z<<14)|(C<<8)|(V<<0)`, `x = (X<<8)` — a handful of shifts/ors
  emitted at block exit; the JIT's flag computation is unchanged.
- **Memory:** `get_long`/`put_long` (+ `*_jit` fast variants) are `STATIC_INLINE`
  in `memory.h`, bank-dispatched and big-endian-correct. We add non-inline
  exported wrappers (`jit_get_long`/`jit_put_long`/word/byte) for blocks to call.
- **ABI descriptor:** struct/global linear-memory addresses are only known
  post-link, so the patched core exports tiny helpers (`&regs`, `&regflags`,
  `offsetof` of `regs`/`pc`/`cznv`/`x`); the JS recompiler reads them once at
  init and targets the real offsets. No hardcoded layout.

## M1 build plan (grounded in R0)

Patch (`core/patches/`, extends the M0 one) adds, and CI rebuilds with:
1. **ABI-export helpers** + **exported memory wrappers** (`jit_*_long`).
2. **Hot-loop hook**: before `cpufunctbl[opcode](opcode)`, `idx = ejs_jit_get(pc)`;
   if `idx >= 0`, `((void(*)(void))idx)()` (the block) instead of interpreting.
3. **Link flags**: `-sALLOW_TABLE_GROWTH` + expose `wasmTable`/`wasmMemory`
   (RetroArch `Makefile.emulatorjs` / `build-emulatorjs.sh` — extra patch point).
4. **JS `ejs_jit_get`**: decode via `pc_p`, recompile (`jit/`) against the ABI
   offsets + md-generic flag scatter + memory wrappers, **synchronously**
   instantiate into the core's table (unrestricted in the worker), cache
   `pc→idx`, return idx.

Iteration is CI-bound (~16 min/build), so each patch lands as correct-as-possible
from the recon; verify by diffing JIT vs interpreter on a supported region, then
measure fps in `bench/` with `--vendor`.

## M1 build spec (concrete — everything located)

**Strategy to avoid rebuilds:** build the C scaffolding ONCE; iterate all JIT
logic at RUNTIME. The `EM_JS` hook only delegates: `ejs_jit_get(pc)` returns
`Module.ejsJitGet ? Module.ejsJitGet(pc) : -1`. We define/iterate
`Module.ejsJitGet` (decode→recompile→instantiate→cache) in the harness with zero
core rebuilds. Blocks import the core's exported memory wrappers + share its
table/memory (proven in `phase1-abi/`).

**Runner + hook (found):** our config → `m68k_run_2_020` (68020+, non-CE,
non-compatible, no MMU/JIT). Its inner loop (newcpu.c ~6516):

```c
r->instruction_pc = m68k_getpc();
/* ejs-jit hook (M1): */
{ int __i = ejs_jit_get((unsigned)r->instruction_pc);
  if (__i >= 0) {
    unsigned __npc = ((unsigned(*)(void))(uintptr_t)__i)(); /* block: side-effects regs/regflags/mem, returns next PC */
    m68k_setpc(__npc);                    /* resync regs.pc AND regs.pc_p (interp reads via pc_p) */
    cpu_cycles = adjust_cycles(4 * CYCLE_UNIT); /* approx per-block; refine in M2 */
    do_cycles(cpu_cycles);
    if (r->spcflags) { if (do_specialties(cpu_cycles)) exit = true; }
    continue;
  } }
r->opcode = x_get_iword(0); ...           /* unchanged interpreter path */
```

**Block ABI:** `i32 block(void)` → returns next guest PC; writes D/A via `regs`,
flags via `regflags` (md-generic scatter), memory via imported `jit_*_long`.

**C exports to add (newcpu.c):** `ejs_jit_get` (EM_JS delegator); ABI helpers
`jit_abi_regs()`=&regs.regs, `jit_abi_pc()`=&regs.pc, `jit_abi_regflags()`
=&regflags (+ cznv/x offsets are 0/4); memory wrappers `jit_get_long/put_long`
(+ word/byte) wrapping the `STATIC_INLINE` `get_long`/`put_long`.

**Link edits (`RetroArch/Makefile.emulatorjs`):** add `-s ALLOW_TABLE_GROWTH=1`
to `LDFLAGS` (line ~167); add `wasmTable,wasmMemory` to `EXPORTS` (line 132); add
`_jit_get_long,_jit_put_long,_jit_get_word,_jit_put_word,_jit_get_byte,_jit_put_byte,
_jit_abi_regs,_jit_abi_pc,_jit_abi_regflags` to `EXPORTED_FUNCTIONS` (line 124).

**Build wiring caveat:** `build.sh` clones RetroArch AND `git pull`s it before
linking, so a pre-clone+patch of the Makefile risks the pull. Cleanest: pre-clone
RetroArch (+ its EmulatorJS submodule) at the pinned commit and neutralize the
`git pull` (or pass link flags via `EMCC_CFLAGS`). Resolve this before the build
so it's one-shot.

**First build = scaffolding only:** hook returns -1 (Module.ejsJitGet undefined),
so the core boots at baseline; then implement `Module.ejsJitGet` at runtime and
iterate with no rebuilds. The one risk baked into the build is the hook-branch
correctness (pc_p resync + cycles), written carefully above from the recon.
