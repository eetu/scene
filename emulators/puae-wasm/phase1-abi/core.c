// Phase-1 ABI validation "core" — a stand-in for the Emscripten-compiled PUAE
// core, just big enough to confirm the three hooks a runtime 68k→WASM JIT needs:
//
//   1. a growable __indirect_function_table (built with -sALLOW_TABLE_GROWTH),
//   2. the core's linear memory is importable by a runtime side-module,
//   3. a C function pointer == its table index, so C can jump to a JIT block.
//
// core_call() takes an integer that is a table index, casts it to a function
// pointer, and calls it — exactly how UAE's newcpu dispatch will jump into a
// recompiled block. g_buf stands in for emulated guest RAM.
#include <emscripten.h>
#include <stdint.h>

static int g_buf[64];

// Byte address of the shared buffer (so JS + the runtime block hit the same RAM).
EMSCRIPTEN_KEEPALIVE int core_bufaddr(void) {
  return (int)(intptr_t)g_buf;
}

// Jump to table[idx](ptr) via a function pointer — the JIT dispatch shape.
EMSCRIPTEN_KEEPALIVE int core_call(int idx, int ptr) {
  int (*block)(int) = (int (*)(int))(intptr_t)idx;
  return block(ptr);
}
