#!/usr/bin/env bash
# Build the ABI-validation core with the flags a JIT-capable PUAE build needs:
#   -sALLOW_TABLE_GROWTH  → __indirect_function_table can grow at runtime
#   wasmTable/wasmMemory  → JS can reach the table + memory to install blocks
set -euo pipefail
cd "$(dirname "$0")"

emcc core.c -O2 \
  -sALLOW_TABLE_GROWTH \
  -sEXPORTED_FUNCTIONS=_core_bufaddr,_core_call \
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,wasmTable,wasmMemory \
  -sMODULARIZE -sEXPORT_ES6 \
  -o core.mjs

echo "built core.mjs + core.wasm"
