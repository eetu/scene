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
  clean filenames, one file per tune. An author appears under **several format
  dirs**; sweep them all. Enumerate the **live directory** — counts from memory or
  an agent under-report.
- **AMP** (Amiga Music Preservation) — `https://amp.dascene.net/`. Fallback for
  artists/tunes not on Modland. `detail.php?detail=modules&view=<id>` lists a
  composer's modules; `downmod.php?index=<N>` 302-redirects to a **gzipped** file
  (name in the redirect URL as `MOD. <title>.gz`; strip prefix + `.gz`, gunzip).
  Behind Cloudflare — see gotchas.
- **Demozoo** — `https://demozoo.org/`. Authority for **group rosters**
  (`/groups/<id>/`) and **identity** (`/sceners/<id>/`).
- **The module files themselves** — sample/instrument-name text often names the
  artist's group (see Workflow D). This is the strongest signal for the
  format-dir / CD-dump stragglers and needs no lookup.

## Workflow A — build a group's music (e.g. CNCD, Orange)

1. Roster from Demozoo `/groups/<id>/`; note the musicians.
2. Fetch each musician's Modland catalog across all format dirs into local staging
   (fast); AMP for anyone not on Modland.
3. Disambiguate identity (below) before trusting any author dir.
4. Dedup vs what's already there (md5 + normalized title); file survivors under
   `<Group>/<Musician>/`. `POST /api/rescan`.

## Workflow B — consolidate a scattered artist (e.g. Jogeir, Necros)

Prolific artists get split across many folders (by-format dirs + a top-level author
dir + several group dirs) with duplicated/renamed rips.

1. Find every location: `find /Volumes/mods -maxdepth 3 -type d -iname "<name>"`.
2. Pick the home group — the biggest/most notable group the artist is actually in
   (ask the user; Jogeir→Fairlight, Lizardking→Razor 1911, Bruno→Anarchy).
3. Pool all their files + their full Modland catalog; dedup by identity key
   `(normalized-title, format-ext)`, keeping ONE per key: prefer the clean Modland
   file, fall back to the user's file (name de-mangled) for tunes not on Modland.
   Cross-format variants (`.mod` + `.xm`) kept separately.
4. Verify zero loss (below) before deleting anything.
5. Place under `<HomeGroup>/<Artist>/`, remove the old locations, `POST /api/rescan`.

## Workflow C — clean CD-dump filenames

- Strip `~N` / `~N~N` suffixes; prefer the clean Modland name over an 8.3-truncated
  one when the tune matches (`CHZARDOM` → `chzardomene`).
- For a blank/truncated name with no Modland match, read the module's embedded
  **title** (MOD 20b@0, S3M 28b@0) and **sample/instrument text** (Workflow D).
- Lowercase all-caps DOS names; the mount is case-insensitive, so change case via a
  temp intermediate.

## Workflow D — deduce the group FROM THE MODULE (the killer technique)

Amiga/PC composers used the **sample/instrument-name slots as a text area** for
their handle, group, greetings and contact info. Reading that text names the group
directly — no Demozoo lookup. This is how ~240 format-dir/CD-dump stragglers were
placed.

- **Extract text**: MOD = 22-byte sample names (31 of them, from offset 20, 30
  bytes each) + 20-byte title. For XM/S3M/IT, a **`strings`-style sweep** (printable
  ASCII runs >=5 chars, keep ones with letters, dedup) captures module name +
  instrument + sample names + embedded messages in one go — works for every format.
- **Read the artist's OWN signature** — `X of GROUP`, `by X / GROUP`, `X/GROUP` —
  and IGNORE the *greetings* to other people's groups ("hello to ...", "greets to
  X/GROUP"). Those name other sceners, not the composer.
- **Text beats name-match**: a folder named `Jazz` whose files sign `jazz/hjb`
  belongs to Haujobb, not the "Jazz" group a bare name-match suggested.
