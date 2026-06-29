# Adding a party from scene.org

This directory holds the checked-in per-party metadata configs (`<slug>.json`)
for the **party** app. This README is the runbook for turning a demoparty's
scene.org archive into a tree the backend can serve.

It was reconstructed by reverse-engineering the **Assembly '95** export (the
first party ingested) — there was no written procedure, only the artifacts and
the backend that consumes them. Use `assembly95.json` + the live
`/Volumes/scene/parties/Assembly95` tree as the worked example throughout.

## Mental model

The pipeline has a clean split: **the filesystem is the source of truth**, and
everything else derives from it.

```
scene.org archive  →  a laid-out party tree  →  backend scans & indexes  →  SPA
   (download)          (extract + arrange)        (+ metadata JSON,           (play/view)
                                                    + results join,
                                                    transcode on demand)
```

- You produce a **party tree**: category folders of `NN - Group - Title` entries,
  plus a `results.txt`.
- You hand-author **`<slug>.json`** here to describe that tree (compo labels,
  platforms, mediums, results-section mapping).
- The backend (`apps/party/backend`) walks the tree, SHA256-hashes & classifies
  every file, groups files into productions, parses `results.txt`, and joins
  points. See `backend/src/{scan,party,results}.rs`.
- **Nothing is pre-transcoded.** Legacy graphics/animations are kept in their
  original formats and converted to PNG/MP4 **on demand** at serve time by the
  transcoder sidecar (`backend/src/transcoder.rs`).
- **Amiga (and C64) demos run in-browser** via EmulatorJS. Amiga prods boot from
  per-prod disk images under a `.support/` subdir; PC demos run via js-dos.

You only ever arrange files + write JSON. The backend does the rest.

## Prerequisites

- A **downloader** that can mirror a subtree: `wget -r`, `lftp`, or `rsync`
  (mirror-dependent). Pick a fast mirror — see Step 1.
- **Archive extractors**: `unzip`, `lha` (LZH/LHA, common for Amiga), `unarj`.
  Older parties mix all three. On macOS only `unzip` is stock — `brew install lha`
  (`arj`/`unarj` from brew too); not having them silently skips those archives.
- For Amiga AGA images (optional): **amitools** (`uv tool install amitools` →
  `xdftool`, `rdbtool` on your PATH; it is *not* a Homebrew formula) and a
  **Kickstart 3.1 (A1200)** ROM. See Step 6.
- macOS hygiene: the NAS/SMB volume sprinkles `._*` and `.DS_Store` files. Don't
  worry about them during ingest — `just package-party-data` strips them at the
  end, and the scanner skips dot-dirs.

Work in `/tmp` (or the scratch volume) while assembling; only the finished tree
lands under `PARTY_ROOT`.

## Step 1 — Pick a fast mirror and download to /tmp

Parties live on scene.org under `parties/<year>/<partyslug>/`. Browse the tree
first to learn the compo subdir names and grab `results.txt`:

```
https://files.scene.org/browse/parties/1995/assembly95/
```

**Pick the mirror deliberately — the default is often the slowest.** A bare
`files.scene.org/get/<path>` redirects to a mirror it chooses; in the Assembly '96
trial that was `archive.scene.org` at **0.23 MB/s**, while the German mirror ran at
**12 MB/s** (~50× faster). `files.scene.org` exposes a per-file mirror picker via a
`get:<cc>` prefix — scrape one file's `/view/` page to see the options:

```sh
curl -sL "https://files.scene.org/view/parties/1996/assembly96/demo/machines.zip" \
  | grep -oiE 'get:[a-z-]+'      # → get:de-https get:fi-https get:hu-https get:jp-https get:no-http get:pl-https get:us-http
```

Benchmark a representative ~10–20 MB file across the candidates and keep the
winner (de/hu/no were fastest here, fi/pl/us slow):

```sh
for m in de-https hu-https no-http us-http; do printf '%-10s ' "$m"
  curl -sL -o /dev/null --max-time 12 -w '%{speed_download} B/s\n' \
    "https://files.scene.org/get:$m/parties/1996/assembly96/anim/inout.zip"; done
```

