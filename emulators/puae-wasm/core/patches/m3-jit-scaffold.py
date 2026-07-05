#!/usr/bin/env python3
# M3 JIT patch for libretro-uae's newcpu.c — the "catch the prize" build: move the
# dispatch INTO C and chain compiled blocks, so hot code runs with no per-
# instruction wasm→JS crossing (the M1 hook's dominant cost) and hot loops never
# return to the dispatcher.
#
# Over M1 (m1-jit-scaffold.py) this adds:
#   * A C-side direct-mapped pc→{slot,len} cache. jit_obtain() calls JS
#     (Module.ejsJitGet) only on a genuine miss (once per pc, ever — including a
#     cached "not jittable" = -1); every steady-state lookup is pure C.
#   * An in-C chain loop: after running a block, look up its successor in C and
#     run it too, until a non-resident block — no JS, no dispatcher bounce.
#   * Guest-instruction counters (total + via-JIT), exported, for a fair,
#     rendering-independent speed metric (guest instructions retired / wall-sec).
#   * ejs_jit_get now returns PACKED (len<<24)|slot (or -1); JS supplies the block
#     length so C can charge cycles + count instructions without extra crossings.
#
# SMC handling: each cache entry stores blen (block byte length, from JS) + csum
# (FNV over the whole block's bytes at compile time). Before running a cached block
# we re-checksum its bytes; a mismatch — self-modifying code that patches ANY byte,
# opcode OR operand (immediates, addresses, counts; decrunchers, part loaders, and
# scan/copy loops that patch their compare value) — invalidates + recompiles it
# (ejs_smc_hits). A first-word-only check missed operand SMC → a stale scan loop
# compared the wrong immediate → infinite loop → black. The compile-time parity
# gate can't catch this (it validates once, not on later reuse over rewritten mem).
#
#   python3 m3-jit-scaffold.py <path-to>/newcpu.c
import sys

path = sys.argv[1]
s = open(path, encoding="utf-8", errors="surrogateescape").read()

SCAFFOLD = r"""
/* ---- ejs-jit M3 scaffolding (added by m3-jit-scaffold.py) ---- */
#include <emscripten.h>
#include <stdint.h>
/* Recompiler lives in JS; returns PACKED (len<<24)|slot, or -1 (not jittable). */
EM_JS(int, ejs_jit_get, (unsigned pc), {
  return (Module.ejsJitGet ? (Module.ejsJitGet(pc) | 0) : -1);
});
/* ABI: linear-memory addresses read once by the JS recompiler. */
EMSCRIPTEN_KEEPALIVE unsigned jit_abi_regs(void)     { return (unsigned)(uintptr_t)&regs.regs[0]; }
EMSCRIPTEN_KEEPALIVE unsigned jit_abi_pc(void)       { return (unsigned)(uintptr_t)&regs.pc; }
EMSCRIPTEN_KEEPALIVE unsigned jit_abi_regflags(void) { return (unsigned)(uintptr_t)&regflags; }
/* Memory wrappers (banks + big-endian) for JIT blocks to import. */
EMSCRIPTEN_KEEPALIVE unsigned jit_get_long(unsigned a) { return get_long(a); }
EMSCRIPTEN_KEEPALIVE void jit_put_long(unsigned a, unsigned v) { put_long(a, v); }
EMSCRIPTEN_KEEPALIVE unsigned jit_get_word(unsigned a) { return get_word(a); }
EMSCRIPTEN_KEEPALIVE void jit_put_word(unsigned a, unsigned v) { put_word(a, v); }
EMSCRIPTEN_KEEPALIVE unsigned jit_get_byte(unsigned a) { return get_byte(a); }
EMSCRIPTEN_KEEPALIVE void jit_put_byte(unsigned a, unsigned v) { put_byte(a, v); }
/* byte length of the block compiled at pc (from JS) — for the SMC checksum. */
EM_JS(int, ejs_jit_bytelen, (unsigned pc), {
  return (Module.ejsJitBytelen ? (Module.ejsJitBytelen(pc) | 0) : 0);
});

/* C-side dispatch cache: direct-mapped by pc, tag-checked. slot>=0 → table index
 * of a compiled block; slot==-1 → known not-jittable (interpret); valid==0 →
 * unknown (ask JS). */
#define JIT_CACHE_BITS 16
#define JIT_CACHE_SIZE (1u << JIT_CACHE_BITS)
#define JIT_CACHE_MASK (JIT_CACHE_SIZE - 1u)
/* blen/csum = byte length + FNV checksum of the WHOLE block's bytes at compile time.
 * Guards against self-modifying code: demos patch code AND operands (immediates,
 * addresses, counts) and reuse addresses, so a block compiled+gated as correct can
 * later be RUN over rewritten memory. Before running a cached block we re-checksum
 * its bytes; a mismatch means the code (opcode OR operand) changed → invalidate +
 * recompile (ejs_smc_hits). NOTE: checking only the first word (the old guard)
 * missed operand self-modification — a patched CMPI immediate in a scan loop left a
 * stale block comparing the wrong value → infinite loop → black. */
struct ejs_jit_entry { unsigned tag; int slot; unsigned len; unsigned blen; unsigned csum; unsigned char valid; };
static struct ejs_jit_entry ejs_jit_cache[JIT_CACHE_SIZE];
/* Hot threshold: only JIT a block after it's been executed this many times on the
 * interpreter. Timing-sensitive one-shot code (boot / decrunch / chipset setup) runs
 * few times and stays interpreted (driving the chipset with correct per-instruction
 * timing); only steady-state hot loops cross the threshold and get compiled. This is
 * standard dynarec practice and avoids JITing the setup code whose divergence left
 * the demo hung in a never-satisfied scan loop. */
#define JIT_HOT_THRESHOLD 2000
static unsigned short ejs_hits[JIT_CACHE_SIZE]; /* 16-bit: must exceed the threshold */
static unsigned long long ejs_insn_total = 0; /* guest instructions retired */
static unsigned long long ejs_insn_jit   = 0; /* of which via a JIT block */
static unsigned long long ejs_smc_hits   = 0; /* stale-block recompiles (SMC) */
EMSCRIPTEN_KEEPALIVE double jit_insn_total(void) { return (double)ejs_insn_total; }
EMSCRIPTEN_KEEPALIVE double jit_insn_jit(void)   { return (double)ejs_insn_jit; }
EMSCRIPTEN_KEEPALIVE double jit_smc_hits(void)   { return (double)ejs_smc_hits; }

/* FNV-1a over the block's words — detects any code/operand change (SMC). */
static unsigned ejs_csum(unsigned pc, unsigned blen) {
  unsigned s = 2166136261u;
  for (unsigned i = 0; i + 2 <= blen; i += 2) { s = (s ^ (get_word(pc + i) & 0xffffu)) * 16777619u; }
  return s;
}
static inline struct ejs_jit_entry* ejs_jit_probe(unsigned pc) {
  struct ejs_jit_entry* e = &ejs_jit_cache[(pc >> 1) & JIT_CACHE_MASK];
  return (e->valid && e->tag == pc) ? e : (struct ejs_jit_entry*)0;
}
/* Resolve pc → cache entry, asking JS on a miss (once, then cached in C). */
static struct ejs_jit_entry* ejs_jit_obtain(unsigned pc) {
  struct ejs_jit_entry* e = &ejs_jit_cache[(pc >> 1) & JIT_CACHE_MASK];
  if (e->valid && e->tag == pc) return e;
  int packed = ejs_jit_get(pc);
  e->tag = pc; e->valid = 1;
  if (packed < 0) { e->slot = -1; e->len = 0; e->blen = 0; e->csum = 0; }
  else {
    e->slot = (packed & 0xffffff); e->len = ((unsigned)packed >> 24) & 0xff;
    e->blen = (unsigned)ejs_jit_bytelen(pc); e->csum = ejs_csum(pc, e->blen);
  }
  return e;
}
/* ------------------------------------------------------------- */

"""

