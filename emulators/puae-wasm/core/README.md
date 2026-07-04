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
./build-core.sh                # full clean build, all 4 variants (~40 min emulated)
./build-core.sh --incremental  # normal variant only, reuse .o (fast reruns)
./build-core.sh --shell        # debug shell in the build container
```

**Incremental builds.** `build.sh` runs `make clean` before each of its 4
variants (normal/threads/legacy/legacyThreads) — whose objects differ by
compile flags — so it trashes `compile/puae/build/libretro/*.o` every run.
`--incremental` applies `patches/incremental.sed` (to a throwaway copy of
`build.sh`) to skip `clean` and build **only the normal variant**, so `make`
reuses the objects and recompiles just what changed. Use it for every rebuild
after the first — essential once we start patching the core for the JIT (Phase
2), where 40-min clean rebuilds per change would be untenable. The normal
(unthreaded) variant is enough to validate the toolchain and iterate on the JIT;
the threaded/legacy variants come back via a full build for release parity.

## Goal (Phase 1)

Rebuild an **unmodified** `puae-wasm.data` from source that boots our demos
identically to the vendored one, then re-add it with the JIT build flags
validated in `../phase1-abi/` (`-sALLOW_TABLE_GROWTH`, `wasmTable`/`wasmMemory`
reachable). Only once that's clean do we start the recompiler (Phase 2).
