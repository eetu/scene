// Shared memory layout for the JIT model — the single source of truth both the
// recompiler and the reference interpreter use, so they can't drift.
//
// Linear memory (byte offsets):
//   0..31    D0..D7   (index n → offset n*4)
//   32..63   A0..A7   (index n → offset 32 + n*4;  A7 = SP)
//   64       CCR      (bits X=16 N=8 Z=4 V=2 C=1)
//   256..    guest RAM region (RAM_BYTES bytes)
//
// Guest addresses are masked into the RAM region and 4-byte aligned. NOTE: RAM is
// modelled as native little-endian i32 cells here — enough to validate address
// modes + load/store + writeback + flags in isolation. Real 68k memory is
// big-endian and byte-addressable; that's handled at integration time via UAE's
// memory helpers (a later increment). Both sides here use the SAME convention,
// so the differential test is valid for codegen correctness.

export const DREG = (n) => n * 4; // D0..D7
export const AREG = (n) => 32 + n * 4; // A0..A7
export const CCR_OFF = 64; // condition codes

export const GUEST_BASE = 256; // byte offset where guest RAM starts
export const RAM_BYTES = 1024; // 256 longwords
export const RAM_MASK = (RAM_BYTES - 1) & ~3; // mask to region + 4-byte align → 0x3FC

// register-file indices for an Int32Array view (interp + difftest)
export const iD = (n) => n; // 0..7
export const iA = (n) => 8 + n; // 8..15
export const iCCR = 16;
export const PC_OFF = 68; // guest program counter (byte offset into the program)
export const iPC = 17;
export const HALT_PC = 0xffff; // sentinel PC; the runner stops when PC == HALT_PC
export const iCell = (addr) => (GUEST_BASE + (addr & RAM_MASK)) / 4; // guest addr → i32 index
export const RAM_CELL0 = GUEST_BASE / 4; // first RAM cell index (64)
export const RAM_CELLS = RAM_BYTES / 4; // 256

// CCR bit values
export const X = 16,
  N = 8,
  Z = 4,
  V = 2,
  C = 1;
