# Modules playbook — scraping & cleaning the tracker collection

How to grow and tidy the module archive that this app serves (`TRACKER_ROOT`,
i.e. the `mods` NAS at `/Volumes/mods`). Counterpart to the party app's scrape:
where that ingests demoparty archives from scene.org, this ingests **tracker
modules** from the mod archives and de-messes old **CD-dump rips**.

**Filesystem is the source of truth** (see `CLAUDE.md`): `group/artist/song.ext`.
The whole job is getting the right bytes into the right `group/artist/` folder
under a clean name, then `POST /api/rescan` (the DB is just a cache). Everything
below is done with ordinary file tools; nothing here needs the backend running.

## Sources (in priority order)

- **Modland** — `https://ftp.modland.com/pub/modules/<Format>/<Author>/`. Canonical,
  clean filenames, one file per tune. This is the archive our own `/Volumes/mods`
  `Protracker/`, `Fasttracker 2/`, `Screamtracker 3/`, `Impulsetracker/`, `Fm/`,
  `Soundtracker/` folders came from — they are a curated subset of Modland's
  format/author tree. An author appears under **several format dirs**; sweep them
  all. Enumerate the **live directory** — don't trust counts from memory or an
  agent, they under-report.
- **AMP** (Amiga Music Preservation) — `https://amp.dascene.net/`. Fallback for
  artists/tunes not on Modland. `detail.php?detail=modules&view=<id>` lists a
  composer's modules; `downmod.php?index=<N>` 302-redirects to a **gzipped** file
  (name is in the redirect URL as `MOD. <title>.gz`; strip the `MOD.`/`XM.`…
  prefix + `.gz`, then gunzip). Behind Cloudflare — see gotchas.
- **Demozoo** — `https://demozoo.org/`. Not a file source; the authority for
  **group rosters** (`/groups/<id>/`) and **identity** (`/sceners/<id>/`). Start
  here for both "build a group" and "which person is this handle".
- **CD-archive dumps** — the pre-existing rips already in the collection (DOS-era
  CD dumps). Treat their *bytes* as data to keep, their *filenames* as junk to
  fix (see cleanup rules).

## Workflow A — build a group's music (e.g. CNCD, Orange)

1. **Roster** from Demozoo `/groups/<id>/`; note which members are musicians.
2. For each musician, **fetch their Modland catalog** across all format dirs
   into a local staging dir (fast); use AMP for anyone not on Modland.
3. **Disambiguate identity** (below) before trusting any author dir.
4. **Dedup vs what's already there** (md5 + normalized title), then file survivors
   under `<Group>/<Musician>/`.
5. `POST /api/rescan`.

## Workflow B — consolidate a scattered artist (e.g. Jogeir, Necros)

Prolific artists end up split across many folders (by-format dirs + a top-level
author dir + several group dirs) with duplicated/renamed rips. The `NA/` folder
holds "out of group" artists (e.g. Bruno was there).

1. **Find every location:** `find /Volumes/mods -maxdepth 3 -type d -iname "<name>"`.
2. **Pick the home group** — the biggest/most notable group *the artist is actually
   in* (ask the user; e.g. Jogeir→Fairlight, Lizardking→Razor 1911, Bruno→Anarchy).
   Prefer a group folder that already exists over inventing one.
3. **Pool** all their files + their full Modland catalog; **dedup by identity key
   `(normalized-title, format-ext)`**, keeping ONE per key: prefer the clean
   Modland file; fall back to the user's file (name de-mangled) for tunes not on
   Modland. Cross-format variants (`.mod` + `.xm` of one tune) are kept separately.
4. **Verify zero loss** (below) — every source file must be represented in the
   consolidated set — **before deleting anything**.
5. Place the consolidated set under `<HomeGroup>/<Artist>/`, remove the old
   scattered locations, `POST /api/rescan`.

## Workflow C — clean CD-dump filenames

- Strip `~N` / `~N~N` suffixes (`allnite groove~1.mod` → `allnite groove.mod`).
- Prefer the **clean Modland name** over an 8.3-truncated one when the tune matches
  (`CHZARDOM` → `chzardomene`); the mangled original is redundant, not a variant.
- For a blank/truncated name with no Modland match, try the module's **embedded
  title** (MOD: 20 bytes @ offset 0; S3M: 28 bytes @ 0) and **sample-name text**
  (MOD: 22-byte names from offset 20, 30 bytes/sample) — often reveals title/author.
- Lowercase all-caps DOS names to match the collection style; the mount is
  case-insensitive, so change case via a temp intermediate.
- In-app alternative: the list view's inline rename (`POST /api/rename`) does the
  same move safely (refuses overwrite, keeps the extension so it stays indexed).

