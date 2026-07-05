# The 68k→WASM JIT: black-screen root cause, the fix, and measured speedup (2026-07)

**Status: FIXED and validated.** The black screen is solved by a **hot-threshold**
dynarec (only compile blocks executed ≥ N times). AGA demos render correctly and
the JIT delivers a real speedup on CPU-bound demos. This overturns the earlier
"chipset-timing hang, keep shelved" conclusion below — that diagnosis was wrong.

## TL;DR

- **Root cause of the black screen:** the JIT was compiling **cold, one-shot
  boot/setup code**. That code is chipset/interrupt-timing-sensitive; running it as
  a block (instead of instruction-by-instruction with per-instruction chipset
  interleave) desynced boot → hang → black. It was *never* the codegen (Musashi
  proved that correct) and *not* a fundamental block-JIT-vs-Amiga-timing wall.
- **The fix:** only JIT a block after it has executed **≥ 2000 times**
  (`JIT_HOT_THRESHOLD`). Boot/setup/one-shot code runs a handful of times → stays
  on the interpreter (correct timing). Hot demo effect loops run millions of times
  → get compiled (speed). Best of both.
- **Correctness:** ZIF renders **295 colours** and animates through every scene,
  identical to stock; **0 SMC hits, 0 gate failures**, no crash. On demos that fail
  to boot for unrelated packaging reasons, the JIT never engages (viaJIT ≈ 0) and
  behaves **exactly like stock** — no regression.
- **Speedup (demo-dependent, measured on real rendered demos, real-GL headless):**
  | demo | character | stock fps | JIT fps | via JIT | speedup |
  | --- | --- | --- | --- | --- | --- |
  | ZIF (Parallax) | 3D vector = **CPU-bound** | ~44 | ~62 | 73% | **~1.4×** |
  | Fruit Kitchen (Silents) | blitter = **chipset-bound** | ~41 | ~41 | 85% | ~1.0× |
  fast-forward, unthrottled, 60 s windows, reproducible. **The JIT accelerates
  CPU-bound demos; chipset/blitter-bound demos are limited by the AGA chipset
  emulation, not the CPU, so the CPU JIT can't move them.** (This is expected, not a
  bug — you can't JIT past the chipset bottleneck.)

## Why the earlier "keep shelved" conclusion was wrong

The old writeup (kept below for history) correctly proved the codegen sound (Musashi)
and correctly saw a boot hang, but drew the wrong conclusion: that block-JIT-ing a
cycle-timing-sensitive Amiga is *fundamentally* incompatible with correct timing, so
even 1-instruction blocks hang. The missing insight: **it's not *that* code runs as a
block, it's *which* code.** The cold boot/setup path is timing-sensitive and must
stay interpreted; the hot effect loops are not (they're pure compute over
already-set-up state) and JIT fine. Gating on execution count separates the two. The
"1-instruction blocks still hang" result was because they *still JIT'd the cold boot
path* — the granularity was never the problem, the **selection** was.

## The fix, concretely (`core/patches/m3-jit-scaffold.py`)

- `#define JIT_HOT_THRESHOLD 2000` and a per-PC hit counter
  `static unsigned short ejs_hits[JIT_CACHE_SIZE]` (must be ≥16-bit — a `u8` caps at
  255 < 2000 and the JIT never fires; that bug produced a "renders but jitBlk=0"
  build that looked like a win but was pure interpreter).
- Hook: on a probe miss, `if (++ejs_hits[hash(pc)] >= JIT_HOT_THRESHOLD)
  ejs_jit_obtain(pc)` — compile only once hot. Existing blocks run from the table;
  a full-block checksum (`ejs_csum`) invalidates on self-modification.
- Cycle charge `8 * CYCLE_UNIT` per instruction (matches the interpreter's
  `handler>>16` magnitude; measured JIT/interp cycle ratio ≈ 0.9×).

## How it was validated (the tooling — reuse it, don't trust vblank)

- [`jit-runtime/render-check.mjs`](jit-runtime/render-check.mjs) — the pixel-truth
  oracle. Boots a demo in **real-GL headless Chrome-for-Testing** (NOT
  `chrome-headless-shell` = swiftshader = always black) and judges the canvas colour
  histogram. This is the test the project was missing; `batch.mjs`'s `vblankFps`
  ticks even on a black hang.
