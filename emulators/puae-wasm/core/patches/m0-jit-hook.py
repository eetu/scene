#!/usr/bin/env python3
# M0 integration patch for libretro-uae's newcpu.c.
#
# Adds the C<->JS JIT hook boundary and exercises it from a NON-hot, always-run
# path (do_specialties, which fires on every vsync/interrupt), returning -1 so
# the core keeps interpreting — zero behaviour change. This proves the patched
# core builds, boots at baseline, and the EM_JS boundary is compiled + linked +
# runs, before any hot-loop dispatch surgery (that's M1).
#
#   python3 m0-jit-hook.py <path-to>/newcpu.c
import sys

path = sys.argv[1]
s = open(path, encoding="utf-8", errors="surrogateescape").read()

EMJS = """
/* ---- ejs-jit M0 hook (stub: always -1 => interpret). Added by m0-jit-hook.py ---- */
#include <emscripten.h>
EM_JS(int, ejs_jit_get, (unsigned pc), {
  Module.__ejsJit = (Module.__ejsJit | 0) + 1;
  if (Module.__ejsJit === 1 && typeof out === "function")
    out("[ejs-jit] hook alive (M0 stub, always interpret)");
  return -1;
});
/* ------------------------------------------------------------------------------- */

"""

fn = "static int do_specialties (int cycles)"
if EMJS in s:
    print("already patched:", path)
    sys.exit(0)
assert fn in s, "anchor 'do_specialties' not found"
s = s.replace(fn, EMJS + fn, 1)

# insert the call right after do_specialties computes pc
call_anchor = "uaecptr pc = m68k_getpc();\n\tuae_atomic spcflags = regs.spcflags;"
assert call_anchor in s, "do_specialties body anchor not found"
s = s.replace(
    call_anchor,
    "uaecptr pc = m68k_getpc();\n\t(void)ejs_jit_get((unsigned)pc); /* ejs-jit M0 */\n\tuae_atomic spcflags = regs.spcflags;",
    1,
)

open(path, "w", encoding="utf-8", errors="surrogateescape").write(s)
print("patched:", path)
