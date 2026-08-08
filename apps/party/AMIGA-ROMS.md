# Amiga Kickstart ROMs (party app)

Amiga demos need a **Kickstart ROM** (boot firmware). ROMs are copyrighted and
**not** bundled — supply them either **server-side** (drop in the support dir,
served to all visitors — for ROMs you're licensed to redistribute) or
**client-side** (a visitor uploads their own in the browser, never sent to the
server — see *Client-side ROMs*). Without one, PUAE falls back to the built-in
**AROS** replacement (lower compatibility — many AGA demos misbehave or drop to
a CLI).

## Which ROMs, and where

Place ROMs in **`<PARTY_ROOT>/.support/`** (the shared, unscanned support dir
spanning all parties). **Filenames matter**: PUAE (libretro-uae) selects the ROM
by the machine model's expected filename — exact names only.

| filename | Kickstart | size | CRC32 | MD5 | used by (demo filename tag) |
| --- | --- | --- | --- | --- | --- |
| `kick34005.A500` | 1.3 (rev 34.005) | 262144 | `c4f0f55f` | `82a21c1890cae844b3df741f2762d48d` | `(A500)` / `(OCS)` / `(ECS)` — 68000 + OCS/ECS |
| `kick40068.A1200` | 3.1 (rev 40.068), A1200 | 524288 | `1483a091` | `646773759326fbac3b2311fd8c8793ee` | `(AGA)` and default — 68020 + AGA |
| `kick40068.A4000` | 3.1 (rev 40.068), A4000 | 524288 | `d6bae334` | `9bdedde6a4f33555b4a270c8ca53297d` | `(030)` / `(040)` — A4000/030\|040 + FPU |

> ⚠️ `kick40068.A1200` and `kick40068.A4000` are the **same Kickstart version but
> different ROMs** (different CRC). You can't rename one to the other.

ROMs must be **raw/decrypted** dumps (no `rom.key`, no `AMIROMTYPE1` header). The
CRC32/MD5 above are for the raw dumps — verify yours match. `.support/` (ROMs
included) is baked into the data image by `just package-party-data` — see
`parties/README.md`, Step 8.

## How the app picks the machine + ROM

`EjsEmulator.svelte` chooses the PUAE model and ROM from the demo's **filename tag**:

- `(A500)` / `(OCS)` / `(ECS)` → **A500** (68000, OCS/ECS) + `kick34005.A500`
- `(030)` / `(A4030)` → **A4000/030** (68030 + FPU, AGA) + `kick40068.A4000`
- `(040)` / `(A4040)` → **A4000/040** (68040 + FPU, AGA) + `kick40068.A4000`
- anything else (typically `(AGA)`) → **A1200** (68020, AGA) + `kick40068.A1200`

Use `(030)`/`(040)` only for demos that actually need a 68030/68040 and/or an FPU
(they crash on the base A1200 68020 with a Line-F `#8000000B` or illegal-instruction
`#80000004` guru). Most AGA demos are fine as `(AGA)`.

## Running a demo locally (fs-uae)

```sh
just amiga ZIF                 # substring search over the tree
just amiga "Desert Dream"      # ambiguous → it lists the matches and stops
just amiga "/path/to/Demo (AGA).hdf"
```

The in-browser core (libretro-uae under EmulatorJS) has **no JIT**; fs-uae JITs.
A 68020+ AGA demo can crawl in the SPA and still be fine on its target hardware —
if it runs at speed in fs-uae, the image is good and the browser is the limit
(don't rebuild the `.hdf`).

The recipe derives the machine and Kickstart from the same filename tags as the
table above, and mirrors the two app defaults that bite if you hand-roll the
command:

- **8 MB fast RAM on A1200.** The model preset implies it, but the individual
  memory options default to fast = 0 and **override the preset** — any sizable
  demo then aborts with *"not enough memory available"* / returncode 10 and drops
  to the CLI. The single most common reason a freshly-imaged demo "doesn't
  start". The app forces `puae_fastmem_size = "8"`
  (`frontend/src/lib/EjsEmulator.svelte`); the recipe passes `--fast_memory=8192`.
- **`(030)` → `A4000` + `--cpu=68030`**, since fs-uae has no `A4000/030` model.

Equivalent by hand:

```sh
fs-uae --amiga_model=A1200 --kickstart_file="$PARTY_ROOT/.support/kick40068.A1200" --fast_memory=8192 --hard_drive_0="…/Title (AGA).hdf"
```

Floppy images (`.adf`/`.dms`/`.adz`/`.ipf`) go to DF0 instead of a hard drive; the
recipe picks by extension. The image list is cached at
`~/.cache/scene-amiga-images.txt` (SMB walks are slow) and rebuilt when a search
misses, which also picks up newly-added demos.

## Verifying a ROM

```sh
stat -f%z "kick40068.A4000"   # size (bytes) — must match the table
md5 -q    "kick40068.A4000"   # MD5 — must match
python3 -c 'import zlib,sys;print("%08x"%(zlib.crc32(open(sys.argv[1],"rb").read())&0xffffffff))' "kick40068.A4000"  # CRC32
```

## Sourcing

The legal source is **Cloanto Amiga Forever** (which ships these exact ROMs) or a
dump of your own hardware. Amiga Forever ROMs may be encrypted (`rom.key`); decrypt
to raw before placing (or keep `rom.key` alongside — libretro-uae can read encrypted
ROMs if the key is present, but raw is simplest).

## Client-side ROMs

When the server lacks a ROM a demo needs, the Amiga player shows an **upload**
control: the visitor picks their own ROM, the SPA injects it into the emulator
(never uploaded to the server) and remembers it (IndexedDB). A deployment can ship
*no* copyrighted ROMs while users who own them still run the demos.
