// WASM block-runner: execute a program by recompiling each basic block on
// demand, caching by start-PC, and following PC (which each block writes) until
// HALT_PC or a block budget. This is the JIT dispatch loop in miniature — the
// cache is where a hot loop's block gets reused instead of re-recompiled.
import { blockAt } from "./decode.mjs";
import { recompileBlock } from "./recompile.mjs";
import * as L from "./layout.mjs";

export async function runWasm(words, mem, budget = 100000) {
  const view = new Int32Array(mem.buffer);
  const cache = new Map(); // start PC → compiled block()
  let steps = 0;
  let compiles = 0;
  while (steps < budget && (view[L.iPC] & 0xffff) !== L.HALT_PC) {
    const pc = view[L.iPC];
    let block = cache.get(pc);
    if (!block) {
      const inst = await WebAssembly.instantiate(
        await WebAssembly.compile(recompileBlock(blockAt(words, pc))),
        { env: { memory: mem } },
      );
      block = inst.exports.block;
      cache.set(pc, block);
      compiles++;
    }
    block();
    steps++;
  }
  return { steps, compiles, cached: cache.size };
}
