#!/usr/bin/env bash
# Build a custom libopenmpt WASM (jamming + sample extraction) — a drop-in for
# apps/tracker/frontend/static/vendor/chiptune3/libopenmpt.worklet.js.
#
# amd64 Debian + emsdk 6.0.2 podman container
# (we're arm64 → qemu). Clones OpenMPT, builds the image, runs compile.sh inside.
#
#   ./build.sh                       full build → out/libopenmpt.worklet.js
#   OMPT_REF=libopenmpt-0.8.7 ./build.sh
#   IMG=libopenmpt-ext-build ./build.sh   reuse an existing emsdk image (skip image build)
#   ./build.sh --shell               drop into the build container to debug
set -euo pipefail
cd "$(dirname "$0")"

OMPT_REF="${OMPT_REF:-libopenmpt-0.8.7}"
IMG="${IMG:-libopenmpt-ext-build}"
SRC="$PWD/external/openmpt"
OUT="$PWD/out"
mkdir -p "$OUT"

if [ ! -d "$SRC/.git" ]; then
	echo "== cloning OpenMPT @ $OMPT_REF → external/openmpt =="
	git clone --depth 1 --branch "$OMPT_REF" https://github.com/OpenMPT/openmpt "$SRC"
fi

if [ "$IMG" = "libopenmpt-ext-build" ]; then
	echo "== building image $IMG (amd64, emsdk 6.0.2) =="
	podman build --platform linux/amd64 -t "$IMG" -f Containerfile .
fi

if [ "${1:-}" = "--shell" ]; then
	exec podman run --rm -it --platform linux/amd64 \
		-v "$SRC:/src" -v "$PWD:/work:ro" -v "$OUT:/out" -w /src "$IMG" bash
fi

echo "== compiling in container =="
podman run --rm --platform linux/amd64 \
	-v "$SRC:/src" -v "$PWD:/work:ro" -v "$OUT:/out" -w /src \
	"$IMG" bash -lc 'source /opt/emsdk/emsdk_env.sh && bash /work/compile.sh'

echo "== output =="
ls -la "$OUT/libopenmpt.worklet.js" 2>/dev/null || echo "(no output — check logs)"
