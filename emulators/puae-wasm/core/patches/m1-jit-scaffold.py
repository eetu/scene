#!/usr/bin/env python3
# M1 JIT scaffolding patch for libretro-uae's newcpu.c.
#
# Adds (all runtime-iterable — the real JIT logic lives in JS at Module.ejsJitGet,
# so the core is built ONCE and the compiler is iterated with no rebuilds):
#   * EM_JS ejs_jit_get(pc): delegates to Module.ejsJitGet (returns -1 until the
#     harness defines it, so the core boots at baseline).
#   * EMSCRIPTEN_KEEPALIVE ABI helpers (linear-mem addresses of regs/pc/regflags)
#     and memory wrappers (bank + big-endian correct) — auto-exported.
#   * The dispatch hook in m68k_run_2_020's inner loop: if a block exists, run it
#     (it side-effects regs/regflags/memory and returns the next PC), resync pc_p,
#     account cycles, honour spcflags, and continue — else interpret as usual.
#
#   python3 m1-jit-scaffold.py <path-to>/newcpu.c
import sys

path = sys.argv[1]
s = open(path, encoding="utf-8", errors="surrogateescape").read()

SCAFFOLD = r"""
/* ---- ejs-jit M1 scaffolding (added by m1-jit-scaffold.py) ---- */
#include <emscripten.h>
/* Real recompiler lives in JS (Module.ejsJitGet), iterable with no core rebuild. */
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
/* ------------------------------------------------------------- */

"""

if "ejs_jit_get" in s:
    print("already patched:", path)
    sys.exit(0)

# 1) file-scope scaffolding, before do_specialties (regs/regflags/get_long in scope)
fn = "static int do_specialties (int cycles)"
assert fn in s, "anchor 'do_specialties' not found"
s = s.replace(fn, SCAFFOLD + fn, 1)

# 2) dispatch hook inside m68k_run_2_020 (function-scoped: insert before its first
#    opcode fetch; r->instruction_pc is already set on the preceding line).
f = s.index("static void m68k_run_2_020(void)")
j = s.index("r->opcode = x_get_iword(0);", f)  # first fetch in run_2_020
line_start = s.rfind("\n", 0, j) + 1
indent = s[line_start:j]  # tabs before the fetch
hook = (
    indent + "{ int __i = ejs_jit_get((unsigned)r->instruction_pc);\n"
    + indent + "  if (__i >= 0) {\n"
    + indent + "    unsigned __npc = ((unsigned(*)(void))(uintptr_t)__i)();\n"
    + indent + "    m68k_setpc(__npc);\n"
    + indent + "    cpu_cycles = adjust_cycles(4 * CYCLE_UNIT);\n"
    + indent + "    do_cycles(cpu_cycles);\n"
    + indent + "    if (r->spcflags) { if (do_specialties(cpu_cycles)) exit = true; }\n"
    + indent + "    continue;\n"
    + indent + "  } }\n"
)
s = s[:line_start] + hook + s[line_start:]

open(path, "w", encoding="utf-8", errors="surrogateescape").write(s)
print("patched:", path)
