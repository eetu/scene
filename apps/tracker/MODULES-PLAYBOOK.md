# Modules playbook — adding to & curating the tracker collection

How to grow and tidy the module archive this app serves (`TRACKER_ROOT` = the
`mods` SMB mount, now under the `scene` share — dev `/Volumes/scene/mods`).
Counterpart to the party app's scrape:
where that ingests demoparty archives from scene.org, this ingests **tracker
modules** from the mod archives and de-messes old **CD-dump rips**.

## The model (read this first)

Two layers, deliberately separate:

- **The filesystem — one axis: the artist.** `TRACKER_ROOT/<artist>/<song.ext>`.
  A tune has exactly one home, under its (canonical) author. Unknown author →
  `_unknown/`. That's the whole on-disk structure — **no group level**.
- **`library.json` at the mount root — the relational graph.** Everything that
  isn't a single-artist fact: an artist's other handles (`aka`), the groups they
  were in (`groups`), named `albums` (ordered sets of song md5s), and per-song
  credits (`forGroup` / co-authors / `year`). **Group and album are facets built
  from this file, never directories** — a tune can be in many groups/albums, and
  a tree can't hold that; a graph can.

Why the split: the filesystem is a tree, but artist↔group↔alias↔album is a graph.
Encoding the graph in the path forced either duplicates (the md5 dupes we had) or
a lie (pick one group). Identity is the **content hash** — `/api/file/{hash}`, and
hash/md5-keyed `meta` / `stats` / playlists — so **moving files around is
lossless**: favourites, play counts, enrichment and playlist membership all follow
the bytes. Reorganising is a pure filing decision.

**Durability rule:** anything you can't recompute from the bytes must live in
`library.json` (aliases, groups, albums, credits). The SQLite DB is a cache — lose
it, rescan. Lose `library.json` and you lose the graph, so it lives on the mount
and is the thing to back up.

## Adding a module (the 30-second version)

1. Drop the file at `<artist>/<song.ext>` on the mount — clean name, keep a
   recognised module extension; unknown author → `_unknown/`. The **dedup guard**
   refuses a second copy of bytes already in the library.
2. **Rescan** — `POST /api/rescan` (or the UI button). Indexes new/changed files;
   an unchanged file reuses its cached hash (no re-read over SMB).
3. **Annotate** (optional) in `library.json` — the artist's `aka`/`groups`, an
   album, per-song credits — by hand or via the in-app editor, then
   **`POST /api/library/reload`** (cheap; no rescan/hashing). Group/album/alias
   views update immediately.

Rescan = "new bytes on disk" (walks + hashes). Reload = "edited the graph"
(re-reads one small JSON). They're independent — curating the graph never costs a
NAS walk.

## `library.json` format

```json
{
  "artists": {
    "4-Mat":         { "aka": ["Matt Simmonds"], "groups": ["Anarchy", "Rebels"] },
    "Purple Motion": { "groups": ["Future Crew"] }
  },
  "albums": {
    "second-reality-ost": { "title": "Second Reality — Soundtrack", "kind": "soundtrack",
                            "songs": ["ab12..f9", "cd34..a1"] }
  },
  "songs": { "ab12..f9": { "forGroup": "Future Crew", "with": ["Skaven"], "year": 1993 } }
}
```

- `artists` — key = the **canonical handle = the folder name**. `aka` folds
  alias-named folders into this artist in the browse view; `groups` inverts to a
  group→members facet. Handle lookups are case-insensitive.
- `albums` — slug → `{title, kind, songs:[md5]}`, ordered (an album is directly
  playable). `kind` is a free tag (`soundtrack`, `sfx`, `sid`, …).
- `songs` — **sparse**: only annotated tunes, keyed by md5. This is what keeps one
  file viable at thousands of modules. `md5` (not sha256) matches the playlist
  items and The Mod Archive.

## Curation surfaces

- **Hand-edit** `library.json` on the mount → `POST /api/library/reload`.
- **In-app editor** — artist `aka`/`groups`, per-track credits, album management;
  writes the manifest for you and reloads.
