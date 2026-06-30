# Adding a party from scene.org

This directory holds the checked-in per-party metadata configs (`<slug>.json`)
for the **party** app. This README is the runbook for turning a demoparty's
scene.org archive into a tree the backend can serve.

It was reconstructed by reverse-engineering the **Assembly '95** export (the
first party ingested), then hardened ingesting **Assembly '96**, **The
Gathering '96**, and **The Gathering '97** — each surfaced new edge cases now
folded in below (TG97, the sparsest tree yet, drove the demozoo-API recovery
recipe in Step 4½). Use `assembly95.json` / `assembly96.json` /
`gathering96.json` / `gathering97.json` + their live
`/Volumes/scene/parties/<Party>` trees as worked examples throughout; they
bracket most of the variation seen so far.

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

## How generic is this, really?

The **spine is universal**; the details are per-party. Treat the steps below as the
reliable backbone and budget for a handful of party-specific surprises each time.

- **Universal**: the pipeline (download → arrange → scan → serve), the folder
  grammar (`NN - Group - Title`, `rest/`, one- vs two-level compos), the config
  schema, the results-into-config join, the emulation/transcode-at-serve model.
- **Varies every party**: the compo set + folder names; the `results.txt` format
  (each party differs — *scrape, never parse at runtime*); which prods were actually
  archived vs. lost; the long unranked music/graphics tail; per-prod quirks (split
  executables, Amiga launch lines, a demo that needs sound setup).
- **Rules of thumb we keep relearning**: scene.org is often **incomplete** (winners
  missing entirely — Step 4½; TG97 was only **66/167** ranked entries on the mirror,
  demozoo got it to 121); the same prod sometimes lands in **both** a ranked
  folder and `rest/`, so it lists twice (Step 5, dedup); auto-naming the tail with
  an LLM is great but it **hallucinates** occasionally, so cross-check (Step 5); and
  emulation has **non-obvious runtime knobs** (Amiga fast RAM, PC GUS setup) that
  make a "correctly arranged" prod still fail — so actually **boot a few** before
  declaring victory (Step 7½).
- **Folder↔compo is not 1:1.** A single compo can be split across two scene.org
  dirs (TG97 stored one Graphics compo across `grfx/` **and** `grtc/`, with one pic
  duplicated in both) — merge them under one category key. And a dir's name lies:
  TG97's `grtc` is *not* raytrace (the raytrace compo had its own single entry,
  absent from the tree). Map dirs by their **contents vs the results**, not the name.
- **`results.txt` can omit whole compos.** TG97's file had no raytraced-graphics
  section at all — only demozoo revealed the compo existed. Always reconcile the
  compo *list* against demozoo, not just the placings (Step 4).
