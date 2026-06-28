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
- Corresponding source = the upstream repository.

## Audio engine

### chiptune3 + libopenmpt

- chiptune3 0.8.7 (DrSnuggles) — **MIT** — <https://github.com/DrSnuggles/chiptune>
- libopenmpt — **BSD-3-Clause** — <https://lib.openmpt.org/>
- `apps/{party,tracker}/frontend/static/vendor/chiptune3/`,
  `packages/player/src/vendor/chiptune3.js`
- The wrapper is reworked for off-thread decoding (see the file header); the
  modified source lives in this repository. libopenmpt's BSD copyright notice is
  retained.

## Fonts

### Inter — SIL Open Font License 1.1

- Via `@fontsource-variable/inter` (npm) — <https://github.com/rsms/inter>

### TopazPlus (Amiga) — GPL with Font Exception

- `apps/{party,tracker}/frontend/static/fonts/TopazPlus_a1200_v1.0.ttf`
- Source: <https://github.com/rewtnull/amigafonts>
- The Font Exception permits embedding/serving without imposing the GPL on this
  project; the font itself remains under its license.

### WebPlus IBM VGA (CP437) — CC BY-SA 4.0

- `apps/{party,tracker}/frontend/static/fonts/WebPlus_IBM_VGA_8x16.woff`
- "The Ultimate Oldschool PC Font Pack" by VileR —
  <https://int10h.org/oldschool-pc-fonts/>
- Licensed <https://creativecommons.org/licenses/by-sa/4.0/>.

## Deliberately NOT included

- **Amiga Kickstart ROM.** Not distributed with this project. The Amiga emulator
  defaults to PUAE's bundled free **AROS** ROM. A real Kickstart (e.g. 3.1 /
  A1200) is copyrighted by Cloanto and must be supplied by the operator at
  runtime (`PARTY_SUPPORT_DIR`) — it must not be committed or baked into any
  published image.

## Archived content

Demoscene productions, music modules, and party material served by these apps
are the copyright of their respective authors and groups. They are not licensed
by this project and are served for archival/personal use.