- **LLM** — produce or patch `library.json` directly (it's one legible file), or
  drive the curation API. Handing an LLM an artist folder + that artist's slice of
  the manifest is the clean way to say "dedupe this artist" / "check this
  artist's top-100".

## Playlists (separate from the filesystem)

Playlists are **DB-only and independent of the tree** — created/curated by an LLM
and imported through the API **one item at a time** (`POST /api/playlists` to
create, then `POST /api/playlists/{id}/items` per md5), or in bulk via
`POST /api/playlists/import`. They reference tunes by md5, so they survive moves.

Albums (in `library.json`) are the **durable, ships-with-the-archive** counterpart;
playlists are personal/ephemeral. Use an album for "belongs to the collection" (a
demo soundtrack, an SFX pack, a SID set); a playlist for a listening queue.

## Status / migration (2026-07)

Landing incrementally (plan: `~/.claude/plans/tracker-library-manifest.md`).
**Live now:** the manifest core (`library.json` load + `GET /api/manifest` +
`POST /api/library/reload`), the **curation write API** (artist / album / song
endpoints), the **manifest-driven facets** (browse by group / artist / album with
alias folding), the in-app **curation UI** (`CurateModal`), and the **offline
seeder** (below).

The physical **tree migration** to `artist/song` has run: the mount is
`<artist>/song.ext` and the backend is **artist-primary unconditionally** (no
layout switch). Groups / aliases / albums come from `library.json`, joined onto
the path-derived artist in the frontend.

### Seed `library.json` from a snapshot

`tracker-migrate` reads an `md5<TAB>size<TAB>relpath` snapshot of the collection
and writes a seeded `library.json` (+ `dupes.json` / `alias-candidates.json`)
**without touching the mount** — safe to run while the archive is being edited:

```
cargo run -p tracker-backend --bin tracker-migrate -- <md5-manifest.tsv> [out-dir]
```

It infers each artist's `groups[]` from the group segments their files sit under,
flags exact md5 duplicates (the dedup worklist) and **alias candidates** (identical
bytes under two artist folders → same person, two handles — review, don't
auto-merge). Apply by copying `library.seed.json` to `<TRACKER_ROOT>/library.json`
and `POST /api/library/reload` — **no file moves, no rescan**. (First real run:
8352 files → 608 artists / 480 groups, 67 multi-group artists, 22 exact-dupe sets,
3 alias candidates, 0 unknown-author.)

The physical `group/artist → artist` moves are the separate, gated step, run
against a **fresh** snapshot once the gap-filling session is done — **do not
hand-move the whole tree** meanwhile.

## Enriching the manifest (filling metadata)

Two kinds of metadata (per the durability rule): **derivable** (title / duration /
format / tracker / channels) → the DB cache; **asserted** (artist `aka` + group
memberships, per-song credits, albums) → `library.json`.

### Derivable — one click
Run **enrich-all** in the app (the "enrich N" button): it WASM-parses every
un-enriched module and POSTs `/api/meta`, filling titles/durations/format/channels
for the whole library. Do this first.

### Asserted — the `tracker-enrich` pipeline (`extract → LLM triage → merge`)
1. **Extract** the modules' own text — sample/instrument-name slots + messages,
   where sceners signed their handle / group / greets / year:
   ```
   cargo run -p tracker-backend --bin tracker-enrich -- extract /Volumes/scene/mods ~/tmp/enrich-corpus.jsonl
   ```
   (MOD family read by fixed offset = clean; other formats a printable-strings sweep.)
2. **Triage** (LLM, batched — a workflow over corpus chunks): read each artist's
   aggregated text and propose `groups`/`aka` **only from genuine self-attribution**
   ("X of GROUP", "X/GROUP", "members of GROUP"). **Drop greets** ("greetings to …"
   name OTHER people's groups — the #1 trap), song titles, sampled bands, real names.
   Verify each proposal. Emit `proposals.json` = `{artists:{name:{groups,aka}}}`.
3. **Merge** — dry-run → review → apply (back up `library.json` first):
   ```
   cargo run -p tracker-backend --bin tracker-enrich -- merge ~/tmp/proposals.json /Volumes/scene/mods/library.json          # dry-run
   cargo run -p tracker-backend --bin tracker-enrich -- merge ~/tmp/proposals.json /Volumes/scene/mods/library.json --write  # apply
   ```
   then `POST /api/library/reload` (no rescan). Merge is additive (unions
   groups/aka, never clobbers).

### External sources for the group-less tail
- **Demozoo** — keyless JSON API (`demozoo.org/api/v1/releasers/?name=<handle>` →
  detail `/releasers/<id>/` gives `member_of` groups + `nicks` aliases + years).
  Match is by handle and **handle-reuse is rampant** — disambiguate: prefer the
  candidate whose groups the module text corroborates, skip multi-candidate handles
  with no corroboration, drop real names from `nicks`. Fetch throttled + sequential
  (be a good API citizen).
- **The Mod Archive** — richer (year/genre/rating) but the XML API is **key-gated**
  and the keyless module page returns Cloudflare 503. Needs a modarchive.org API
  key; a by-md5 pass would then cover the whole collection.

### Done so far (2026-07)
enrich-all (titles/durations); text-triage workflow → **68 artists**; Demozoo
workflow → **100 artists** (+326 groups, +73 aka). Manifest ≈ 774 artists with
entries. ~340 remain group-less (no own-signature + no confident Demozoo match).
Per-song year/genre still unfilled (needs a TMA key). Backups + corpora +
proposals live in `~/tmp` (`library.before-*.json`, `enrich-corpus.jsonl`,
`proposals*.json`, `demozoo-candidates.jsonl`).

## Sourcing & cleaning techniques (unchanged)

Everything below is how to *find, disambiguate and clean* module bytes — still
exactly right. Only the **filing target** changed: where these say "file under
`<Group>/<Artist>/`", now file under **`<Artist>/`** and record the group in
`library.json` (`artists.<name>.groups`). Workflow D (reading the group out of a
module's sample text) is now how you fill `groups` / `aka`, not how you pick a
directory. Consolidating an artist's aliases (Workflow B) becomes an `aka` list
rather than a physical merge.

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

1. Find every location: `find /Volumes/scene/mods -maxdepth 3 -type d -iname "<name>"`.
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

## The `_groupless` / `_unknown` bucket

A **non-dot sentinel** on purpose: a `.`-prefixed name would be skipped by the
scanner (`scan.rs` `is_hidden_dir` drops any dir starting with `.`) and vanish from
the library. It's indexed like a normal folder, sorts near the top, and the
frontend renders it distinctly.

- **New (artist-primary) model:** unknown *author* → `_unknown/<song.ext>`. There
  is no "ungrouped" bucket, because groups aren't directories — an artist simply
  has no `groups` entry in `library.json`. (Game/soundtrack composers, solo/chip
  artists: no `groups`, and that's correct, not missing data.)
- **Legacy model (until migration):** ungrouped artists live in
  `/Volumes/scene/mods/_groupless/<artist>/`, shown as "Ungrouped". The migration folds
  `_groupless/<artist>/…` into `<artist>/…`.

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

- **/Volumes/scene/mods is a slow SMB mount.** Bulk hashing/copies/deletes exceed the
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
