#!/usr/bin/env bash
# Build the PUAE (Amiga) core to WASM via EmulatorJS's build orchestrator, inside
# an amd64 Debian + emsdk-3.1.74 podman container (the sanctioned env; we're on
# arm64). Builds ONLY puae. Upstream sources are cloned into external/ (gitignored)
# and outputs land in external/build/output/ — nothing here is committed.
#
#   ./build-core.sh                # full clean build, all variants (first time)
#   ./build-core.sh --incremental  # normal variant only, reuse .o (fast reruns)
#   ./build-core.sh --shell        # drop into the build container for debugging
#
# --incremental applies patches/incremental.sed to the (gitignored) build.sh
# clone so it skips `make clean` and builds only the normal variant — so
# compile/puae/build/libretro/*.o survive and `make` only recompiles what
# changed. Use it for every rebuild after the first (esp. once we patch the core
# for the JIT). A full clean build of all 4 variants takes ~40 min under
# emulation; an incremental normal-only rebuild is a fraction of that.
set -euo pipefail
cd "$(dirname "$0")" # emulators/puae-wasm/core

IMG=puae-wasm-build
BUILD_REPO="$PWD/external/build"
PATCHES="$PWD/patches"
INCREMENTAL=0
[ "${1:-}" = "--incremental" ] && INCREMENTAL=1

if [ ! -d "$BUILD_REPO" ]; then
  echo "cloning EmulatorJS/build → external/build"
  git clone --depth 1 https://github.com/EmulatorJS/build.git "$BUILD_REPO"
fi

echo "== building image $IMG (amd64, emsdk 3.1.74) =="
podman build --platform linux/amd64 -t "$IMG" -f Containerfile .

if [ "${1:-}" = "--shell" ]; then
  exec podman run --rm -it --platform linux/amd64 -v "$BUILD_REPO:/build" -w /build "$IMG" bash
fi

if [ "$INCREMENTAL" = 1 ]; then
  echo "== incremental build: patch build.sh (skip clean, normal variant only) + reuse .o =="
  podman run --rm --platform linux/amd64 \
    -v "$BUILD_REPO:/build" -v "$PATCHES:/patches:ro" -w /build \
    "$IMG" bash -lc "source /opt/emsdk/emsdk_env.sh && cp build.sh build.incr.sh && sed -i -f /patches/incremental.sed build.incr.sh && bash build.incr.sh --core=puae"
else
  echo "== full clean build, all variants (long under emulation) =="
  podman run --rm --platform linux/amd64 \
    -v "$BUILD_REPO:/build" -w /build \
    "$IMG" bash -lc "source /opt/emsdk/emsdk_env.sh && bash build.sh --core=puae"
fi

echo "== output =="
ls -la "$BUILD_REPO/output" 2>/dev/null || echo "(no output/ — check logs)"
find "$BUILD_REPO/output" -name 'puae*' 2>/dev/null
