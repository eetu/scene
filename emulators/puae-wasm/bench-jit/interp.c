// Reference "interpreter" for the JIT-vs-interpreter throughput benchmark: a
// switch interpreter over a pre-decoded bytecode program, compiled by emcc -O3
// to WASM. This mirrors PUAE's situation exactly (a C 68k interpreter compiled
// with emscripten) — and it's a LEAN one (pre-decoded, no memory-bank/chipset
// indirection), so it's a conservative baseline: if our JIT beats even this, it
// beats PUAE's heavier interpreter by at least as much.
//
// It runs the SAME 8-instruction body as the JIT (see bench.mjs), computing the
// same class of CCR flags, so per-instruction work is comparable.
#include <emscripten.h>
#include <stdint.h>

enum { OP_ADD, OP_SUB, OP_AND, OP_EOR, OP_LSL, OP_STORE, OP_LOAD, OP_ADDI };

// The program is loaded at RUNTIME from JS (setprog/setn) so the compiler can't
// prove it constant and specialize the dispatch loop away — this is what a real
// interpreter faces (program in memory, unknown at compile time). {op,a,b} triples.
static int prog[256];
static int nprog;
EMSCRIPTEN_KEEPALIVE void setprog(int i, int v) { prog[i] = v; }
EMSCRIPTEN_KEEPALIVE void setn(int n) { nprog = n; }
#define NP nprog

static int32_t r[8];
static int32_t ram[256];
static uint32_t a0;
static int32_t ccr;

static inline void nz(int32_t res) {
  ccr = (ccr & 16) | (res < 0 ? 8 : 0) | (res == 0 ? 4 : 0);
}
static inline void addf(int32_t a, int32_t b, int32_t res) {
  int c = (uint32_t)res < (uint32_t)a;
  int v = ((a ^ res) & (b ^ res)) < 0;
  ccr = (res < 0 ? 8 : 0) | (res == 0 ? 4 : 0) | (v ? 2 : 0) | (c ? 1 : 0) | (c ? 16 : 0);
}
static inline void subf(int32_t a, int32_t b, int32_t res) {
  int c = (uint32_t)a < (uint32_t)b;
  int v = ((a ^ b) & (a ^ res)) < 0;
  ccr = (res < 0 ? 8 : 0) | (res == 0 ? 4 : 0) | (v ? 2 : 0) | (c ? 1 : 0) | (c ? 16 : 0);
}

EMSCRIPTEN_KEEPALIVE int32_t run(int iters) {
  for (int i = 0; i < 8; i++) r[i] = (int32_t)(i * 2654435761u + 1u);
  a0 = 12345u;
  ccr = 0;
  for (int k = 0; k < iters; k++) {
    for (int p = 0; p < NP; p += 3) {
      int op = prog[p], a = prog[p + 1], b = prog[p + 2];
      switch (op) {
        case OP_ADD: { int32_t x = r[a], y = r[b], res = x + y; r[a] = res; addf(x, y, res); } break;
        case OP_SUB: { int32_t x = r[a], y = r[b], res = x - y; r[a] = res; subf(x, y, res); } break;
        case OP_AND: { int32_t res = r[a] & r[b]; r[a] = res; nz(res); } break;
        case OP_EOR: { int32_t res = r[a] ^ r[b]; r[a] = res; nz(res); } break;
        case OP_LSL: { int32_t x = r[a]; int n = b; int32_t res = x << n; int c = (int)((uint32_t)x >> (32 - n)) & 1;
                       ccr = (res < 0 ? 8 : 0) | (res == 0 ? 4 : 0) | (c ? 1 : 0) | (c ? 16 : 0); r[a] = res; } break;
        case OP_STORE: { int32_t val = r[b]; ram[a0 & 255] = val; nz(val); } break;
        case OP_LOAD: { int32_t val = ram[a0 & 255]; r[a] = val; nz(val); } break;
        case OP_ADDI: { int32_t x = r[a], res = x + b; r[a] = res; addf(x, b, res); } break;
      }
    }
  }
  int32_t s = ccr;
  for (int i = 0; i < 8; i++) s += r[i];
  return s + (int32_t)a0;
}