## Identity disambiguation (critical)

Handles are reused across the scene (Distance, Legend, Dean, Dune, Moby, Carebear,
Clawz, Paso, Strobo…). Never trust an author dir by name alone:

- **Anchor to the exact person** via their Demozoo scener ID.
- **Confirm the Modland author dir is them** by cross-checking a few distinctive
  Demozoo track titles against the dir listing — or, if the user already owns
  files for them, the overlap itself confirms it (their owned tunes covered by the
  Modland set = same person).
- Modland usually keeps ONE dir for the most prolific holder of a handle and
  suffixes the others; a single plain dir is *probably* the famous one, but say so
  and flag any you couldn't prove (e.g. Moby = Frédéric Motte was assumed).

## Dedup & clean-name rules

- **Exact md5 duplicate** → drop the redundant copy (prefer the cleaner name).
- **Same normalized-title + same extension**, different bytes → keep one (cleaner
  name); safe when at least one side is a fetched copy.
- **Same title, different format** → keep both.
- **Never delete a unique original** — a tune present nowhere else (not on Modland/
  AMP). Those are the only irreplaceable bytes. Purging `._*`/`.DS_Store` is always
  fine.
- Normalized title = lowercase, drop extension, drop `~N`, strip non-alphanumerics.

## Verify (before any deletion)

- **Coverage:** for every file in the locations you're about to remove, assert its
  `(normalized-title, ext)` key **or** its md5 is present in the destination. Zero
  missing, or don't delete.
- **Validity:** module magic — MOD `M.K.`/`M!K!`/`FLT4`/`4CHN`… at byte 1080; S3M
  `SCRM` @ 44; XM `Extended Module:` @ 0; IT `IMPM` @ 0; OKT `OKTASONG` @ 0. Reject
  anything < 100 bytes or starting `<`/`error code` (HTML error / rate-limit body).

## Gotchas (this environment)

- **/Volumes/mods is a slow SMB mount.** Bulk hashing/copies/deletes exceed the
  2-min command budget — run them in the background. It spawns `._*` AppleDouble
  sidecars for everything written (purge with `find <root> -name '._*' -delete`).
  `find | wc -l` gives flaky/doubled counts here — prefer `ls -1`. Case-insensitive
  (`orange` == `Orange`); rename case via a temp name.
- **Slow-mount `rm` leaves stragglers.** After a batch place, a few source folders
  survive the delete. Re-list locations, coverage-verify the survivors, remove them
  in a second pass.
- **AMP is behind Cloudflare rate limiting (error 1015).** After ~14 rapid
  downloads the body becomes a 17-byte `error code: 1015`. Throttle (sleep 3-5s,
  retry with backoff).
- **macOS default bash is 3.2** — no `declare -A` (associative arrays); use a
  `case` helper instead.
- **Python `shutil.copy2` fails on the SMB mount** (`copystat`/`chflags`
  → "Operation not permitted"); use `shutil.copyfile` (bytes only). Copy user
  files (don't `move`) so staging stays intact and reruns are safe.
- **Destructive deletes are gated** by the harness safety classifier and won't run
  on a general instruction. Verify coverage (0-loss) first, show the exact
  removal list, get explicit confirmation — then delete (or have the user run the
  `rm` via the `!` prefix). Removing coverage-verified originals is expected here;
  the user prefers clean Modland copies over their DOS-dump rips.
- **Untracked files in this repo can vanish.** A `MODULES-PLAYBOOK.md` written here
  disappeared once (a git-clean hook or dev process removes untracked files) —
  after writing, verify it persists, and consider `git add` it.

## After any change

`POST /api/rescan` (or restart — boot scans only when the cache is empty). Content
hashing is reused when `(rel_path, size, mtime)` is unchanged, so a rescan after a
tidy is cheap; `meta`/`stats`/playlist links follow files by md5 across the moves.

## Done so far (reference runs)

- **Groups:** CNCD (759 files, 9 musicians), Orange (531, 10).
- **Consolidations:** Jogeir Liljedahl → `Fairlight/Jogeir Liljedahl` (311; 6
  locations merged, +Modland +AMP). Bruno → `Anarchy/Bruno` (69).
- **Batch 1 → single homes:** Necros→`Five Musicians` (109), Lizardking→`Razor 1911`
  (291), Skaven→`Future Crew` (78), Moby→`Sanity` (181), Chromag→`Rebels` (260).
- **Batch 2:** Audiomonster→`Anarchy` (97), Strobo→`Stellar` (338),
  Clawz→`Oxygene` (161), Basehead→`Five Musicians` (145), Supernao→`Lemon` (143),
  Paso→`U.D.O` (32), Gromour→`Nordic Line` (20).
