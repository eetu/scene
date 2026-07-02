# core — PUAE WASM fork + build

Our build scripts and patches for a JIT-capable PUAE core. Upstream sources are
**cloned into `external/` (gitignored)** — we don't vendor them; we keep only
what's ours here.

## Layout

```text
core/
  README.md       this file
  .gitignore      ignores external/ clones + wasm/data build outputs
  Containerfile   amd64 Debian + emsdk 3.1.74 (EmulatorJS's pinned toolchain)
  build-core.sh   podman build of ONLY the puae core → external/build/output/
  external/       (gitignored) upstream clones: EmulatorJS/build, libretro-uae, RetroArch
  (later) patches/   our diffs against upstream (e.g. -sALLOW_TABLE_GROWTH, JIT hooks)
```

## Build

We're on arm64 macOS; EmulatorJS pins emsdk 3.1.74 and warns native ARM won't
compile some cores, so the build runs in an amd64 Debian container under **podman**
(the repo's container tool). puae's source is EmulatorJS's fork
(`EmulatorJS/libretro-uae`, per `external/build/cores.json`).

```sh
./build-core.sh          # image (cached) + build puae → external/build/output/
./build-core.sh --shell  # debug shell in the build container
```

## Goal (Phase 1)

Rebuild an **unmodified** `puae-wasm.data` from source that boots our demos
identically to the vendored one, then re-add it with the JIT build flags
validated in `../phase1-abi/` (`-sALLOW_TABLE_GROWTH`, `wasmTable`/`wasmMemory`
reachable). Only once that's clean do we start the recompiler (Phase 2).
