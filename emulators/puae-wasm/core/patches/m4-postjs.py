#!/usr/bin/env python3
# M4 link patch: bake the JIT recompiler into the core via --post-js so it
# self-installs Module.ejsJitGet on the emulation thread — the ONLY way the JIT
# works with the threaded core (Module lives in a worker there). Run AFTER
# m3-makefile.py (which adds ALLOW_TABLE_GROWTH + wasmTable/wasmMemory exports).
#
#   python3 m4-postjs.py <Makefile.emulatorjs> <abs-path-to-ejs-jit.js>
import sys

path, js = sys.argv[1], sys.argv[2]
s = open(path, encoding="utf-8", errors="surrogateescape").read()
if "--post-js" in s:
    print("already patched:", path)
    sys.exit(0)
assert "-s ALLOW_MEMORY_GROWTH=1" in s, "ALLOW_MEMORY_GROWTH anchor not found"
s = s.replace("-s ALLOW_MEMORY_GROWTH=1", "-s ALLOW_MEMORY_GROWTH=1 --post-js " + js, 1)
open(path, "w", encoding="utf-8", errors="surrogateescape").write(s)
print("patched --post-js", js, "into", path)
