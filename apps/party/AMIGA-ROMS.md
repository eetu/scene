# Amiga Kickstart ROMs (party app)

Amiga demos need a **Kickstart ROM** (the Amiga's boot firmware). ROMs are
copyrighted, so they are **not** bundled — you supply them. There are two ways to
provide one:

1. **Server-side** — drop the ROM in the party's support dir; it's served to all
   visitors. Do this for ROMs you're licensed to redistribute in your deployment.
2. **Client-side upload** — a visitor supplies their own ROM in the browser; it's
   injected into the emulator and never sent to the server (see *Client-side ROMs*).

Without a ROM, PUAE falls back to the built-in **AROS** replacement (lower
compatibility — many AGA demos misbehave or drop to a CLI).

## Which ROMs, and where

Place ROMs in **`<PARTY_ROOT>/.support/`** (the shared, unscanned support dir that
spans all parties — the same place as `results.txt`-adjacent assets). **Filenames
matter**: PUAE (libretro-uae) selects the ROM by the machine model's expected
filename, so the name must be exact.

| filename | Kickstart | size | CRC32 | MD5 | used by (demo filename tag) |
| --- | --- | --- | --- | --- | --- |
| `kick34005.A500` | 1.3 (rev 34.005) | 262144 | `c4f0f55f` | `82a21c1890cae844b3df741f2762d48d` | `(A500)` / `(OCS)` / `(ECS)` — 68000 + OCS/ECS |
| `kick40068.A1200` | 3.1 (rev 40.068), A1200 | 524288 | `1483a091` | `646773759326fbac3b2311fd8c8793ee` | `(AGA)` and default — 68020 + AGA |
| `kick40068.A4000` | 3.1 (rev 40.068), A4000 | 524288 | `d6bae334` | `9bdedde6a4f33555b4a270c8ca53297d` | `(030)` / `(040)` — A4000/030\|040 + FPU |

> ⚠️ `kick40068.A1200` and `kick40068.A4000` are the **same Kickstart version but
> different ROMs** (different CRC). You can't rename one to the other.

ROMs must be **raw/decrypted** dumps (no `rom.key`, no `AMIROMTYPE1` header). The
CRC32/MD5 above are for the raw dumps — verify yours match.

## How the app picks the machine + ROM

`EjsEmulator.svelte` chooses the PUAE model and ROM from the demo's **filename tag**:

- `(A500)` / `(OCS)` / `(ECS)` → **A500** (68000, OCS/ECS) + `kick34005.A500`
- `(030)` / `(A4030)` → **A4000/030** (68030 + FPU, AGA) + `kick40068.A4000`
- `(040)` / `(A4040)` → **A4000/040** (68040 + FPU, AGA) + `kick40068.A4000`
- anything else (typically `(AGA)`) → **A1200** (68020, AGA) + `kick40068.A1200`

Use `(030)`/`(040)` only for demos that actually need a 68030/68040 and/or an FPU
(they crash on the base A1200 68020 with a Line-F `#8000000B` or illegal-instruction
`#80000004` guru). Most AGA demos are fine as `(AGA)`.

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

## Deploy

`.support/` is packaged with the party data. `just package-party-data` strips macOS
junk (`._*`, `.DS_Store`) — those sidecar files next to the ROMs are harmless. Just
ensure the real ROM files are present with the exact names above.

## Client-side ROMs

When the server doesn't have a ROM a demo needs, the Amiga player shows an **upload**
control. The visitor picks their own ROM file; the SPA injects it into the emulator
(client-side only — the ROM is never uploaded to the server) and can remember it
(IndexedDB) so it isn't re-picked every launch. This lets a deployment ship *no*
copyrighted ROMs while still letting users who own them run the demos.
