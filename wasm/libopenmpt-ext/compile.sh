#!/usr/bin/env bash
# Compile the custom libopenmpt WASM. Driven two ways with the same code:
#   - by build.sh inside the amd64 emsdk container (WORK=/work, OUT=/out, cwd=/src)
#   - by CI on a native amd64 runner (WORK/OUT set to repo paths, cwd=openmpt)
# Requires: emcc/em++ on PATH, cwd = the OpenMPT checkout.
#
# Compiles OpenMPT's LIBOPENMPT_CXX_SOURCES set (taken from its own Makefile)
# plus the appended shim, and links a MODULARIZE / EXPORT_ES6 / SINGLE_FILE
# module named `libopenmpt` — the drop-in contract decoder.worker.js expects.
# No -flto (LTO link deadlocks under qemu-TCG on Apple Silicon; CI amd64 could
# use it, but we keep one flag set for dev/CI parity).
set -euo pipefail

WORK="${WORK:-/work}"      # this toolchain dir (patches, shim, export lists)
OUT="${OUT:-/out}"         # object cache + final module
OPTFLAGS="${OPTFLAGS:--O1}" # local dev default: fast, no LTO (qemu-safe).
                           # CI sets "-Oz -flto" on native amd64 for a small artifact.

echo "== applying patches (reset to pristine first, so edits re-apply) =="
git checkout -- libopenmpt/libopenmpt_c.cpp libopenmpt/libopenmpt_impl.hpp 2>/dev/null || true
python3 "$WORK/patches/patch.py"
cat "$WORK/src/shim.cpp" >> libopenmpt/libopenmpt_c.cpp
echo "compile.sh: appended shim.cpp to libopenmpt/libopenmpt_c.cpp"

CXXFLAGS="-std=c++20 $OPTFLAGS -w -fno-strict-aliasing -DLIBOPENMPT_BUILD -Isrc -Icommon -I. -s DISABLE_EXCEPTION_CATCHING=0"

# LIBOPENMPT_CXX_SOURCES (OpenMPT Makefile) — dirs globbed, missing dirs ignored.
DIRS="
	src/openmpt/all src/openmpt/base src/openmpt/logging src/openmpt/random
	common
	src/openmpt/fileformat_base src/openmpt/soundbase src/openmpt/soundfile_data
	soundlib soundlib/plugins soundlib/plugins/dmo sounddsp
"
SRCS=""
for d in $DIRS; do
	for f in "$d"/*.cpp; do [ -e "$f" ] && SRCS="$SRCS $f"; done
done
# libopenmpt/*.cpp minus examples / tests / fuzzers / plugin front-ends.
for f in libopenmpt/*.cpp; do
	case "$f" in *example*|*_test*|*fuzz*|*foo_openmpt*|*in_openmpt*|*xmp-openmpt*) continue ;; esac
	SRCS="$SRCS $f"
done

mkdir -p "$OUT/obj"
printf '%s\n' $SRCS > "$OUT/srclist.txt"
echo "== compiling $(wc -l < "$OUT/srclist.txt") files (no LTO, -j$(nproc)) =="

compile_one() {
	local f="$1"
	local o="$OUT/obj/${f//\//_}.o"
	if [ -s "$o" ] && [ "$o" -nt "$f" ]; then return 0; fi
	em++ $CXXFLAGS -c "$f" -o "$o"
}
export -f compile_one
export CXXFLAGS OUT
xargs -P"$(nproc)" -a "$OUT/srclist.txt" -I{} bash -c 'compile_one "$@"' _ {}

# GROWABLE_ARRAYBUFFERS=0: emsdk 6.x defaults this to auto-on, backing grown
# memory with a *resizable* ArrayBuffer. Browsers accept resizable buffers
# generally but TextDecoder.decode() rejects them ("ArrayBuffer must not be
# resizable"), which breaks emscripten's UTF8ToString at runtime. Force the
# classic copy-on-grow (fresh plain buffer) so string decoding works in-browser.
echo "== linking libopenmpt.worklet.js (MODULARIZE ES6 SINGLE_FILE) =="
em++ $OPTFLAGS "$OUT"/obj/*.o \
	-s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=libopenmpt \
	-s WASM=1 -s SINGLE_FILE=1 -s ALLOW_MEMORY_GROWTH=1 \
	-s GROWABLE_ARRAYBUFFERS=0 \
	-s DISABLE_EXCEPTION_CATCHING=0 -s STACK_SIZE=1048576 \
	-s "EXPORTED_FUNCTIONS=@$WORK/exports.txt" \
	-s "EXPORTED_RUNTIME_METHODS=@$WORK/runtime.txt" \
	-o "$OUT/libopenmpt.worklet.js"

echo "== done =="
ls -la "$OUT/libopenmpt.worklet.js"
