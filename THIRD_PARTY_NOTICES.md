# Third-party notices

This project bundles and serves third-party software and fonts. They remain the
property of their respective authors under the licenses below; this file collects
the required notices. (The project's own code is permissively built on top — see
the npm/cargo manifests — and serving the GPL components below as separate works
does not place this project's own code under the GPL.)

## Emulators (served to the browser)

### EmulatorJS — GPL-3.0-or-later

- Version 4.2.3 · `apps/party/frontend/static/vendor/emulatorjs/`
- Source: <https://github.com/EmulatorJS/EmulatorJS> (vendored unmodified)
- Bundles libretro cores, each GPL-2.0-or-later:
  - **PUAE** (Amiga) — <https://github.com/libretro/libretro-uae>
  - **VICE x64sc** (C64) — <https://github.com/libretro/vice-libretro>
- Corresponding source = the upstream repositories above at the stated version.

### js-dos / DOSBox — GPL-2.0-or-later

- js-dos v8 · `apps/party/frontend/static/vendor/js-dos/`
- Source: <https://github.com/caiiiycuk/js-dos> (wraps DOSBox,
  <https://www.dosbox.com/>); vendored unmodified.
- Bundles two emulator cores, both GPL-2.0-or-later:
  - **DOSBox** (`emulators/wdosbox.*`) — the default core.
  - **DOSBox-X** (`emulators/wdosbox-x.*`) — used by demos that need a CPU DOSBox
    can't emulate (MMX and up) — <https://github.com/js-dos/dosbox-x>, the js-dos
    fork of <https://dosbox-x.com/>.
- Corresponding source = the upstream repositories above.

## Audio engine

### chiptune3 + libopenmpt

- chiptune3 0.8.7 (DrSnuggles) — **MIT** — <https://github.com/DrSnuggles/chiptune>
- libopenmpt — **BSD-3-Clause** — <https://lib.openmpt.org/>
- `apps/{party,tracker}/frontend/static/vendor/chiptune3/`,
  `packages/player/src/vendor/chiptune3.js`
- The wrapper is reworked for off-thread decoding (see the file header); the
  modified source lives in this repository. libopenmpt's BSD copyright notice is
  retained.

### libsidplayfp (C64 SID) — GPL-2.0-or-later

- Via `libsidplayfp-wasm` (npm) — <https://github.com/chrisgleissner/libsidplayfp-wasm>,
  an independent WebAssembly distribution of libsidplayfp
  (<https://github.com/libsidplayfp/libsidplayfp>) including reSIDfp.
- Bundled into the tracker SPA's SID decode worker; corresponding source is the
  upstream repository at the published version (the package also ships a
  `complete-source.tar.gz`).
- **C64 system ROMs are NOT included** — see below.

## Fonts

### Inter — SIL Open Font License 1.1

- Via `@fontsource-variable/inter` (npm) — <https://github.com/rsms/inter>

### TopazPlus (Amiga) — GPL with Font Exception

- `apps/{party,tracker}/frontend/static/fonts/TopazPlus_a1200_v1.0.ttf`
- Source: <https://github.com/rewtnull/amigafonts>
- The Font Exception permits embedding/serving without imposing the GPL on this
  project; the font itself remains under its license.

### WebPlus IBM VGA (CP437) — CC BY-SA 4.0

- `apps/party/frontend/static/fonts/WebPlus_IBM_VGA_8x16.woff`
- "The Ultimate Oldschool PC Font Pack" by VileR —
  <https://int10h.org/oldschool-pc-fonts/>
- Licensed <https://creativecommons.org/licenses/by-sa/4.0/>.

### C64 Pro Mono — Style's C64 TrueType license

- `apps/{party,tracker}/frontend/static/fonts/C64_Pro_Mono-STYLE.{woff,woff2}`
- "The Ultimate Commodore 64 Font" by Style — <https://style64.org/c64-truetype>
- Not a standard open license. The permission this project relies on:

  > You MAY: … embed this font and or its .eot and .woff variants without any
  > modification and using the same filenames they were provided with for
  > display on any web site using @font-face rules; … include this font without
  > any modification and using the same filenames they were provided with as
  > part of a software package but ONLY if said software package is freely
  > provided to end users.

  Both apply: this is a freely-provided package, and the font is served only
  through `@font-face`. The files are the archive's own, byte-for-byte and
  under their original names — **do not rename, subset or re-encode them**,
  which would forfeit both permissions. woff2 sits on the same footing: the
  archive ships it as a webfont variant, and the clause's `.eot`/`.woff`
  enumeration predates the format.
- Selling it, bundling it in a font collection, or offering it for direct
  download are all forbidden; any use beyond the above needs Style's permission.

## Deliberately NOT included

- **C64 system ROMs (KERNAL / BASIC / CHARGEN).** Not distributed with this
  project. Copyrighted by Commodore; the operator supplies them at runtime
  (`TRACKER_ROMS_DIR`, served via `/api/roms/*`) and they must never be committed
  or baked into any published image. Without them libsidplayfp falls back to
  built-in images — most tunes still play; BASIC-driven RSIDs do not.
- **Amiga Kickstart ROM.** Not distributed with this project. The Amiga emulator
  defaults to PUAE's bundled free **AROS** ROM. A real Kickstart (e.g. 3.1 /
  A1200) is copyrighted by Cloanto and must be supplied by the operator at
  runtime (`PARTY_SUPPORT_DIR`) — it must not be committed or baked into any
  published image.

## Archived content

Demoscene productions, music modules, and party material served by these apps
are the copyright of their respective authors and groups. They are not licensed
by this project and are served for archival/personal use.