- **Watch for mislabeled folders** — the content may be a *different* artist
  entirely (`Merge/` held Laxity/Kefrens tunes, `Prophet/` held Subject's,
  `Breeze/` held Megaman's). Relocate to the real artist, don't blind-move.
- **No signature? -> `_groupless`** (see below). Game/soundtrack composers (Richard
  Joseph, Barry Leitch, Karsten Obarski) and solo/netlabel chip artists legitimately
  have no demogroup.

Feed the extracted text to the LLM in batches; it reliably picks the own-group,
flags multi-group (pick the primary/biggest), and separates soloists.

## The `_groupless` bucket

Ungrouped artists live in `/Volumes/mods/_groupless/<artist>/`. It's a **non-dot
sentinel** on purpose: a `.`-prefixed name (`.groupless`) would be skipped by the
scanner (`scan.rs` `is_hidden_dir` drops any dir starting with `.`) and vanish from
the library. `_groupless` is indexed like a normal group, sorts near the top, and
the frontend renders it distinctly as "Ungrouped".

## Identity disambiguation (critical)

Handles are reused (Distance, Legend, Dune, Moby, Clawz, Jason, Soul, Pink...). Never
trust an author dir by name alone:

- Anchor to the exact person via their Demozoo scener ID, OR read the group from the
  module text (Workflow D — self-verifying), OR use overlap: if the user already
  owns files for them, their owned tunes being covered by the Modland set confirms
  it's the same person.
- Modland keeps ONE dir for the most prolific holder of a handle and suffixes
  others; a single plain dir is *probably* the famous one — say so, flag unproven
  ones (Moby = Frederic Motte was assumed).

## Dedup & clean-name rules

- Exact md5 duplicate -> drop the redundant copy (prefer cleaner name).
- Same normalized-title + same extension, different bytes -> keep one (cleaner name).
- Same title, different format -> keep both.
- **Never delete a unique original** — a tune present nowhere else. Those are the
  only irreplaceable bytes.
- Normalized title = lowercase, drop extension, drop `~N`, strip non-alphanumerics.

## Verify (before any deletion)

- **Coverage:** every file in a location you're about to remove must have its
  `(normalized-title, ext)` key OR its md5 present in the destination. Zero missing,
  or don't delete.
- **Validity:** module magic — MOD `M.K.`/`M!K!`/`FLT4`/`4CHN` @1080; S3M `SCRM` @44;
  XM `Extended Module:` @0; IT `IMPM` @0; OKT `OKTASONG` @0. Reject <100 bytes or
  content starting `<`/`error code`.

## Gotchas (this environment)

- **/Volumes/mods is a slow SMB mount.** Bulk hashing/copies/deletes exceed the
  2-min command budget — background them. `find | wc -l` is flaky; prefer `ls -1`.
  Case-insensitive (`orange` == `Orange`); rename case via a temp name.
- **`._` AppleDouble junk is a tsunami** — the mount regenerates it on every write,
  so purging is whack-a-mole. **Don't bother**: the scanner already ignores `._*`
  and `.DS_Store` (`scan.rs is_junk`). (`defaults write com.apple.desktopservices
  DSDontWriteNetworkStores -bool true` + a one-shot `dot_clean` if you ever want
  them gone at source.)
- **Slow-mount `rm` leaves stragglers.** After a batch place, a few source folders
  survive; re-list, coverage-verify, remove in a second pass.
- **AMP Cloudflare rate-limit (error 1015):** after ~14 rapid downloads the body is
  a 17-byte `error code: 1015`. Throttle (sleep 3-5s, backoff).
- **macOS bash is 3.2** — no `declare -A`; use a `case` helper.
- **Python `shutil.copy2` fails on SMB** (`copystat`/`chflags`); use `copyfile`.
  Copy staging files (don't `move`) so reruns are safe.
- **Destructive deletes are gated** by the harness safety classifier. Verify coverage
  (0-loss), show the removal list, get explicit confirmation — then delete (or have
  the user run `rm` via the `!` prefix).
- **Untracked files in this repo can vanish** on a branch switch by another session
  — commit docs like this one.

## Done so far (reference runs)

- **Groups built:** CNCD (759 files, 9 musicians), Orange (531, 10).
- **Artist consolidations:** Jogeir -> `Fairlight` (311, +Modland +AMP), Bruno ->
  `Anarchy` (69); batches: Necros->Five Musicians, Lizardking->Razor 1911,
  Skaven->Future Crew, Moby->Sanity, Chromag->Rebels, Audiomonster->Anarchy,
  Strobo->Stellar, Clawz->Oxygene, Basehead->Five Musicians, Supernao->Lemon,
  Paso->U.D.O, Gromour->Nordic Line, XTD->Mystic, Radix->The Black Lotus,
  Romeo Knight->TRSI, Mantronix->Fairlight, Deetsay->Orange, ...
- **Crud pass:** ~1,140 `._` purged (one-off), 218 empty dirs, `~N` names normalized
  (363 renamed, dup drops, variants kept).
- **`NA` -> `_groupless`** (~500 artists), shown as "Ungrouped" in the UI.
- **Format dirs fully dismantled** via Workflow D: `Protracker` (123),
  `Fasttracker 2` (69), `Impulsetracker` (16), `Screamtracker 3` (6),
  `Soundtracker` (2) all reigned into groups or `_groupless` and removed. The
  library is now purely `group/artist` + `_groupless` (~473 group folders,
  ~524 groupless). Notable: Purple Motion->Future Crew, Drax & Jeroen Tel->Maniacs
  of Noise, mislabeled folders relocated to the real artist.