if "ejs_jit_get" in s:
    print("already patched:", path)
    sys.exit(0)

# 1) file-scope scaffolding, before do_specialties (regs/regflags/get_long in scope)
fn = "static int do_specialties (int cycles)"
assert fn in s, "anchor 'do_specialties' not found"
s = s.replace(fn, SCAFFOLD + fn, 1)

# 2) dispatch hook + chain loop inside m68k_run_2_020, before the first opcode
#    fetch (r->instruction_pc is already set on the preceding line).
f = s.index("static void m68k_run_2_020(void)")
j = s.index("r->opcode = x_get_iword(0);", f)
line_start = s.rfind("\n", 0, j) + 1
I = s[line_start:j]  # indent (tabs) before the fetch
hook = (
    I + "{ unsigned __pc0 = (unsigned)r->instruction_pc;\n"
    + I + "  struct ejs_jit_entry* __e = ejs_jit_probe(__pc0);\n"
    + I + "  if (!__e) { if (++ejs_hits[(__pc0 >> 1) & JIT_CACHE_MASK] >= JIT_HOT_THRESHOLD) __e = ejs_jit_obtain(__pc0); }\n"
    + I + "  else if (__e->slot >= 0 && __e->csum != ejs_csum(__pc0, __e->blen)) { ejs_smc_hits++; __e->valid = 0; __e = ejs_jit_obtain(__pc0); }\n"
    + I + "  if (__e && __e->slot >= 0) {\n"
    + I + "    do {\n"
    + I + "      unsigned __npc = ((unsigned(*)(void))(uintptr_t)__e->slot)();\n"
    + I + "      ejs_insn_total += __e->len; ejs_insn_jit += __e->len;\n"
    + I + "      m68k_setpc(__npc);\n"
    + I + "      /* 8*CYCLE_UNIT/instr matches the interpreter's measured avg (~4139) reaching\n"
    + I + "         adjust_cycles; a flat 4* undercharged the chipset 2x (copper/DMA at half\n"
    + I + "         speed), so keep the JIT's per-instruction chipset timing at interpreter parity. */\n"
    + I + "      cpu_cycles = adjust_cycles((__e->len ? __e->len : 1) * 8 * CYCLE_UNIT);\n"
    + I + "      do_cycles(cpu_cycles);\n"
    + I + "      if (r->spcflags) { if (do_specialties(cpu_cycles)) { exit = true; break; } }\n"
    + I + "      /* re-read pc: do_specialties may have taken an interrupt (changed pc, returned 0) */\n"
    + I + "      unsigned __p = (unsigned)m68k_getpc();\n"
    + I + "      __e = ejs_jit_probe(__p);\n"
    + I + "      /* SMC: if the successor's code changed under us, drop it → outer loop recompiles */\n"
    + I + "      if (__e && __e->slot >= 0 && __e->csum != ejs_csum(__p, __e->blen)) { ejs_smc_hits++; __e->valid = 0; __e = 0; }\n"
    + I + "    } while (__e && __e->slot >= 0 && !exit);\n"
    + I + "    continue;\n"
    + I + "  } }\n"
    + I + "ejs_insn_total++; /* interpreted instruction */\n"
)
s = s[:line_start] + hook + s[line_start:]

open(path, "w", encoding="utf-8", errors="surrogateescape").write(s)
print("patched:", path)
