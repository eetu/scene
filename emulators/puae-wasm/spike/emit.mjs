// Minimal WebAssembly binary encoder — enough to hand-emit the tiny modules the
// Phase-0 spike needs, and the seed of the real recompiler's codegen backend
// (the JIT will emit 68k basic blocks as WASM the same way).
//
// Only what we use: i32 ops, load/store, local.get, call_indirect. Extend as the
// recompiler grows. Everything is plain byte arrays so there are no deps and the
// output goes straight to WebAssembly.compile/instantiate.

// LEB128 unsigned.
export function uleb(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
}

// LEB128 signed.
export function sleb(n) {
  const out = [];
  let more = true;
  while (more) {
    let b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) more = false;
    else b |= 0x80;
    out.push(b);
  }
  return out;
}

export const concat = (...arrs) => arrs.flat();
const utf8 = (s) => [...new TextEncoder().encode(s)];
export const str = (s) => concat(uleb(utf8(s).length), utf8(s));
// A section: id byte + byte length + payload.
export const section = (id, payload) => concat([id], uleb(payload.length), payload);
// A vector: element count + concatenated elements (each already a byte array).
export const vec = (items) => concat(uleb(items.length), items.flat());

// value / ref / desc bytes
export const I32 = 0x7f;
export const FUNCREF = 0x70;
export const S = {
  TYPE: 1,
  IMPORT: 2,
  FUNC: 3,
  TABLE: 4,
  MEM: 5,
  EXPORT: 7,
  CODE: 10,
};

// limits: {min} (growable, no max) or {min,max}
export const limits = (l) =>
  l.max == null ? concat([0x00], uleb(l.min)) : concat([0x01], uleb(l.min), uleb(l.max));
export const memType = (l) => limits(l);
export const tableType = (l) => concat([FUNCREF], limits(l));

// func type: (params)->(results)
export const funcType = (params, results) =>
  concat([0x60], vec(params.map((p) => [p])), vec(results.map((r) => [r])));

// instruction helpers (return byte arrays)
export const op = {
  localGet: (i) => concat([0x20], uleb(i)),
  localSet: (i) => concat([0x21], uleb(i)),
  localTee: (i) => concat([0x22], uleb(i)),
  i32Const: (n) => concat([0x41], sleb(n)),
  i32Load: (off = 0, align = 2) => concat([0x28], uleb(align), uleb(off)),
  i32Store: (off = 0, align = 2) => concat([0x36], uleb(align), uleb(off)),
  i32Eqz: () => [0x45],
  i32Eq: () => [0x46],
  i32Ne: () => [0x47],
  i32LtS: () => [0x48],
  i32LtU: () => [0x49],
  i32Add: () => [0x6a],
  i32Sub: () => [0x6b],
  i32Mul: () => [0x6c],
  i32And: () => [0x71],
  i32Or: () => [0x72],
  i32Xor: () => [0x73],
  i32Shl: () => [0x74],
  i32ShrS: () => [0x75],
  i32ShrU: () => [0x76],
  select: () => [0x1b], // stack [a, b, cond] → cond!=0 ? a : b
  loop: () => [0x03, 0x40], // loop with void blocktype (branch target = loop start)
  block: () => [0x02, 0x40], // block with void blocktype (branch target = block end)
  br: (depth) => concat([0x0c], uleb(depth)),
  brIf: (depth) => concat([0x0d], uleb(depth)),
  call: (funcIdx) => concat([0x10], uleb(funcIdx)), // direct call (e.g. imported jit_get_long)
  callIndirect: (typeIdx, tableIdx = 0) => concat([0x11], uleb(typeIdx), uleb(tableIdx)),
  end: () => [0x0b],
};

// a function body: locals + instructions + end
export const body = (locals, instrs) => {
  const code = concat(
    vec(locals.map((l) => concat(uleb(l.count), [l.type]))),
    instrs.flat(),
    op.end(),
  );
  return concat(uleb(code.length), code);
};

export const MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
export const module = (sections) => new Uint8Array(concat(MAGIC, sections.flat()));
