# Incremental single-variant patch for EmulatorJS/build's build.sh.
#
# Applied (in-container) by `build-core.sh --incremental`. It ONLY replaces lines
# with the bash no-op ':' — never deletes — so every if/fi stays balanced.
#
# Why: build.sh runs `make clean` before each of 4 variants (their objects differ
# by THREADS/LEGACY flags), trashing the expensive .o files every run. For fast
# iteration we build ONLY the normal (unthreaded, non-legacy) variant and skip
# `clean`, so `make` reuses compile/puae/build/libretro/*.o and only recompiles
# what changed. (Mixing variants' objects would be wrong — hence single-variant.)

# 1) Preserve objects: neutralize the per-variant `make clean`.
s|emmake make -f "$makefileName" clean|:|g

# 2) Build only the normal variant: neutralize the other variant CALLS.
#    (Anchored to bare call lines; the `build` normal call and the `() {`
#    definitions are left untouched.)
s|^\( *\)buildThreadsLegacy$|\1:|
s|^\( *\)buildThreads$|\1:|
s|^\( *\)buildLegacy$|\1:|

# 3) Link only the normal variant: neutralize the other variants' mv + link
#    (replace, so the surrounding `if [ requiresWebgl2 = false ]` blocks keep a body).
s|mv core-temp/threads/\*.bc \./|:|
s|mv core-temp/legacy/\*.bc \./|:|
s|mv core-temp/legacyThreads/\*.bc \./|:|
s|emmake \./build-emulatorjs.sh --clean --threads.*|:|
s|emmake \./build-emulatorjs.sh --clean --legacy.*|:|
