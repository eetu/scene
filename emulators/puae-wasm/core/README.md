# core — PUAE WASM fork + build

Our build scripts and patches for a JIT-capable PUAE core. Upstream sources are
**cloned into `external/` (gitignored)** — we don't vendor them; we keep only
what's ours here.

## Layout

```text
core/
  README.md      this file
  .gitignore     ignores external/ clones + wasm/data build outputs
  external/      (gitignored) upstream clones: libretro-uae, EmulatorJS build
  (later) patches/   our diffs against upstream (e.g. -sALLOW_TABLE_GROWTH, JIT hooks)
  (later) build.sh   reproducible core build → puae-wasm.data
```

## Goal (Phase 1)

Rebuild an **unmodified** `puae-wasm.data` from source that boots our demos
identically to the vendored one, then re-add it with the JIT build flags
validated in `../phase1-abi/` (`-sALLOW_TABLE_GROWTH`, `wasmTable`/`wasmMemory`
reachable). Only once that's clean do we start the recompiler (Phase 2).
