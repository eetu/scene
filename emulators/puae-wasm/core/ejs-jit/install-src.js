// ejs-jit self-install logic — runs INSIDE the core as post-js, so it executes on
// whatever thread the m68k loop runs (worker for the threaded core, main thread
// for the non-threaded core) and installs `Module.ejsJitGet` there. `Module` is
// the core's module (enclosing scope); D/I/CB/L are the bundled decode / interp /
// coreblock / layout namespaces (see bundle.mjs). Mirrors jit-runtime/runtime.mjs
// installJitChained + parity gate, minus any page/`window` dependency.
(function () {
  var abi = null,
    words,
    table,
    realEnv,
    jsCache;
  var GATE = true;
  // DIAGNOSTIC: ramMax=0 → JIT nothing (ejsJitGet returns -1 for all pc), so the M3
  // dispatch scaffolding runs but ZERO blocks compile/execute → pure interpreter
  // through the scaffolded loop. Isolates "JIT blocks are the bug" (renders here)
  // from "the m68k_run_2_020 scaffolding itself breaks the interpreter" (still black).
  // Restore to 0x00f00000 (don't JIT Kickstart ROM / IO) after the test.
  var ramMax = 0;
  var CFTERM = { bcc: 1, dbcc: 1 };
  var stats = { compiled: 0, activated: 0, gateFail: 0, empty: 0, decodeFail: 0, blocks: 0 };

  function memEnv() {
    return {
      memory: Module.wasmMemory,
      get_byte: Module._jit_get_byte,
      get_word: Module._jit_get_word,
      get_long: Module._jit_get_long,
      put_byte: Module._jit_put_byte,
      put_word: Module._jit_put_word,
      put_long: Module._jit_put_long,
    };
  }
  function guestWords() {
    var gw = Module._jit_get_word;
    return new Proxy(
      {},
      {
        get: function (_, p) {
          if (p === "length") return 0x40000000;
          var i = typeof p === "string" ? Number(p) : NaN;
          return Number.isInteger(i) ? gw((i * 2) >>> 0) & 0xffff : undefined;
        },
      },
    );
  }
  function packedFromMd(cznv, x) {
    return (
      ((cznv >>> 15) & 1 ? L.N : 0) |
      ((cznv >>> 14) & 1 ? L.Z : 0) |
      ((cznv >>> 8) & 1 ? L.C : 0) |
      (cznv & 1 ? L.V : 0) |
      ((x >>> 8) & 1 ? L.X : 0)
    );
  }
  function snap(dv) {
    var Dr = [],
      Ar = [];
    for (var i = 0; i < 8; i++) Dr.push(dv.getInt32(abi.regsBase + i * 4, true));
    for (var j = 0; j < 8; j++) Ar.push(dv.getInt32(abi.regsBase + 32 + j * 4, true));
    return {
      D: Dr,
      A: Ar,
      cznv: dv.getUint32(abi.regflagsBase, true) >>> 0,
      x: dv.getUint32(abi.regflagsBase + 4, true) >>> 0,
    };
  }
  function restore(dv, s) {
    for (var i = 0; i < 8; i++) dv.setInt32(abi.regsBase + i * 4, s.D[i], true);
    for (var j = 0; j < 8; j++) dv.setInt32(abi.regsBase + 32 + j * 4, s.A[j], true);
    dv.setUint32(abi.regflagsBase, s.cznv, true);
    dv.setUint32(abi.regflagsBase + 4, s.x, true);
  }
  function byteShadow() {
    var wr = new Map();
    var gb = function (a) {
      return wr.has(a >>> 0) ? wr.get(a >>> 0) : Module._jit_get_byte(a >>> 0) & 0xff;
    };
    return {
      wr: wr,
      get: function (a, sz) {
        var v = 0;
        for (var i = 0; i < sz; i++) v = ((v << 8) | gb((a + i) >>> 0)) >>> 0;
        return v >>> 0;
      },
      put: function (a, sz, val) {
        for (var i = 0; i < sz; i++) wr.set((a + sz - 1 - i) >>> 0, (val >>> (8 * i)) & 0xff);
      },
    };
  }
  // Verify a compiled block against interp from the same entry state, shadow
  // memory both sides so real RAM is untouched; JIT runs on real regs then restore.
  function parityOk(blk, mod) {
    var dv = new DataView(Module.wasmMemory.buffer);
    var s0 = snap(dv);
    var s = new Int32Array(18);
    for (var i = 0; i < 8; i++) {
      s[L.iD(i)] = s0.D[i];
      s[L.iA(i)] = s0.A[i];
    }
    s[L.iCCR] = packedFromMd(s0.cznv, s0.x);
    s[L.iPC] = blk.startPC;
    var si = byteShadow();
    s.__mem = si;
    I.interpBlock(blk, s);
    var sj = byteShadow();
    var env = {
      memory: Module.wasmMemory,
      get_byte: function (a) {
        return sj.get(a, 1);
      },
      get_word: function (a) {
        return sj.get(a, 2);
      },
      get_long: function (a) {
        return sj.get(a, 4);
      },
      put_byte: function (a, v) {
        sj.put(a, 1, v);
      },
      put_word: function (a, v) {
        sj.put(a, 2, v);
      },
      put_long: function (a, v) {
        sj.put(a, 4, v);
      },
    };
    var jitPC = new WebAssembly.Instance(mod, { env: env }).exports.block() | 0;
    var post = snap(dv);
    restore(dv, s0);
    var ok = jitPC === (s[L.iPC] | 0);
    for (var k = 0; k < 8; k++) {
      if (post.D[k] !== s[L.iD(k)]) ok = false;
      if (post.A[k] !== s[L.iA(k)]) ok = false;
    }
    if (packedFromMd(post.cznv, post.x) !== (s[L.iCCR] & 0x1f)) ok = false;
    if (sj.wr.size !== si.wr.size) ok = false;
    else
      sj.wr.forEach(function (v, a) {
        if (si.wr.get(a) !== v) ok = false;
      });
    return ok;
  }
  function initJit() {
    abi = {
      regsBase: Module._jit_abi_regs() >>> 0,
      regflagsBase: Module._jit_abi_regflags() >>> 0,
      // threaded core → shared memory; block modules must import it as shared
      shared:
        typeof SharedArrayBuffer !== "undefined" &&
        Module.wasmMemory.buffer instanceof SharedArrayBuffer,
    };
    words = guestWords();
    table = Module.wasmTable;
    realEnv = memEnv();
    jsCache = new Map();
    Module.__ejsJitStats = stats;
    if (typeof Module.ejsJitGate !== "undefined") GATE = !!Module.ejsJitGate;
    try {
      console.log(
        "[ejs-jit] 68k→WASM JIT installed (baked, gate=" + GATE + ", shared=" + abi.shared + ")",
      );
    } catch (_) {
      /* some worker contexts have no console */
    }
  }
  // The M3 C hook calls this every miss; returns packed (len<<24)|slot, or -1.
  Module.ejsJitGet = function (pc) {
    if (!abi) initJit();
    pc = pc >>> 0;
    var c = jsCache.get(pc);
    if (c !== undefined) return c;
    stats.blocks++;
    var packed = -1;
    if (pc < ramMax) {
      try {
        var blk = D.blockAt(words, pc, 64);
        var ct =
          blk.term && (blk.term.op === "bcc" || blk.term.op === "dbcc" || blk.term.op === "halt");
        if (!blk.instrs.length && !ct) stats.empty++;
        else {
          var mod = new WebAssembly.Module(CB.recompileCoreBlock(blk, abi));
          stats.compiled++;
          if (GATE && !parityOk(blk, mod)) stats.gateFail++;
          else {
            var slot = table.grow(1);
            table.set(slot, new WebAssembly.Instance(mod, { env: realEnv }).exports.block);
            var len = Math.min(0xff, blk.instrs.length + (blk.term && CFTERM[blk.term.op] ? 1 : 0));
            packed = ((len & 0xff) << 24) | (slot & 0xffffff);
            stats.activated++;
          }
        }
      } catch (e) {
        stats.decodeFail++;
      }
    }
    jsCache.set(pc, packed);
    return packed;
  };
})();