- `throughput.mjs` (scratch) — emulated frames + instructions per wall-second under
  fast-forward = the honest speedup metric. Stock has no instruction counter (that's
  a JIT-patch addition), so compare **frames/sec**; both cores stay below vsync in FF
  here, so frames/sec is CPU/chipset-throughput-bound, not render-capped.
- `render-timeline.mjs` (scratch) — per-second colours + jitBlk + viaJIT% + cycle
  ratio from boot; shows the JIT warming up (172→494 hot blocks) and confirms the
  demo animates (frame counter never stalls). Note: its `wentBlack` flag false-fires
  on demo scene-transition fades (1-frame dips to <8 colours) — check the frame
  counter is still advancing before believing it.
- **Musashi oracle** ([`jit-runtime/musashi-oracle.md`](jit-runtime/musashi-oracle.md))
  — independent real-68020 codegen difftest, 40000+ cases, 0 real failures. Still the
  right gate for codegen.

## Known caveats / next steps if landing

- **Speedup is demo-dependent** — big on CPU-bound demos, ~none on chipset-bound
  ones. That's fine (never a regression), but don't advertise a flat "N× faster".
- **Warm-up cost** — each block compile is a `WebAssembly.Module` + parity gate
  (runs interp + JIT once to validate). Cheap relative to 2000 interp executions, but
  it's why cold/short windows understate the speedup. The JIT gets faster the longer
  a demo runs.
- **Threshold tuning** — 2000 is a safe first cut (renders + no MakeDir-style crash
  seen at 50, which JIT'd a hot boot block). Could sweep for the knee, but 2000 works.
- **Broader demo matrix** — validated cleanly on ZIF + Fruit Kitchen. Several
  Assembly'95 AGA HDFs fail to boot for *packaging* reasons (missing libraries,
  Execute failures) independent of the JIT — needs the ingest images fixed, not the
  JIT.
- **Landing shape** — the baked-JIT core self-installs and ignores the harness
  `mode`; to ship it behind a user toggle you'd vendor the JIT core and gate at the
  EmulatorJS layer, keeping the stock core as the fallback (as `#74` wired).

---

## Historical record (the earlier, now-overturned investigation)

Kept verbatim for the diagnostic trail; **its conclusion is superseded by the fix
above.**

### Symptom (as first seen)

Every AGA demo rendered **black** on the always-on baked-JIT core: hung at boot while
the vblank counter kept ticking, the runtime parity gate reported 0 failures, the CPU
busy-looped. Every earlier signal said "working" because none looked at pixels.

### What was ruled out (each via a CI rebuild + real-GL render-check)

| suspect | verdict | evidence |
| --- | --- | --- |
| Self-modifying code | ❌ | code-write invalidation → still black, 2–19 SMC hits |
| Cycle magnitude | ❌ (real but insufficient) | fixed 4×→8×CYCLE_UNIT (ratio 0.49×→0.99×), still black |
| Cycle/interrupt batching | ❌ | 1-instruction blocks + per-insn do_cycles/do_specialties, still black |
| Dispatch scaffolding | ❌ | `ramMax=0` (scaffold runs, 0 blocks) → RENDERS; the weaving is benign |
| JIT block codegen | ❌ PROVEN CORRECT | Musashi difftest, 40000+ cases, 0 real fails |
| JIT→interp handoff | ❌ | instrumented: npc always correct, 0 odd, opcodes valid |
| chipset/DMA/interrupt timing | ⚠️ **partially right** | boot hangs in a scan/wait loop — but the fix was to *not JIT that cold code*, not to match chipset timing in JIT'd blocks |

The old conclusion ("make JIT'd blocks interleave chipset at per-instruction
granularity, or keep shelved") aimed the fix at the wrong layer. The stuck
`while ((A2).L != IMM) A2 += 4` wait loop was real, but it was **cold boot/setup
code** — excluding it from the JIT (hot threshold) fixes the hang without touching
chipset interleave at all.