For the bulk recursive pull you need a plain autoindex, not the `files.scene.org`
SPA. Resolve the winning `get:<cc>` once to find the mirror's real host, then
`wget -r` its directory tree. The German mirror, for example, resolves to
`mirror.netcologne.de/scene.org/` (note: `/scene.org/…`, not `/pub/…`):

```sh
cd /tmp
wget -r -np -nH --cut-dirs=4 -R 'index.html*' -e robots=off \
  https://mirror.netcologne.de/scene.org/parties/1996/assembly96/
# 695 files, 287 MB in ~30s @ 8 MB/s
```

`--cut-dirs=4` strips `scene.org/parties/<year>/<party>` so files land at
`demo/99.zip`, etc. A single recursive `wget` is **serial** — it will grind through
a fat compo (e.g. `anim/`, ~100 MB of video) before touching the rest; if your
mirror is slow, run one `wget` per compo in parallel (`xargs -P`) instead. Pick the
fast mirror and the serial pull is fine.

Result: a local copy of the compo subdirs, each full of per-prod archives (plus a
loose `<stem>.diz` FILE_ID for most).

## Step 2 — Lay out the category tree

The scanner derives a production's competition, platform, and medium from **where
its files sit**. Build this layout under a party folder named after the party
(e.g. `Assembly95/`):

- **One-level compo dirs** — e.g. `demo/`, `in64/`, `in4k/`, `m4ch/`, `mmul/`,
  `grfx/`, `grtc/`, `anim/`.
- **Two-level compo dirs** — `<platform>/<compo>/`, e.g. `amiga/demo/`,
  `amiga/in40/`, `c64/demo/`, `c64/graphics_music/`.
- **Non-compo extras** — `info/` and `misc/` (invitations, party diary, IRC log,
  voting sheets…). Indexed but unranked.
- **`results.txt`** at the party root.

Inside a compo dir, each **ranked entry** is a folder named:

```
NN - Group - Title
```

`NN` = the rank from `results.txt` (zero-padded), then ` - `, the group, ` - `,
the title. This is the `folder_name: "rank-group-title"` convention parsed in
`backend/src/scan.rs` (`parse_entry`). Examples from Assembly '95:

```
demo/01 - Nooon - Stars - Wonders of the world/
demo/07 - Orange - Television/
amiga/demo/01 - Parallax - ZIF/
```

Two more shapes the scanner understands:

- **`rest/`** — a subfolder inside a compo dir for entries that didn't place /
  aren't in the results (rank stays NULL). e.g. `in4k/rest/4kas95_3/…`.
- **Single-file entry** — a lone file dropped directly in the compo dir (no
  wrapper folder) is its own production; the stem is parsed for rank/group/title.
  e.g. `c64/graphics_music/Graphics_and_Music.D64`.

Worked example — the Assembly '95 category set (mirror in `assembly95.json`):

| Folder                 | Compo                 | Platform | Medium    |
| ---------------------- | --------------------- | -------- | --------- |
| `demo`                 | PC demo               | pc       | demo      |
| `in64`                 | PC 64K intro          | pc       | intro     |
| `in4k`                 | PC 4K intro           | pc       | intro     |
| `m4ch`                 | 4-channel music       | pc       | music     |
| `mmul`                 | Multichannel music    | pc       | music     |
| `grfx`                 | Graphics              | pc       | graphics  |
| `grtc`                 | Raytrace              | pc       | graphics  |
| `anim`                 | Animation             | video    | animation |
| `amiga/demo`           | Amiga demo            | amiga    | demo      |
| `amiga/in40`           | Amiga 40K intro       | amiga    | intro     |
| `c64/demo`             | C64 demo              | c64      | demo      |
| `c64/graphics_music`   | C64 graphics & music  | c64      | graphics  |

**The compo set changes year to year** — don't assume '95's. Mirror whatever the
scene.org tree actually has. Assembly '96, for instance, has `amiga/in64` (not
`in40`), splits C64 into `c64/demo` + `c64/grfx_music`, and lists a *Wild* compo in
the results that has **no folder on the server** (those prods were never archived).
`assembly96.json` is a second worked example — diff it against `assembly95.json`.

## Step 3 — Extract the archives

