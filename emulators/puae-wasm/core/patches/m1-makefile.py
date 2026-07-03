#!/usr/bin/env python3
# M1 link patch for RetroArch/Makefile.emulatorjs.
#   * -s ALLOW_TABLE_GROWTH=1  → the JS recompiler can grow __indirect_function_table
#     and install runtime blocks (proven in phase1-abi/).
#   * wasmTable,wasmMemory added to EXPORTS (EXPORTED_RUNTIME_METHODS) → JS can reach
#     the table (install blocks) + memory (block imports it; read guest code/regs).
# The jit_* functions auto-export via EMSCRIPTEN_KEEPALIVE, so no EXPORTED_FUNCTIONS edit.
#
#   python3 m1-makefile.py <path-to>/Makefile.emulatorjs
import sys

path = sys.argv[1]
s = open(path, encoding="utf-8", errors="surrogateescape").read()

if "ALLOW_TABLE_GROWTH" in s:
    print("already patched:", path)
    sys.exit(0)

assert "-s ALLOW_MEMORY_GROWTH=1" in s, "ALLOW_MEMORY_GROWTH anchor not found"
s = s.replace("-s ALLOW_MEMORY_GROWTH=1", "-s ALLOW_MEMORY_GROWTH=1 -s ALLOW_TABLE_GROWTH=1", 1)

assert "EmulatorJSGetMemoryData" in s, "EXPORTS anchor not found"
s = s.replace("EmulatorJSGetMemoryData", "EmulatorJSGetMemoryData,wasmTable,wasmMemory", 1)

open(path, "w", encoding="utf-8", errors="surrogateescape").write(s)
print("patched:", path)
