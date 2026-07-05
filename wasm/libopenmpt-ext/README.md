# libopenmpt-ext — custom libopenmpt WASM (editor/sample capabilities)

A from-source **emscripten build of libopenmpt** that adds capabilities the
stock chiptune3 WASM cannot do, as a **drop-in replacement** for
`apps/tracker/frontend/static/vendor/chiptune3/libopenmpt.worklet.js`:

- **Sample extraction** — flat `smp_*` functions returning raw sample PCM
  (`smp_read`, normalized f32) + metadata (`smp_info`: length, loop/sustain
  points, rate, channels, bit-depth). libopenmpt's **public** API exposes sample
  *names* only; the data lives in the internal `CSoundFile`, reached here via a
  one-line accessor patch (`patches/patch.py`).
- **Channel mute/solo** — `chan_mute(mod, ch, on)` mutes a pattern channel on the
  live module so the song's own render drops it. Mirrors libopenmpt_ext's
  `module_ext_impl::set_channel_mute_status` (`CHN_MUTE|CHN_SYNCMUTE` on the
  channel + NNA channels) via the **same** `CSoundFile` accessor — so no ext
  module / interactive interface is compiled or wired.
- **Structured pattern cells** — the stock build only formats a cell to a display
  string (`format_pattern_row_channel`); here we also export
  `openmpt_module_get_pattern_row_channel_command` (already in libopenmpt — an
  export-list add, no C code) so the editor can read numeric note / instrument /
  volume / effect / param per cell. Still read-only (libopenmpt has no write API).

That's all the engine needs: **keyboard jamming is done in the browser with the
Web Audio API** — the tracker builds an `AudioBuffer` from `smp_read`'s PCM and
plays it pitched to the key, looped at the sample's loop points (see
`packages/player/src/player.svelte.ts`). No libopenmpt playback engine, worker
render-loop, or worklet involvement — a jammed note is just an
`AudioBufferSourceNode`, independent of the song's transport.

This is a build-time toolchain + a runtime WASM artifact — neither a cargo
backend nor a yarn package — so it lives in its own top-level bucket, exactly
like `emulators/puae-wasm`.

## How it works

- `Containerfile` — amd64 Debian + **emsdk 3.1.74** (the same pin as
  `emulators/puae-wasm/core`). We're on arm64 macOS, so it runs under podman's
  amd64 emulation.
- `build.sh` — clones OpenMPT (`OMPT_REF`, default `libopenmpt-0.7.13`), builds
  the image, runs `compile.sh` inside it.
- `compile.sh` (runs in the container) — applies the patches, compiles the
  `LIBOPENMPT_CXX_SOURCES` file set (from OpenMPT's own Makefile) with `em++`,
  and links a **`MODULARIZE` / `EXPORT_ES6` / `SINGLE_FILE`** module named
  `libopenmpt` (the contract `decoder.worker.js` expects). Object files are
  cached under `out/obj/` for fast relinks after a shim edit.
- **No `-flto`** — full LTO deadlocks under qemu-TCG on Apple Silicon at the
  final link (the puae core hit the same wall). CI builds on a native amd64
  runner where LTO/`-Oz` are fine.
- `patches/patch.py` — adds `module_impl::shim_get_sndfile()` (the only source
  change; reaches the otherwise-protected `CSoundFile`).
- `src/shim.cpp` — appended to `libopenmpt/libopenmpt_c.cpp` (where the
  `openmpt_module` struct → `module_impl` is visible). The `smp_*` C ABI.
- `exports.txt` / `runtime.txt` — the emscripten `EXPORTED_FUNCTIONS` /
  `EXPORTED_RUNTIME_METHODS` lists (every `_openmpt_*` `decoder.worker.js` calls,
  plus the shim funcs).

## Usage

```sh
./build.sh                       # clone + image + compile → out/libopenmpt.worklet.js
OMPT_REF=libopenmpt-0.8.7 ./build.sh
node spike/spike.mjs <module>    # gate: sample PCM + channel mute + structured cells
```

Vendor the artifact **into the tracker app only** (party keeps the smaller stock
build — it uses no jam/sample features):

```sh
cp out/libopenmpt.worklet.js ../../apps/tracker/frontend/static/vendor/chiptune3/
```

## Flat C ABI (the shim)

Stateless helpers, each taking an existing `openmpt_module*` handle (the one the
worker already holds for the playing module):

| function | meaning |
| --- | --- |
| `int smp_count(openmpt_module* mod)` | number of samples |
| `int smp_info(openmpt_module* mod, int idx1, int* out16)` | fill `[len, loopS, loopE, sustS, sustE, rate, ch, bits, flags, vol, pan, finetune, relnote, globalvol, _, _]`; idx is 1-based |
| `int smp_read(openmpt_module* mod, int idx1, float* out, int maxFrames)` | mono f32 `[-1,1]`; → frames written |
| `int smp_raw(openmpt_module* mod, int idx1, unsigned char* out, int maxBytes)` | raw native-format bytes (WAV export); → bytes written |
| `int chan_mute(openmpt_module* mod, int ch, int on)` | mute/unmute pattern channel `ch` on the live module; → 1 on success |

(Structured cells use the stock libopenmpt export
`openmpt_module_get_pattern_row_channel_command`, not a shim function.)

## Bumping libopenmpt (upstream updates)

This is the **clean, reproducible** half of the vendored player — updating
libopenmpt is a tag bump + rebuild + gate, not a manual re-vendor:

```sh
OMPT_REF=libopenmpt-0.8.7 ./build.sh     # rebuild against a newer release tag
node spike/spike.mjs <module>            # re-run the Phase-2 gate
cp out/libopenmpt.worklet.js ../../apps/tracker/frontend/static/vendor/chiptune3/
```

Our divergence from upstream is deliberately tiny and version-robust, so a bump
rarely needs hand-holding — and when it does, it **fails loudly**, not silently:

- `patches/patch.py` anchors on `}; // class module_impl`; if upstream
  restructures that class it `exit 1`s (doesn't miscompile).
- `src/shim.cpp` uses only stable soundlib API (`ModSample` fields,
  `CSoundFile::GetSample`) unchanged across the 0.7/0.8 line.
- `exports.txt` — a renamed `_openmpt_*` the worker calls surfaces as a link-time
  "undefined symbol", not a runtime break.

Pinned at **`libopenmpt-0.7.13`** (contemporaneous with the repo's emsdk 3.1.74).
The CI workflow (`.github/workflows/libopenmpt-ext.yml`) builds the shippable
`-Oz -flto` artifact on a native amd64 runner and verifies the exports.

## The chiptune3 JS layer is a hard fork (no auto-sync)

Separately from this from-source WASM, the JS glue — `chiptune3.js`,
`decoder.worker.js`, `chiptune3.worklet.js` — was vendored from `chiptune3@0.8.7`
and then **heavily reworked** (off-thread decoding, the patched `getSong`, and
the jam/sample additions). That is a fork, not a tracking vendor: upstream and
ours have diverged structurally, so pulling upstream changes is a **manual
merge**, not a drop-in. In practice we own that layer now; chiptune3 upstream is
thin and near-static, and we don't track it.