scene.org stores one archive per production. Unpack each into its
`NN - Group - Title` folder:

```sh
mkdir "demo/01 - Nooon - Stars - Wonders of the world"
unzip stars.zip   -d "demo/01 - Nooon - Stars - Wonders of the world"
lha  x hate2.lha                 # Amiga prods are usually LZH/LHA
unarj x foo.arj
```

Map archive → rank/group/title using `results.txt`, the archive's own
`FILE_ID.DIZ`/`.nfo` (which usually name the prod + group), and pouet/demozoo when
a filename is cryptic. Productions that aren't in the results go in `<compo>/rest/`.
Keep the original extracted file tree inside each entry folder — the scanner picks a
"primary" runnable/viewable file per production and serves the rest as downloads.
It's fine to leave the source archives behind in `rest/`.

A practical workflow for a big party: bulk-extract **every** archive into
`<compo>/rest/<stem>/` first, then promote the ranked ones by renaming
`rest/<stem>` → `<compo>/NN - Group - Title` (merging multi-archive prods — fixes,
multi-disk Amiga `.lha` sets — into one folder). What the trial ran into:

- **Some compos ship as one "pack", not per-prod.** Assembly '96 graphics, raytrace
  and C64 gfx/music arrive as a single zip holding *every* entry's image — there's
  no per-prod archive to split, so only the few that *were* uploaded individually
  get their own folder; the pack stays in `rest/`.
- **Music compos have a long unranked tail.** Only the top ~15 place; the other
  hundreds of `.mod`/`.xm`/`.s3m` entries (Assembly '96 `mmul` had 221) all go in
  `rest/` — don't hand-curate them, the scanner reads each module's metadata.
- **Title-less compos** (graphics/raytrace/music, where results give only an
  author) → name the folder `NN - Group` with **no** title. Heads-up: the
  `rank-group-title` parser then reads that single field as the *title* (group ends
  up empty in the UI). Harmless for ranking; a cosmetic wart to be aware of.
- **Apply fix/update releases FLAT, never in a `fix/` subfolder.** A bug-fix
  archive (a patched `.exe`, a multi-disk re-release) must overwrite the originals
  in the *same* folder. The scanner picks the **largest executable** as the
  production's primary, and the js-dos bundle is rooted at *that exe's directory* —
  so an exe in `fix/` orphans the data files (`.pak`/`.dat`) sitting in the parent,
  and the demo fails to find them at runtime. Merge multi-disk Amiga sets the same
  way (one folder per production).
- **Amiga `mod.<name>` modules need no renaming.** Modules that lead with the
  tracker type (`mod.song`, `med.foo`) instead of trailing it are classified as
  music automatically (`scan.rs`), and libopenmpt opens them by content.

## Step 4 — Keep results.txt as a document, scrape it into the config

Drop the party's `results.txt` at the party root (CP437 ASCII art — leave it). The
app does **not** parse it at runtime: every party tended to have its own format
(Assembly '95 `rank (NNN points) Group "Title"`; Assembly '96 a `Place Points S#
Name Author` table; The Gathering '96 letter-spaced titles with `rank … points`
rows), and a per-party runtime parser doesn't scale. Instead, the **placements are
scraped into the config** (Step 5) once, and `results.txt` stays only as a
browsable document.

So at scrape time, read `results.txt` (a throwaway script per format is fine) to
get each compo's `rank → points` (+ group/title where the format makes it clean),
and **cross-check against demozoo/pouët** — the original file is often partial
(The Gathering '96 omitted graphics/music and mangled the fastintro order; demozoo
had the full, correct list). Put the result into each category's `results` array.

## Step 5 — Author the party config (`.party.json`)

Each party folder carries its own config as **`.party.json`** at its root
(`<root>/Assembly95/.party.json`) — self-contained, so it travels with the data
and `package-party-data` bakes it into the image automatically; the scanner skips
it, so it never shows as a browsable file. Keep an editable copy under
`apps/party/parties/<slug>.json` in the repo and copy it into the folder. Fields
(structs: `PartyCfg` / `CategoryCfg` / `ResultRow` in `backend/src/party.rs`):

```jsonc
{
  "slug": "assembly95",
  "name": "Assembly '95",
  "year": 1995,
  "location": "Helsinki, Finland",
  "organizer": "Assembly Organizing",
  "logo": "info/logo.lbm",          // optional: rel path to a key image (transcoded on demand)
  "folder_name": "rank-group-title",
  "categories": {
    "demo": {
      "compo": "PC demo",                 // human label
      "platform": "pc",                   // pc | amiga | c64 | video | na
      "medium": "demo",                   // demo | intro | music | graphics | animation | info
      "results": [
        { "rank": 1, "points": 3646, "group": "Nooon", "title": "Stars : Wonders of the world" },
        { "rank": 2, "points": 1482, "group": "Juice", "title": "Psychic link" }
      ]
    }
    // …one entry per folder, incl. two-level keys like "amiga/demo"
  }
}
```

Key rules:

- **`results` is joined onto scanned productions by `(category, rank)`.** `points`
  is applied always (tie-safe — tied entries share points); `group`/`title` only
  when the rank is unique in the category, so a tie never stamps one entry's name
  onto the other. `group`/`title` are optional — without them the folder name
  (`NN - Group - Title`) supplies the display metadata.
- The `categories` keys are the folder paths (one or two segments). Folders not
  listed still get scanned — the backend falls back to heuristics in `scan.rs`
  (platform by file extension / folder name; medium by primary-file kind) — but
  listing them gives correct labels and the results join.
- **The order you list categories is the compo display order in the SPA** (`Info`
  and `Misc` are pinned first; unlisted folders fall to the end). Arrange the block
  to taste — e.g. intros before demos, or cluster the music compos together.
- Copy `assembly95.json` / `assembly96.json` as a starting template.

## Step 6 — Amiga AGA disk images (optional but recommended)

Amiga demos/intros don't run from loose files in the browser — they need a
bootable disk image. For each Amiga prod, build a **`(AGA)`-tagged** image and put
it in the prod's **`.support/`** subdir (the original extracted files stay
alongside for reference):