- **Ranks are the results' line order, ties included** — not points-deduped. Two
  entries on the same points each consume a rank (TG97 amiga #8/#9 both 220 pts).
  The `FILE_ID.DIZ` is the oracle: many state "Place 11th" / "#13 in the … compo",
  which catches off-by-one rank slips (Step 5).

When in doubt, diff the four worked examples (`assembly95.json`, `assembly96.json`,
`gathering96.json`, `gathering97.json`) — they bracket most of the variation seen
so far.

## Prerequisites

- A **downloader** that can mirror a subtree: `wget -r`, `lftp`, or `rsync`
  (mirror-dependent). Pick a fast mirror — see Step 1.
- **Archive extractors**: `unzip`, `lha` (LZH/LHA, common for Amiga), `unarj`.
  Older parties mix all three. On macOS only `unzip` is stock — `brew install lha`
  (`arj`/`unarj` from brew too); not having them silently skips those archives.
  **`.lzx` is a different format** — `lha` does **not** read it and fails *silently*
  (you get an empty folder, no error). There's no easy macOS tool (`brew` has none,
  `bsdtar`/`7z` don't grok Amiga LZX); either build `unlzx` from source or stage the
  raw `.lzx` as a download-only entry (TG97 wild #29 went this route).
- For Amiga AGA images (optional): **amitools** (`uv tool install amitools` →
  `xdftool`, `rdbtool` on your PATH; it is *not* a Homebrew formula) and a
  **Kickstart 3.1 (A1200)** ROM. See Step 6.
- For verifying emulation (Step 7½): a native **Amiga** emulator (`brew install
  fs-uae`) and **DOS** emulator (`brew install dosbox-x`; classic `dosbox` 0.74 is
  too old to fullscreen on recent macOS). These let you boot a prod with the *same*
  config the in-browser cores use and see/hear whether it actually runs — far faster
  than round-tripping through the SPA.
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

## Step 4½ — Recover entries scene.org is missing

**scene.org's party tree is frequently incomplete** — ranked *winners* can be
absent entirely (last-place entries especially, but not only). Once results are
scraped, the backend will synthesize disabled "not archived" rows for any ranked
entry with no folder (Step 7), which tells you exactly what's missing. Before
accepting those as lost, hunt the other archives:

- **demozoo** — the best source, and it has a **REST API** that makes recovery
  systematic (recipe below). Per-prod pages link to a download (often on
  `archive.scene.org/.../amigascne/`, aminet, modland, hornet, or a scene.org
  mirror). Prods with no link are usually tagged **`lost`** — that's authoritative,
  treat as gone.
- **pouët** — sometimes a mirror link demozoo lacks.
- **aminet** (`aminet.net`, Amiga), **Janeway/ExoticA** (Amiga; behind Cloudflare —
  needs a real browser).
- **Don't forget the tree you already pulled**: bundle/`rest` packs can contain a
  missing prod (and watch the reverse — a pack may only *duplicate* already-ranked
  prods, Step 5 dedup).

**The demozoo-API recipe (drives bulk recovery):**

1. `GET https://demozoo.org/api/v1/parties/<id>/` → `competitions[].results[]`, each
   with `position`, `score`, and a `production` (its demozoo `id`, title, author_nicks).
   This is also where you catch compos `results.txt` omitted (Step 4).
2. Match each *missing* `(category, rank)` to a production id by `position` (fall back
   to a normalized title compare). Map demozoo compo names → your category keys.
3. `GET …/api/v1/productions/<id>/` → `download_links[]`. **No links ⇒ lost** (don't
   fight it). Be polite: fetch serially or `xargs -P 4` — demozoo rate-limits and
   returns empty bodies under heavy parallelism (retry the blanks).
4. Download, **then place** into the right `NN - Group - Title` folder.

Download pitfalls that silently corrupt recovery (all hit on TG97):

- **`files.scene.org/view/…` is a landing page, not the file** — rewrite `/view/` →
  `/get/` for a direct download. Links often arrive already `%`-encoded (`%20`/`%27`)
  — **don't re-encode** them.
- **Validate it's the binary, not HTML.** A non-empty response is not success:
  `amp.dascene.net` links may be a `detail.php` page (HTML) rather than the module,
  and dead mirrors return a tiny 404 page. `file` the result; if it's HTML, try the
  *next* `download_link` (prods list several — modland/hornet were reliable fallbacks).
- **Modules come misnamed / gzipped** — a download saved as `downmod.php` was a
  gzipped `.xm`; `gunzip` + rename to the real extension or the scanner won't
  classify it as music.
- **Joiner packs** — one demozoo download can be a multi-pic pack shared by *several*
  graphics prods (TG97 linked Tjo Bing Beng, Hashrami and Nightowl to the same zip).
  Each prod's folder then gets *all* the images; keep only the matching one per folder
  (Step 5 dedup logic applies).

Stage downloads outside the live tree, **verify each is the right prod** (read its
`FILE_ID.DIZ`, or byte-compare if it claims to match an existing file — recovery
links do mislink), then drop into the proper `NN - Group - Title` folder.

TG96: **46** missing, **11** recovered, rest `lost`/Cloudflare-walled. TG97 worked
example (API-driven): **102** ranked entries missing from scene.org; **55**
recovered (music +24, graphics +11, fastintro +9, demo +3, …) bringing it to
**121/167**; of the rest, 45 were demozoo-`lost`, 1 had no demozoo record, 1 a dead
link — and **39 of those 47 are the Wild compo** (wild is chronically unarchived).
Don't expect a clean sweep — log what stays missing so the disabled rows are
understood, not mistaken for a bug.

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
- **Rank = the results' line order (ties consume a number each), not a points
  dedupe.** Number sequentially down the file even when points repeat. Sanity-check
  against `FILE_ID.DIZ`, which often states the placing outright ("Place 11th") — that
  caught two off-by-one slips on TG97 (Dalt was #10 not #12; Korean Fantasies #17 not
  #16) after a tie shifted everything below it.
- **When `results.txt` and the `.diz` disagree on group/title, the `.diz` usually
  wins** (it's the prod's own claim). TG97 results said Dual 4kb! was "tbl" and PGP
  "zimmerman??", but the dizzes said Subspace and TLS — use the diz, optionally
  confirm on demozoo.
- The `categories` keys are the folder paths (one or two segments). Folders not
  listed still get scanned — the backend falls back to heuristics in `scan.rs`
  (platform by file extension / folder name; medium by primary-file kind) — but
  listing them gives correct labels and the results join.
- **The order you list categories is the compo display order in the SPA** (`Info`
  and `Misc` are pinned first; unlisted folders fall to the end). Arrange the block
  to taste — e.g. intros before demos, or cluster the music compos together.
- **Name the unranked tail** (the `rest/` entries) via each category's optional
  `unranked` map (`{ "<folder-stem>": { "group": …, "title": … } }`), joined onto
  unranked productions so they read as names instead of cryptic archive stems.
  Populate it at scrape time: a regex over `FILE_ID.DIZ` is a cheap first pass, but
  the `.diz`/`.nfo` are wildly inconsistent (ANSI box-art, `X by Y` vs `composed
  by`, banners) — so prefer an **LLM pass** that reads each item's `.diz`/`.nfo`
  **and** the tracker module's embedded strings (`strings <mod> | head` — modules
  carry the song title + sample-row credits, cleaner than the BBS art), emitting
  `{group, title}` and **omitting rather than guessing** when a source is
  unreadable. Music compos especially need it.
- **De-duplicate ranked-vs-`rest`.** Ingests sometimes extract a winner into
  **both** its `NN - Group - Title` folder **and** a copy under `rest/`, so the SPA
  lists it twice (once ranked, once unranked). The backend does *not* dedupe these.
  Catch them with a title check, then **confirm by the files**: for every `unranked`
  entry whose title matches a *ranked* title in the same compo, compare bytes —
  same prod → delete the `rest/` copy **and** its `unranked` entry; different files →
  it's not a dup (a coincidence, or an LLM mislabel — next bullet). TG96 had three
  (`digestiv`/`jungle`/`eli_rygg`), asm96 one (`dccbagot`, byte-identical `.xm`).
- **LLM mislabels surface in the same check.** The naming pass can paste a *ranked*
  title onto a distinct unranked prod: asm95 `grfx/rosie` (`ROSIE.GIF`) was named
  "Wicked" — but that's the ranked #15 title (`wicked.iff`), a different picture.
  When the title matches a ranked entry but the **files differ**, it's a mislabel:
  fix the name (don't delete). A quick script comparing every `unranked` title to
  the compo's `results` titles is the cheapest way to flag both cases at once.
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

**First, the shortcut: if the prod already ships a disk image, you're done.** Some
Amiga prods arrive as `.dms` / `.adf` (a real floppy dump) rather than loose files —
drop that straight into the `NN - Group - Title` folder, no `.support/` build needed.
The scanner classifies `.dms`/`.adf`/`.hdf` as `diskimage` and the player boots it.
TG96's Black Lotus – Tint (six `tbl-tt0N.dms`) and the recovered D.U.M / Rap Demo
(`.dms`) work this way. Only build an image when the prod is **loose files**.

Identify the real executable first: Amiga executables are Hunk binaries — magic
`0x000003F3` (`head -c4 file | xxd`). Pick the prod's actual launcher (the one with a
`.info` icon, or the obvious name), **not** courier junk bundled by the upload group
(`dO-xTREME.exe`, `*.CLASS`, `GOT58CJJD.exe`-style garbled names) and not a
player/util. Watch for: **split executables** joined first
(`cat foo.ex1 foo.ex2 > foo.exe`); **fix releases** (`na!murr-fix.exe`) as the launch
target; a **launcher buried one level down** (TG97 Assfart's exe was in `assfart/`)
that you flatten up; and a **`dust_runme`-style boot script** — if the prod ships one,
its lines *are* your startup-sequence (TG97 Exit Planet Dust runs `tomate` then
`gurke`). **Preserve real data subdirs** (`data/`, the prod's own folders) — only
flatten a subdir that merely *wraps* the launcher, or you break the exe's relative
paths.

Verified `amitools` recipe (current amitools — `pack` works for ADF but its `size=`
errors on HDF geometry, so use explicit `create`/`format`/`write` for both):

```sh
# stage all the prod's files FLAT at the volume root + the launch command:
mkdir -p stage/s && cp -a "<prod>"/* stage/        # flatten any subdir into stage/
printf 'demo.exe\n' > stage/s/startup-sequence     # the exe you identified, by basename
img="Title (AGA).hdf"                              # .adf if the staged files fit ~830 KB
# size the image ~2× the data (min 2 MiB); a DD .adf needs no size=
xdftool -f "$img" create size=4Mi
xdftool "$img" format "NN - Group - Title" ofs     # OFS / DOS0, like the asm95 refs
xdftool "$img" boot install                        # standard bootblock → bootable
xdftool "$img" makedir s
xdftool "$img" write stage/s/startup-sequence s/startup-sequence
for f in stage/*; do [ -f "$f" ] && xdftool "$img" write "$f" "$(basename "$f")"; done
xdftool "$img" boot show | grep bootable           # sanity: "bootable: True"
```

Startup-sequence tips: a bare exe name at the volume root runs (AmigaDOS searches the
current dir). If the prod opens a library that ships alongside it (e.g.
`replayer.library`, `xpkmaster.library`), prepend `assign LIBS: SYS:` so
`OpenLibrary` finds it at the root. Put the built image in the prod's
`.support/<Title> (AGA).hdf` and leave the extracted originals in the folder (the
scanner prefers the `adf`/`hdf` as primary, so the demo launches while the raw files
stay browsable).

Two macOS traps when scripting the build:

- **Case-insensitive FS.** Flattening a subdir whose name case-insensitively matches a
  file inside it collides (TG97 `assfart/` dir vs the `aSSFARt` exe — `mv`/`cp`
  "already exists"). Rename the subdir to a temp name first, then move its contents up.
- **Leading-dot prod titles** (TG97 Contraz `.plong`) yield a hidden image filename
  `.plong (AGA).hdf`. The scanner indexes it fine, but globs (`ls *.hdf`) and any junk
  filter miss leading-dot files — check it survives `package-party-data`.

- A **Kickstart 3.1 (A1200)** ROM is required at
  `<PARTY_ROOT>/.support/kick40068.A1200` (512 KB, v40.068). It's copyrighted and
  **not bundled** — supply it yourself. The backend serves it via
  `/api/support/kick40068.A1200` (see `backend/src/routes.rs`); `.support` is a
  shared, unscanned dir (`PARTY_SUPPORT_DIR`, defaults to `<root>/.support`). Note a
  per-prod `.support/` (depth ≥ 2) *is* scanned — only the shared root one is not.

**Don't trust "it built" — boot it (Step 7½).** A bootable image still drops to an
AmigaDOS CLI or hangs if the launch line is wrong or the machine lacks RAM (see the
fast-RAM quirk in 7½). `fs-uae` confirms in seconds whether it reaches the demo.

## Step 7 — Index & verify

Point the backend at the tree and run it:

```sh
# apps/party/backend/.env  (see .env.example)
PARTY_ROOT="/Volumes/scene/parties"

just dev party        # backend (bacon) + frontend (vite) + transcoder sidecar
```

The backend scans on startup; trigger a re-scan after changes with
`POST /api/rescan` (non-kiosk instances only). Watch the startup log for the
join — `config results joined party=… updated=M` — `updated` is the number of
productions that got points; a surprisingly low number means the config `results`
aren't matching scanned productions (wrong `categories` key, or ranks that don't
line up with the `NN - …` folders).

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

## Step 7½ — Verify emulation (and the quirks that bite)

A prod can be arranged perfectly and still not run — emulation has runtime knobs
the filesystem can't express. **Actually boot a sample** of each platform before
shipping, using a native emulator configured like the in-browser core. This caught
every issue below; none were visible from the file tree.

```sh
# Amiga — fs-uae, mirroring the EJS puae A1200 config (note fast_memory!):
cat > t.fs-uae <<EOF
[fs-uae]
amiga_model = A1200
kickstart_file = /Volumes/scene/parties/.support/kick40068.A1200
fast_memory = 8192
hard_drive_0 = /path/to/.support/Title (AGA).hdf   # or floppy_drive_0 = …adf
fullscreen = 1
EOF
fs-uae t.fs-uae & sleep 18; screencapture -x shot.png; pkill -f fs-uae   # then look at shot.png

# PC — dosbox-x, mirroring the bundle's dosbox.conf (GUS + SB + env):
#   [gus] gus=true gusbase=240 irq1=5 dma1=3   [sblaster] sbbase=220 irq=7 dma=1
#   autoexec: set ULTRASND=240,3,3,5,5 / set BLASTER=A220 I7 D1 H5 P330 T6 / <exe>
dosbox-x -conf t.conf & sleep 16; screencapture -x shot.png; pkill -f dosbox
```

Capturing the window to a PNG and reading it back is the reliable way to tell
"reached the demo" from "dropped to a CLI / setup menu" without a human watching.

The quirks we hit (all now fixed in the app, but know them when a demo misbehaves):

- **A wild "demo" that's only a captured video showed no Play button.** `pick_primary`
  (`scan.rs`) resolved `medium: demo/intro` to runnable→diskimage→exe and stopped, so a
  wild entry shipping only an `.mpg` (TG97 #3 Firestarter) got *no* primary. Fixed:
  it now falls back to the largest video. Wild compos mix runnable prods and videos —
  expect both.
- **The DOS extender got picked as the primary exe.** Scanner takes the largest `.exe`;
  for a prod shipping `DOS4GW.EXE`/`CWSDPMI.EXE` alongside the real (smaller) demo exe,
  the extender won and the js-dos bundle ran a do-nothing stub (TG97 Textatic →
  `DOS4GW.EXE` instead of `DEMO5.EXE`). Fixed: `scan.rs` now excludes a denylist of
  known extenders/stubs from the exe slot.
- **Amiga demos need fast RAM.** EmulatorJS forces `puae_model=A1200` — whose preset
  is "2M Chip + **8M Fast**" — but it *also* writes the individual memory options at
  the core's default (fast = 0), and those **override the model preset**. Result: any
  sizable demo aborts the instant its loader runs —
  `<exe>: not enough memory available / failed returncode 10`, dropping to the CLI.
  Fix (in `frontend/src/lib/EjsEmulator.svelte`): force `puae_fastmem_size = "8"`.
  This is the #1 reason a freshly-imaged Amiga demo "doesn't start."
- **A few PC demos need sound setup — bake it, don't make users do it.** A demo that
  ships a `SETUP.EXE` writing a `SOUND.CFG` hardcodes the *author's* card settings
  (TG96 Inside: GUS at the original DMA 6 / IRQ 11). js-dos's GUS sits elsewhere
  (port 240 / DMA 3 / IRQ 5), so GUS init fails → silent (or the demo drops to its
  own sound menu). Fix: run the demo's setup once **against the bundle's GUS** (pick
  Gravis UltraSound) so it rewrites `SOUND.CFG` to the bundle's IRQ/DMA, and bake
  that file. It's **rare** — across all three parties only Inside has a `SETUP.EXE`;
  every other `.CFG` either auto-detects (MIDAS, IRQ/DMA = `ffffffff` sentinels) or
  uses the SoundBlaster defaults that already match. Scan for the pattern with
  `find <pc-compos> -iname setup.exe -o -iname '*.cfg'`.
- **js-dos caches bundles by URL.** The backend builds each `.jsdos` bundle *live
  from disk*, so a fresh fetch always has the current files — but the browser caches
  the zip. Change a bundled file (a corrected `SOUND.CFG`) and clients keep the stale
  one. Bump `BUNDLE_CONF_VERSION` in `frontend/src/lib/api.ts` to bust it.
- **Kiosk is immutable — fixes must be in the data, not in a user action.** The
  public/kiosk instance serves a read-only data image. A visitor running `SETUP.EXE`
  or changing an emulator setting only writes the *local* js-dos overlay /
  `localStorage` — per-browser, gone on reload and never seen by the next visitor.
  So every playability fix (corrected `SOUND.CFG`, AGA image, fast-RAM default) has
  to land in the baked files / app build + a cache-bump. "Just run setup" is not a
  fix here.

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
- **Results join is by `(category, rank)`** — a wrong `categories` key or a rank
  that doesn't match the `NN - …` folder silently drops that entry's points. Verify
  via the `updated=` log line (Step 7) and that ranks show in the UI after a rescan.
- **fish shell** — moving entry folders with hidden files trips the classic fish
  gotcha: an unmatched glob like `mv rest/x/.[!.]* dst/` *errors* instead of
  passing through. Wrap such one-liners in `bash -c '…'`, or use `cp -a`/`rsync`.
- **`unzip` hangs a script on junk filenames** — CP437 archives carry files with
  control-byte names that `unzip` can't create; it then *prompts* ("write error;
  Continue? y/n") and a non-interactive run blocks forever (or dies on EOF). Run it
  `</dev/null` and tolerate a non-zero exit; the junk file is unimportant.
- **`.lzx` ≠ `.lha`** — `lha` silently makes an empty folder for an LZX archive (no
  error). Stage the raw `.lzx` as download-only or build `unlzx` (Prerequisites).
- **A compo split across two dirs / a misnamed dir** — one Graphics compo can live in
  two scene.org folders (merge under one key); a `grtc`-named dir may not be raytrace.
  Map by contents-vs-results, and reconcile the compo *list* against demozoo (Step 4).
- **Double-listed prods** — a winner copied into both its ranked folder and `rest/`
  shows twice; the backend won't dedupe. Title-match + byte-compare, then drop the
  `rest/` copy + its `unranked` entry (Step 5).
- **Amiga demo "not enough memory" / returncode 10** — emulated A1200 has no fast
  RAM; it's the fast-RAM override quirk, fixed app-side (`puae_fastmem_size`, Step
  7½), not a bad image.
- **PC demo plays silent** — a `SETUP.EXE`/`SOUND.CFG` demo with the author's GUS
  settings; correct the config to the bundle's GUS and bake it (rare — Step 7½).
- **Kiosk doesn't reflect a fix** — the data image is immutable and user-side
  emulator actions don't persist; rebuild the image + bump the bundle version. Don't
  rely on a visitor running setup (Step 7½).
- **LLM-named tail can be wrong** — the auto-namer occasionally pastes a ranked
  title onto a different prod; cross-check unranked titles against `results` (Step 5).
- **Don't mount the live archive read-write in an emulator** — a DOS/Amiga setup
  tool will rewrite config files in place (it silently "fixed" a `SOUND.CFG` during
  testing). Test on a copy; only deliberately bake the result back.
