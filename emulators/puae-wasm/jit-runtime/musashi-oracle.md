# Musashi difftest — an independent 68020 oracle for the codegen

The project's own difftests compare the JIT codegen against our JS reference
interpreter (`jit/interp.mjs`) — self-referential, so a shared misunderstanding
passes. These tools compare the codegen against **Musashi** (a real, mature m68k
core), the independent oracle that was missing.

**Result (2026-07): the codegen is correct.** 40000+ cases across registers,
addressing, memory, and terminators — 0 real failures vs Musashi. So the JIT black
screen is NOT a codegen bug; it's a JIT↔interpreter-loop integration issue in the
real core (see `../JIT-FINDINGS.md`).

## Build the oracle binary

```sh
cd <scratch>
git clone --depth 1 https://github.com/kstenerud/Musashi musashi
cd musashi
cc -O2 -o m68kmake m68kmake.c
./m68kmake                       # generates m68kops.h / m68kops.c
cc -O2 -I. -o ../m68k-oracle main.c m68kcpu.c m68kops.c softfloat/softfloat.c
```

`main.c` is a small harness (write your own): flat 16 MiB big-endian memory with
Musashi callbacks that record writes; init `M68K_CPU_TYPE_68020`; per stdin line
(all hex) `d0..d7 a0..a7 sr pc ncode w0.. nmem addr byte..`, place code at pc, set
regs (SR before PC), `m68k_execute(1)` (one warmup after reset to flush
RESET_CYCLES), print `d0..d7 a0..a7 sr pc nwrites (waddr wsize wval)..`.

## Run the difftests

```sh
M68K_ORACLE=/path/to/m68k-oracle node musashi-difftest.mjs 20000        # registers + LEA
M68K_ORACLE=/path/to/m68k-oracle node musashi-difftest-mem.mjs 20000    # loads/stores/RMW/MOVEM
M68K_ORACLE=/path/to/m68k-oracle node musashi-difftest-term.mjs 20000   # Bcc/DBcc/BRA
```

Each generates random instructions from the JIT's opcode subset, runs them through
our codegen (WASM) and the oracle, and compares D/A regs, CCR (X N Z V C), memory,
and next-PC. Musashi runs ONE instruction per case, so the harnesses use
single-instruction blocks (multi-instruction blocks would need the oracle to run N).