```
amiga/demo/01 - Parallax - ZIF/
  Zif_Parallax/              ← original extracted files
  .support/
    ZIF (AGA).hdf            ← bootable image the player loads
```

- **`.adf`** for prods that fit a DD floppy (≤ ~830 KB); **`.hdf`** for bigger ones.
- Both are a plain **OFS (`DOS0`) single volume** with a standard bootblock + an
  `s/startup-sequence` that runs the prod's executable(s) from the volume root, so
  it boots without Workbench. (The HDF is *not* RDB — just a bigger OFS image.)
- The **`(AGA)`** (or `(A1200)`) substring in the filename makes the libretro
  **PUAE** core auto-select the A1200/AGA model.

The validated `amitools` recipe (`xdftool pack` defaults to OFS and writes a
standard bootblock that's byte-identical to the asm95 reference images):

```sh
# stage the prod's files at the volume root + the launch command:
mkdir -p stage/s && cp -a "<prod>"/* stage/ && printf 'demo.exe\n' > stage/s/startup-sequence
# ADF (fits a floppy):
xdftool "Title (AGA).adf" pack stage      && xdftool "Title (AGA).adf" boot install
# HDF (bigger — size via the `size=` keyword; a positional size errors on geometry):
xdftool "Title (AGA).hdf" pack stage size=5Mi && xdftool "Title (AGA).hdf" boot install
```

`scratchpad/build-amiga-image.sh` from the asm96 trial wraps exactly this (auto
ADF-vs-HDF by content size, `.support/` placement, `(AGA)` naming). Per-prod
gotchas it hit: **split executables** must be joined first (`cat Mindabuse.ex1
Mindabuse.ex2 > Mindabuse.exe`, same for `bold1`+`bold2`); **courier junk** bundled
by the upload group (`dO-xTREME.exe`, `*.CLASS`) is *not* the prod — point the
startup line at the real exe; **fix releases** (`na!murr-fix.exe`) are the version
to launch.

- A **Kickstart 3.1 (A1200)** ROM is required at
  `<PARTY_ROOT>/.support/kick40068.A1200` (512 KB, v40.068). It's copyrighted and
  **not bundled** — supply it yourself. The backend serves it via
  `/api/support/kick40068.A1200` (see `backend/src/routes.rs`); `.support` is a
  shared, unscanned dir (`PARTY_SUPPORT_DIR`, defaults to `<root>/.support`).

This is **best-effort** — images boot in the scanner sense (each becomes the prod's
`primary_kind: diskimage`) but aren't verified in PUAE here; script-driven prods may
need the launch line tweaked. See `Assembly95/amiga/AGA-images-README.md` in the
export for additional per-prod caveats.

## Step 7 — Index & verify

Point the backend at the tree and run it:

```sh
# apps/party/backend/.env  (see .env.example)
PARTY_ROOT="/Volumes/scene/parties"

just dev party        # backend (bacon) + frontend (vite) + transcoder sidecar
```

The backend scans on startup; trigger a re-scan after changes with
`POST /api/rescan` (non-kiosk instances only). Watch the startup log for the
join — `results joined party=… sections=N updated=M` — `updated` is the number of
productions that got points; `0` means a `results_format`/`results_title` mismatch.

For a quick headless check (no SPA needed) run the backend straight at a scratch
tree and hit the API:

```sh
cd apps/party/backend
PARTY_ROOT=/path/to/scratch/parties PARTY_OPEN=1 PARTY_BIND=127.0.0.1:3099 \
  cargo run -p party-backend
curl -s localhost:3099/api/parties                       # party shows, n_productions sane
curl -s localhost:3099/api/parties/<slug>/productions    # ranks + points + group/title
```

If you point `STATIC_DIR` at a built `dist/` and browse the backend directly, note
the backend hashes `index.html`'s inline bootstrap script into the CSP **once at
startup**. Rebuild the frontend → the hash goes stale → the SPA dies with a CSP
`script-src` refusal. Fix: **restart the backend** after any frontend rebuild. (The
normal `just dev party` flow avoids this — vite serves the SPA, not the backend.)

Then browse the SPA (`just dev party`) and confirm:

- Each compo lists its productions, in rank order, with points from `results.txt`.
- PC demos launch (js-dos); Amiga/C64 demos boot (EmulatorJS) — Kickstart present
  and AGA images built (Step 6); without them Amiga entries only offer a download.
- Graphics and animations render (the transcoder must be configured —
  `PARTY_TRANSCODER_URL` — or image/video assets fall back to download).
- `info/` and `misc/` extras appear.

## Step 8 — Package & deploy

Bake the finished tree into an immutable data image:

```sh
just package-party-data /Volumes/scene/parties Assembly95 1995
```

This rsyncs the party folder (stripping macOS junk + caches), normalizes perms,
and builds/pushes `ghcr.io/eetu/scene-party-data-assembly95:1995` as a
`FROM scratch` + `COPY` image. The kiosk/public party instance mounts this; the
tree never changes there, so rescan is disabled. (See `justfile`,
`package-party-data`.)

## Gotchas

- **macOS junk** — `._*` / `.DS_Store` from SMB shares. The scanner skips
  dot-dirs; `package-party-data` excludes them. Don't commit them into the tree.
- **Permissions** — the backend runs as a non-root UID. The NAS source is often
  `drwx------`/`-rwx------` (root-only); `package-party-data` chmods to
  `0755`/`0644` so the binary can read the archive (otherwise it indexes 0 files).
  If running directly off the NAS in dev, make sure your user can traverse it.
- **CP437** — results files and many `.nfo`/`FILE_ID.DIZ` are CP437, not UTF-8.
  Leave them; the backend handles the encoding.
- **Transcoder required for visuals** — without `PARTY_TRANSCODER_URL`, graphics
  and animations only offer a download link. Nothing is pre-converted.
- **Kickstart not bundled** — Amiga emulation needs `kick40068.A1200` in
  `.support/`, supplied separately (copyrighted).
- **`results_title` mismatches** silently drop the points join — verify ranks
  show up in the UI after a rescan (or via the `updated=` log line in Step 7).
- **fish shell** — moving entry folders with hidden files trips the classic fish
  gotcha: an unmatched glob like `mv rest/x/.[!.]* dst/` *errors* instead of
  passing through. Wrap such one-liners in `bash -c '…'`, or use `cp -a`/`rsync`.
