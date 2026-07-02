#!/usr/bin/env bash
# Build the PUAE (Amiga) core to WASM via EmulatorJS's build orchestrator, inside
# an amd64 Debian + emsdk-3.1.74 podman container (the sanctioned env; we're on
# arm64). Builds ONLY puae. Upstream sources are cloned into external/ (gitignored)
# and outputs land in external/build/output/ — nothing here is committed.
#
#   ./build-core.sh            # build image (cached) + build puae
#   ./build-core.sh --shell    # drop into the build container for debugging
set -euo pipefail
cd "$(dirname "$0")" # emulators/puae-wasm/core

IMG=puae-wasm-build
BUILD_REPO="$PWD/external/build"

if [ ! -d "$BUILD_REPO" ]; then
  echo "cloning EmulatorJS/build → external/build"
  git clone --depth 1 https://github.com/EmulatorJS/build.git "$BUILD_REPO"
fi

echo "== building image $IMG (amd64, emsdk 3.1.74) =="
podman build --platform linux/amd64 -t "$IMG" -f Containerfile .

if [ "${1:-}" = "--shell" ]; then
  exec podman run --rm -it --platform linux/amd64 -v "$BUILD_REPO:/build" -w /build "$IMG" bash
fi

echo "== building puae core (this is long under emulation) =="
podman run --rm --platform linux/amd64 \
  -v "$BUILD_REPO:/build" -w /build \
  "$IMG" bash -lc "source /opt/emsdk/emsdk_env.sh && bash build.sh --core=puae"

echo "== output =="
ls -la "$BUILD_REPO/output" 2>/dev/null || echo "(no output/ — check logs)"
find "$BUILD_REPO/output" -name 'puae*' 2>/dev/null
