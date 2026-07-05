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
# SMC handling: the cache keys on pc, but each entry stores code0 (the first
# instruction word at compile time). Before running a cached block we compare code0
# to the live word at pc; a mismatch (self-modifying code — decrunchers, part
# loaders reusing an address) invalidates + recompiles it (counted in
# ejs_smc_hits). Without this, a stale block runs over rewritten memory → silent
# corruption the compile-time parity gate can't catch.
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
/* DIAGNOSTIC: log the first N JIT→interpreter handoffs — entry pc, the block's
 * returned next-pc, spcflags, and the opcode the interpreter will fetch at npc.
 * If npc is odd/insane or op@npc is garbage, the handoff derails; if it all looks
 * sane while the demo stays black, the handoff is fine and the cause is elsewhere. */
EM_JS(void, ejs_dbg_handoff, (unsigned pc, unsigned npc, unsigned spc, unsigned opnpc, unsigned len), {
  Module.__hn = (Module.__hn | 0);
  if (Module.__hn < 120) {
    Module.__hn++;
    console.log("[handoff] pc=" + (pc >>> 0).toString(16) + " len=" + len + " npc=" + (npc >>> 0).toString(16) +
      " spc=" + (spc >>> 0).toString(16) + " op@npc=" + (opnpc >>> 0).toString(16) + (npc & 1 ? " ODD!" : ""));
  }
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
/* code0 = the instruction word at pc when this block was compiled. Guards against
 * self-modifying code: demos decrunch/patch code and reuse addresses, so a block
 * compiled+gated as correct can later be RUN over rewritten memory. Before running
 * a cached block we compare code0 to the current word at pc; a mismatch means the
 * code changed → invalidate + recompile (counted in ejs_smc_hits). */
struct ejs_jit_entry { unsigned tag; int slot; unsigned len; unsigned code0; unsigned char valid; };
static struct ejs_jit_entry ejs_jit_cache[JIT_CACHE_SIZE];
static unsigned long long ejs_insn_total = 0; /* guest instructions retired */
static unsigned long long ejs_insn_jit   = 0; /* of which via a JIT block */
static unsigned long long ejs_smc_hits   = 0; /* stale-block recompiles (SMC) */
/* DIAGNOSTIC: sum the RAW pre-adjust_cycles charge on each path, to compare the
 * per-instruction cycle MAGNITUDE the JIT feeds do_cycles (flat len*4*CYCLE_UNIT)
 * vs the interpreter's real per-opcode value (cpufunctbl()>>16). If the averages
 * differ a lot, the JIT's chipset timing is mis-scaled → the black screen. */
static unsigned long long ejs_interp_cyc = 0; /* Σ (handler>>16) over interp instrs */
static unsigned long long ejs_jit_cyc    = 0; /* Σ (len*4*CYCLE_UNIT) over JIT blocks */
EMSCRIPTEN_KEEPALIVE double jit_insn_total(void) { return (double)ejs_insn_total; }
EMSCRIPTEN_KEEPALIVE double jit_insn_jit(void)   { return (double)ejs_insn_jit; }
EMSCRIPTEN_KEEPALIVE double jit_smc_hits(void)   { return (double)ejs_smc_hits; }
EMSCRIPTEN_KEEPALIVE double jit_interp_cyc(void) { return (double)ejs_interp_cyc; }
EMSCRIPTEN_KEEPALIVE double jit_jit_cyc(void)    { return (double)ejs_jit_cyc; }

static inline struct ejs_jit_entry* ejs_jit_probe(unsigned pc) {
  struct ejs_jit_entry* e = &ejs_jit_cache[(pc >> 1) & JIT_CACHE_MASK];
  return (e->valid && e->tag == pc) ? e : (struct ejs_jit_entry*)0;
}
/* Resolve pc → cache entry, asking JS on a miss (once, then cached in C). */
static struct ejs_jit_entry* ejs_jit_obtain(unsigned pc) {
  struct ejs_jit_entry* e = &ejs_jit_cache[(pc >> 1) & JIT_CACHE_MASK];
  if (e->valid && e->tag == pc) return e;
  int packed = ejs_jit_get(pc);
  e->tag = pc; e->valid = 1; e->code0 = get_word(pc);
  if (packed < 0) { e->slot = -1; e->len = 0; }
  else { e->slot = (packed & 0xffffff); e->len = ((unsigned)packed >> 24) & 0xff; }
  return e;
}
/* Return a runnable entry for pc, recompiling first if the code changed (SMC). */
static struct ejs_jit_entry* ejs_jit_live(unsigned pc) {
  struct ejs_jit_entry* e = ejs_jit_obtain(pc);
  if (e->slot >= 0 && e->code0 != get_word(pc)) {
    ejs_smc_hits++; e->valid = 0; e = ejs_jit_obtain(pc);
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
    I + "{ struct ejs_jit_entry* __e = ejs_jit_live((unsigned)r->instruction_pc);\n"
    + I + "  if (__e->slot >= 0) {\n"
    + I + "    do {\n"
    + I + "      unsigned __npc = ((unsigned(*)(void))(uintptr_t)__e->slot)();\n"
    + I + "      ejs_insn_total += __e->len; ejs_insn_jit += __e->len;\n"
    + I + "      m68k_setpc(__npc);\n"
    + I + "      ejs_dbg_handoff((unsigned)r->instruction_pc, __npc, (unsigned)r->spcflags, get_word(__npc), __e->len);\n"
    + I + "      /* 8*CYCLE_UNIT/instr: the interpreter's measured avg is ~4139 (=8*CYCLE_UNIT)\n"
    + I + "         per instruction reaching adjust_cycles; a flat 4* undercharged the chipset\n"
    + I + "         2x (ratio 0.49), running copper/DMA at half speed → black. */\n"
    + I + "      ejs_jit_cyc += (unsigned long long)((__e->len ? __e->len : 1) * 8 * CYCLE_UNIT);\n"
    + I + "      cpu_cycles = adjust_cycles((__e->len ? __e->len : 1) * 8 * CYCLE_UNIT);\n"
    + I + "      do_cycles(cpu_cycles);\n"
    + I + "      if (r->spcflags) { if (do_specialties(cpu_cycles)) { exit = true; break; } }\n"
    + I + "      /* re-read pc: do_specialties may have taken an interrupt (changed pc, returned 0) */\n"
    + I + "      unsigned __p = (unsigned)m68k_getpc();\n"
    + I + "      __e = ejs_jit_probe(__p);\n"
    + I + "      /* SMC: if the successor's code changed under us, drop it → outer loop recompiles */\n"
    + I + "      if (__e && __e->slot >= 0 && __e->code0 != get_word(__p)) { ejs_smc_hits++; __e->valid = 0; __e = 0; }\n"
    + I + "    } while (__e && __e->slot >= 0 && !exit);\n"
    + I + "    continue;\n"
    + I + "  } }\n"
    + I + "ejs_insn_total++; /* interpreted instruction */\n"
)
s = s[:line_start] + hook + s[line_start:]

# 3) DIAGNOSTIC: sum the interpreter's raw per-instruction cycle charge (the value
#    that feeds adjust_cycles+do_cycles) so we can compare its per-instruction
#    magnitude to the JIT's flat len*4*CYCLE_UNIT. Unique anchor in m68k_run_2_020.
anchor2 = "cpu_cycles = (*cpufunctbl[r->opcode])(r->opcode) >> 16;"
assert anchor2 in s, "interp cycle anchor not found"
s = s.replace(
    anchor2,
    anchor2 + "\n\t\t\t\tejs_interp_cyc += (unsigned long long)(unsigned)cpu_cycles;",
    1,
)

open(path, "w", encoding="utf-8", errors="surrogateescape").write(s)
print("patched:", path)
