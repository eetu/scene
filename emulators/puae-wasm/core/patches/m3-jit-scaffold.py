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
# Caveat: the cache keys on pc only (no SMC/code-write invalidation) — fine for
# steady demo hot loops; a self-modifying reuse of a pc would run a stale block.
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

/* C-side dispatch cache: direct-mapped by pc, tag-checked. slot>=0 → table index
 * of a compiled block; slot==-1 → known not-jittable (interpret); valid==0 →
 * unknown (ask JS). */
#define JIT_CACHE_BITS 16
#define JIT_CACHE_SIZE (1u << JIT_CACHE_BITS)
#define JIT_CACHE_MASK (JIT_CACHE_SIZE - 1u)
struct ejs_jit_entry { unsigned tag; int slot; unsigned len; unsigned char valid; };
static struct ejs_jit_entry ejs_jit_cache[JIT_CACHE_SIZE];
static unsigned long long ejs_insn_total = 0; /* guest instructions retired */
static unsigned long long ejs_insn_jit   = 0; /* of which via a JIT block */
EMSCRIPTEN_KEEPALIVE double jit_insn_total(void) { return (double)ejs_insn_total; }
EMSCRIPTEN_KEEPALIVE double jit_insn_jit(void)   { return (double)ejs_insn_jit; }

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
  if (packed < 0) { e->slot = -1; e->len = 0; }
  else { e->slot = (packed & 0xffffff); e->len = ((unsigned)packed >> 24) & 0xff; }
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
    I + "{ struct ejs_jit_entry* __e = ejs_jit_obtain((unsigned)r->instruction_pc);\n"
    + I + "  if (__e->slot >= 0) {\n"
    + I + "    do {\n"
    + I + "      unsigned __npc = ((unsigned(*)(void))(uintptr_t)__e->slot)();\n"
    + I + "      ejs_insn_total += __e->len; ejs_insn_jit += __e->len;\n"
    + I + "      m68k_setpc(__npc);\n"
    + I + "      cpu_cycles = adjust_cycles((__e->len ? __e->len : 1) * 4 * CYCLE_UNIT);\n"
    + I + "      do_cycles(cpu_cycles);\n"
    + I + "      if (r->spcflags) { if (do_specialties(cpu_cycles)) { exit = true; break; } }\n"
    + I + "      __e = ejs_jit_probe(__npc);\n"
    + I + "    } while (__e && __e->slot >= 0 && !exit);\n"
    + I + "    continue;\n"
    + I + "  } }\n"
    + I + "ejs_insn_total++; /* interpreted instruction */\n"
)
s = s[:line_start] + hook + s[line_start:]

open(path, "w", encoding="utf-8", errors="surrogateescape").write(s)
print("patched:", path)
