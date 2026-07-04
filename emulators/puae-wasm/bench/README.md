# puae-wasm bench — Phase-0 baseline harness

Boots a real heavy AGA demo in the **vendored** EmulatorJS PUAE core with the
party app's exact accelerated config, and measures how badly it lags — the
number a 68k→WASM recompiler has to beat. No repo deps: a static Node server + a
cached `chrome-headless-shell` driven over the DevTools Protocol.

## The two fps signals (why we measure both)

`getFrameNum` alone is a **trap**: it counts the Amiga's vblank (50 Hz PAL), which
the core reports as ~50 even when the demo is visibly stuttering — so it *hides*
lag. We therefore report two numbers:

- **effectiveFps** — distinct rendered frames/sec, from hashing the actual
  emulator canvas every host frame (needs `preserveDrawingBuffer`, which
  `index.html` forces on before the core loads). This is the **real lag metric**.
- **vblankFps** — the core's `get_current_frame_count`. Stays ~50 while the host
  keeps realtime; **dips below 50 when the host/interpreter can't emulate fast
  enough**.

Reading the regime:

| effectiveFps | vblankFps | meaning |
|---|---|---|
| < target | ≈ 50 | guest CPU too slow but host realtime → config lever (faster CPU model) |
| < target | **< 50** | **host/interpreter-bound → JIT / video-fallback territory** |

## Baseline finding — host-bound, no config cures it

**Primary benchmark: Triumph — *Dreamscape* (The Gathering '96, Amiga demo #2,
AGA).** Chosen because its heavy AGA effect runs *from the start* (after a short
AmigaDOS banner), so it stresses the CPU immediately. Warp past the banner, then
measure at 1×:

```
030 normal (app default)   effective ~1.5–2 fps   vblank ~33   (≈66% of realtime, stable 30s)
```

The effect is so CPU-heavy that only ~2 of the 33 emulated frames/sec are
visually distinct — each visual frame spans ~20 vblanks. `Page.captureScreenshot`
literally times out on these frames (the software renderer is saturated),
corroborating the load. This is the harshest worst-case: a ~2 fps slideshow a
5–10× recompiler would lift to double digits.

**Secondary — Embassy — *Thrilled* (Assembly '95, AGA).** A continuous
mid-weight animator (`scan.mjs` picked it as the steadiest): warped past its
intro it holds `effective == vblank == 38.9` dead flat — every frame distinct,
the whole machine at a constant **78% of realtime**. Cleaner to read than
Dreamscape's near-static heavy scene, useful as a stable regression number.

Across both, raising the emulated CPU model (020→030→040) does **not** help —
there's no 68k JIT in the WASM core, so the interpreter can't produce the MIPS.
This matches native fs-uae curing the same class of demo *because its 030 path is
JIT-accelerated*. (ZIF, the ASM'95 winner, is bursty — static title → short
animation → static — and awkward to benchmark; same host-bound signature though.)

## Usage

```sh
# 1) Manual (see + hear it in your own browser; HUD shows both fps):
node server.mjs \
  --demo "/Volumes/scene/parties/Assembly95/amiga/demo/01 - Parallax - ZIF/.support/ZIF (AGA).hdf" \
  --kick "/Volumes/scene/parties/.support/kick40068.A1200"
# open http://localhost:8790/

# 2) Headless baseline (objective number, no screenshot needed).
#    --ff N warps past N emulated seconds of intro; --noanim samples immediately.
# Primary — Dreamscape opening effect (~1.5–2 fps / vblank ~33):
node measure.mjs \
  --demo "/Volumes/scene/parties/Gathering96/amiga/demo/02 - Triumph - Dreamscape/.support/Dreamscape (AGA).hdf" \
  --ff 10 --noanim --measure 30
# Secondary — Thrilled steady regression number (~38.9 fps):
node measure.mjs \
  --demo "/Volumes/scene/parties/Assembly95/amiga/demo/10 - Embassy - Thrilled/.support/Thrilled (AGA).hdf" \
  --ff 12 --measure 15
node measure.mjs --matrix              # + 020/030/040 sweep for the record

# 3) See the actual screen / diff frames (composited via CDP, bypasses TCC):
node capture.mjs --cfg "cpu=68030&compat=normal" --count 8 --interval 2 --out ./shots

# 4) Find a demo that animates continuously from early on (ZIF is bursty):
node scan.mjs --dir "/Volumes/scene/parties/Assembly95/amiga/demo"
```

Requires the demo tree at `/Volumes/scene/parties/...` and the (unbundled,
copyrighted) Kickstart ROM at `/Volumes/scene/parties/.support/kick40068.A1200`.

## Gotchas baked in here

- **BIOS filename matters.** PUAE finds the Kickstart by name; EmulatorJS names
  the downloaded BIOS from the basename of `EJS_biosUrl`. Serve it as
  `kick40068.A1200` or the core reports "ROM not found" and never boots (the
  frame counter still ticks on the *error screen* — a silent way to benchmark
  nothing).
- **COOP/COEP** on every response → `crossOriginIsolated` → the threaded core.
- **swiftshader WebGL** needs `--enable-unsafe-swiftshader`; `Page.captureScreenshot`
  can stall on heavy frames, so the *measurement* uses the in-page hash, not
  screenshots.
