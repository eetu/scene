#!/usr/bin/env bash
# Compile the reference interpreter with emcc -O3 (the PUAE analog: C→WASM).
set -euo pipefail
cd "$(dirname "$0")"
emcc interp.c -O3 \
  -sEXPORTED_FUNCTIONS=_run,_setprog,_setn \
  -sMODULARIZE -sEXPORT_ES6 -sENVIRONMENT=node \
  -o interp.mjs
echo "built interp.mjs + interp.wasm"
