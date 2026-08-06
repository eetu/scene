# tracker — repo overview

FastTracker 2-style player for a filesystem tracker-module collection. Browse
~3500 modules by group/artist/format and play them (MOD/XM/S3M/IT + the obscure
legacy zoo) via libopenmpt WASM, with a pixel-perfect FT2 UI. Sibling in eetu's
homebrew family ([represent](../represent), [scribe](../scribe),
[halo](../halo)) — Rust(axum) + SvelteKit, halo-design.

## Layout

```
backend/    Rust axum 0.8 — indexes TRACKER_ROOTS, SQLite cache, serves bytes + SPA
frontend/   Svelte 5 + SvelteKit (adapter-static) — library browser + (todo) FT2 UI
integration/ spawned-binary integration tests (temp root + SQLite, real HTTP)
```

Cargo workspace = `backend` + `integration`.

## Conventions

- **Multiple collection roots.** `TRACKER_ROOTS=id:kind:path[,…]` declares named
  roots; `TRACKER_ROOT` remains sugar for a single `mods` root. `kind` is `scan`
  (walk + hash — the module pipeline) or `hvsc` (the High Voltage SID Collection,
  indexed from its own `DOCUMENTS/Songlengths.md5` rather than a filesystem walk;
  read-only, so rename/delete are refused). Index identity is **`(root_id,
  rel_path)`** — the same relative path can exist in two roots — plus a stable
  surrogate `files.id` that is the API's track id. Every filesystem access
  resolves against *the row's own* root (`resolve_in_root`), never a default: a
  row whose root left the config resolves to nothing rather than being
  reinterpreted against another tree. The first declared root is primary — it
  owns `library.json` and receives Modland fetches. `POST /api/rescan/{root}`
  scans one root; `/api/rescan` is the primary. `/status` lists the roots.
- **SID is indexed, and a subtune is a track.** `.sid`/`.psid`/`.rsid` go through
  the ordinary scan, but their metadata is parsed **in Rust** from the PSID/RSID
  header (`sid.rs`) — no decoder needed, so SIDs never touch the browser's
  libopenmpt enrichment path (which at HVSC scale would mean handing 61k
  unreadable files to a WASM decoder). The header comes free: `hash_file` returns
  the first 124 bytes alongside the digests, so there's no second open, and only
  a file that was actually (re)hashed is re-parsed.
  A SID holds 1..256 subtunes and **each is its own library entry** — its own id,
  favourite, play count and queue slot. `songs` holds one row per subtune (keyed
  by content hash, like `meta`/`stats`, so it follows a move); `stats` gained
  `subsong` in its primary key; and a track id folds the subtune in
  (`library::track_id` = `files.id * 256 + subsong`), so one integer names one
  playable thing. Rows show `Tune 3/12` so twelve entries aren't twelve identical
  lines. `parse` is validated against **all 61,157 HVSC #85 tunes**, cross-checked
  against `Songlengths.md5`'s independently-authored subtune counts
  (`sid::tests::agrees_with_hvsc`, `#[ignore]`d — needs `HVSC_DIR`).
  **A `.sid` without a SID header is not indexed.** Collections that passed
  through sidplay v1 contain `SIDPLAY INFOFILE` files: plain text describing a
  *separate* C64 binary (`ADDRESS=`, `SONGS=`, `NAME=`…), carrying no tune data,
  and usually orphaned from the data file they described. There's nothing any
  engine can play, so the scanner skips them with a log line rather than
  indexing a row that can only fail. The decoder also reports a load failure
  properly, so a corrupt or unrecognised file surfaces as the transport's error
  state instead of an unhandled promise rejection.
  **Song length is honest.** A SID header carries no duration, so a scanned SID's
  `duration` stays **null** and the listing shows nothing rather than claiming
  every SID is three minutes. Playback falls back to `TRACKER_SID_DEFAULT_LENGTH`
  (180s, the sidplayfp convention) via the host's `playLength` hook, so the
  transport and auto-advance have a window. You establish the real length by
  listening — the player view's timer button stores the current position via
  `POST /api/song-length/{hash}` into `songs.duration`, the same column an HVSC
  index fills from Songlengths, so both sources agree.
- **SID plays through the same pipeline, on a second decoder.** No custom WASM
  build: `libsidplayfp-wasm` (npm, GPL-2.0-or-later, **residfp** artifact for the
  cycle-accurate 6581/8580 filters) already exposes everything needed —
  `getSidStatus()` for the 32 chip registers, per-voice `mute()`, cycle-stamped
  register write traces, `getCia1TimerA()`, `selectSong()`. The plan's
  from-source emscripten build was based on a wrong premise and was dropped.
  The **worklet is format-agnostic** — it drains `{frames, left, right, pos, …}`
  chunks and knows nothing about libopenmpt — so SID reuses the whole hand-tuned
  pipe (credit-based flow control, jitter buffer, underrun/drift telemetry) and
  only the decoder differs: `src/sid/sid.worker.ts` speaks the same protocol.
  It's *bundled* TypeScript, not a vendored static asset (it has an npm import),
  hence `chiptune3.js` taking a `workerFactory` alongside `workerUrl`.
  `createEngine(cfg, kind)` picks the decoder from the track's extension and
  `ensurePlayer` rebuilds the graph when the queue crosses formats. The subtune
  travels **with** the load so opening a tune can't race selecting its subtune.
  C64 ROMs are served from `TRACKER_ROMS_DIR` via `GET /api/roms/{kernal|basic|
  chargen}` — a fixed allowlist matched by filename prefix (any KERNAL revision
  works) with a size check, since a wrong-sized ROM would otherwise emulate
  subtly wrong rather than fail. Unconfigured is a supported, degraded state:
  libsidplayfp falls back to built-in images and most tunes still play, but a
  BASIC-driven RSID goes near-silent (measured peak 5732 → 817).
- **The SID player pane is the voice monitor, not a pattern grid.** With
  `hasPatterns` false the pattern/samples tabs are replaced by **voices**
  (`VoiceMonitor.svelte`): per voice the oscillator (frequency + note, pulse
  width), waveform select as lamps (combined waveforms are a real technique, so
  they're flags not a choice), gate/sync/ring/test, the ADSR envelope as four
  bars, filter routing and the VU level — plus per-chip cutoff, resonance, filter
  modes and master volume. It's read from the **live chip registers**, which ride
  the same audio-synced relay as position and VU (`ProgressMsg.regs` →
  `playback.sidRegs`), so it matches what you hear rather than what was decoded.
  Decoding lives in `sid/registers.ts` — pure, unit-tested, and the only place
  that knows the register layout.
  **Beat comes from onset detection** for SID: there are no rows to count, and
  the chip's ~50Hz interrupt is a *tick* rate, not a musical beat. `BeatTracker`
  gained `energy()`, an adaptive bass-band onset detector with a refractory
  window (SID levels vary hugely between tunes, and without the window a drum's
  decay retriggers and the visualisers strobe). `playback.vu` needs no
  substitute — the SID worker derives per-voice levels from the same registers.
- **HVSC indexes itself, and is never modified.** An `hvsc` root is built from
  the collection's own `DOCUMENTS/Songlengths.md5` (`hvsc.rs`): one ~5 MB read
  yields every tune's path, content MD5 and per-subtune length — **61,157 tunes
  / 87,868 subtunes in well under a second**, with no walk, no stat and no
  hashing. The published MD5 becomes the row's `content_hash` (that column is
  just "the key content-addressed metadata hangs off"; 32 hex chars vs a
  scanned file's 64, so they can't collide). The tree is only ever *read*, so it
  can be a read-only mount or image — an integration test snapshots the whole
  directory and asserts indexing changed nothing.
  Everything learned about a release lives in `hvsc_state` (version, tune
  counts, and a size+mtime stamp of the songlengths file). That stamp makes the
  boot check one stat: unchanged → nothing happens; a newly mounted release →
  reindexed automatically. `POST /api/rescan/{root}` on an HVSC root reindexes
  rather than walks, and returns 400 if the path isn't actually a collection.
  **The feature flag is the root itself**: with none configured, `/status`
  reports no `hvsc` facts at all, so the SPA shows nothing HVSC-specific.
  Note `artist_from_path` here is HVSC-specific — `MUSICIANS/<letter>/<Artist>/`
  names the composer, but `DEMOS/`/`GAMES/` start with a *category*, so the
  generic seg[0] rule would file ~4,600 tunes under "DEMOS".
  Two traps, both found only by testing against a real release: HVSC's documents
  are **Latin-1**, so `read_to_string` fails on the whole file (which silently
  cost the version number), and the banner reads `Release 85` — a bare `#` scan
  would match the prose "Tunes #1" and report version 1.
- **The source scope is sticky, and defaults to one collection.** A
  `Mods · HVSC · All` selector (`SourceSelector.svelte`) sits between the view
  tabs and the facet bar — deliberately *not* a fourth tab, since favourites and
  playlists cut across sources rather than sitting beside them. It's hidden
  while only one root is configured. The whole filter set (collection, group-by,
  sorts, facets — not the free-text query) persists in `localStorage`, so a
  collection you didn't pick stays out of the list and therefore out of the play
  queue; `All` mixes on purpose. `/status` reports a per-root track count to
  label it.
- **Filesystem is the source of truth, artist-primary.**
  `<root>/artist/song.ext`. The first path segment is the artist (a file at
  the root has none); there is **no path-group** — groups/aliases/albums come from
  `library.json` (the manifest), joined onto the artist in the frontend. This is
  unconditional; there is no layout switch (the legacy `group/artist` mode was
  removed). No sidecar metadata files; files can be freely moved with ordinary
  tools and a rescan reconciles. The
  list view also renames/moves files in place (`/api/rename`) — handy for
  cleaning up names from old CD rips. **This means the collection mount must be
  read-write**, not the `:ro` the original deploy plan assumed — the raspi
  quadlet must mount `/mnt/mods` writable. Renames never overwrite (409 on
  collision) and keep a module extension (so the file stays indexed).
- **The DB is a cache, not state.** `files` is a path index; `meta` is
  libopenmpt-parsed enrichment **keyed by content hash** so it follows a file
  across moves/renames (the path changes, the bytes don't). Losing
  `TRACKER_DB_PATH` only costs a rescan. Idempotent boot migrations (no
  `user_version` gating).
- **Don't rehash the NAS every scan.** `content_hash` is reused when
  `(rel_path, size, mtime)` is unchanged; only new/changed files are read +
  SHA-256'd. First scan of the full collection hashes everything (~2.5 min over
  CIFS for 3455 files); later scans are cheap. macOS junk (`._*`, `.DS_Store`,
  …) and hidden dirs are skipped.
- **One engine, in the browser.** The backend is pure Rust (no native
  libopenmpt → clean scratch container). Playback **and** metadata extraction
  run in the SPA via libopenmpt WASM. This app vendors a **custom from-source
  libopenmpt build** (`wasm/libopenmpt-ext/`) that adds a small C ABI the stock
  chiptune3 build lacks: raw **sample extraction** (`smp_*` shim → `CSoundFile`),
  per-channel **mute/solo** (`chan_mute`, mirroring libopenmpt_ext's
  `set_channel_mute_status` via the same `CSoundFile` accessor — no ext module),
  and **structured pattern cells** (the `_openmpt_module_get_pattern_row_channel_command`
  export). Jamming itself is **pure Web Audio** (`AudioBufferSource` on the
  extracted PCM — no libopenmpt playback/ext engine). **Party vendors the same
  custom build** for sample jamming (its shared `PlayerStage` shows the
  `SampleBrowser`); the **pattern editor UI is tracker-only** — it lives in this
  app's `+page.svelte`, not in `PlayerStage`, so party never surfaces it even
  though its build reports `canReadCells`. The frontend POSTs parsed metadata
  back to `/api/meta/:hash`.
- **Auth is the edge's job.** Sits behind oauth2-proxy forward-auth; the binary
  only asserts `X-Auth-Request-User` is present (401 otherwise) — no per-user
  state, no own login. `DEV_AUTH=1` bypasses for local work. `/status` is unauth.
- **CSP** allows `'wasm-unsafe-eval'` + `worker-src blob:` for the WASM player,
  and hashes SvelteKit's inline bootstrap script at boot (no `'unsafe-inline'`).
- **The library index lives server-side.** The SPA no longer holds every track:
  it fetches a shaped, ordered **id stream** (`/api/library/ids`) and hydrates
  visible windows through `$lib/tracks.svelte` (a `SvelteMap` cache keyed by
  `files.id`, filled by `/api/tracks/batch` from the virtualizer's scroll
  effect). Rows in the stream can exist before their data arrives — the list
  renders a fixed-height skeleton so offsets stay exact. The **queue is refs,
  not tracks**: `@scene/player` takes `playRefs(ids, index)` / `cueRefs` and
  resolves each id through the host (`peekTrack` for cache hits, `resolveTrack`
  to fetch), so shuffle still permutes *indices* and its reproducibility,
  prev-history and reload-survival are untouched. Party keeps the in-memory
  `playInOrder(list, track)` form; both go through one code path.
  **The backend-less (Pages) build shapes in the browser** with the same pure
  helpers in `$lib/library`, then seeds the same cache — so every consumer reads
  rows identically. Anything that used to scan `library.tracks` (facet options,
  un-enriched counts, empty states, dupe playback, deep-link restore) now asks
  the backend instead; with a backend that array is empty by design.
- **Type sharing is manual**: `frontend/src/lib/api.ts` mirrors
  `backend/src/routes.rs` structs by hand.
- **Design.** Icons are **Lucide** (`@lucide/svelte`), squared (CSS overrides the
  default round strokes to `square`/`miter`, thicker stroke, small) to sit with
  the retro fonts — **not** Material Icons. Fonts are **self-hosted via fontsource**
  (no Google CDN): Inter Variable (body + chrome) with Amiga **TopazPlus** on the
  player surfaces (`--font-retro`: brand, pattern grid, sample list, ord/pat/row +
  time readouts). **halo-design is adopted**: `--halo-*` tokens in
  `src/lib/styles/halo.css` (dark-first, flipped by `data-theme`, no Google CDN),
  with `+layout.svelte` mapping the app tokens (`--bg/--panel/--accent/--surface-*`)
  onto them. Light/dark/auto via `data-theme` (`src/lib/theme.svelte.ts`). See the
  monorepo-root `scene-design` skill. Consume tokens, never hard-coded hex.
- **Player control model** (`player.svelte.ts` is a small state machine —
  stopped/playing/paused over one loaded `current` module): tapping a track opens
  the player (pattern) view and plays it; the already-loaded track just reopens
  the view (no rewind). Transport: play/pause toggles in place (and restarts from
  the top once the queue has ended — the stopped state); prev/next walk the queue
  (the visible grouped+filtered order) with auto-advance; a click-to-seek bar;
  **✕** returns to the list (playback continues as a bottom mini-player — tap its
  title to reopen the view); **mute** is an orthogonal volume toggle. (No stop
  button — pause covers it.)

## API

- `GET /status` — unauth liveness `{service, version, db_healthy, track_count, root}`.
- `GET /api/tracks` — full library index (path-derived + cached meta, LEFT JOIN).
  Fine at module scale; **does not scale to HVSC** (~91k tracks is tens of MB) —
  new code should use the shaped endpoints below.
- `GET /api/library/ids?collection&fav&fmt&tracker&q&group_by&track_sort&group_sort`
  — the **shaped library**: `{groups:[{name,ids}], total, formats, trackers}`.
  Filter/group/sort run server-side in `library.rs` (the Rust twin of the SPA's
  `lib/library.ts`), and the ids across all buckets in order *are* the play
  queue. Deterministic for a given query, which is what lets the client keep
  permuting **indices** for its seeded shuffle (so `prev` retraces the same
  history and the order survives a reload).
- `GET /api/tracks/batch?ids=1,2,3` — hydrate a window of that id stream, echoed
  back in the requested order (SQL `IN` guarantees none). Capped at 1000 ids;
  unknown ids are skipped, not fatal.
- `GET /api/track/{hash}` — one track by content hash, for the `?t=` deep-link
  restore (which can't search a list the browser no longer holds, and whose
  target may be excluded by a stored filter anyway).
- `GET /api/library/unenriched` — a page of tracks with no parsed metadata plus
  the total, driving the bulk-enrich button and its run. Excludes `.sid` (parsed
  server-side from the PSID header, so libopenmpt must never see them).
- `GET /api/file/{hash}` — raw module bytes (player + WASM parse).
- `POST /api/meta/{hash}` — store enrichment parsed in the browser.
- `POST /api/rename` — rename / move a module by editing its group/artist/
  filename segments (validates safe segments, refuses overwrite, moves on disk,
  updates the index row in place; metadata follows by hash).
- `POST /api/rescan` — re-walk the primary root (synchronous; returns counts).
- `POST /api/rescan/{root}` — re-walk one named root (400 for an `hvsc` root,
  which is indexed from its own catalogue rather than walked).
- `GET /status` also reports live scan progress (`scanning`, `scan_total`,
  `scan_processed`, `scan_hashed`) from lock-free counters, so the UI can show a
  progress bar without touching the scan-locked DB.
- **Playlists** (items keyed by md5/path/url so they follow a module's bytes
  across moves): `GET/POST /api/playlists`,
  `GET/POST(rename)/DELETE /api/playlists/{id}`,
  `POST(add)/PUT(reorder) /api/playlists/{id}/items` — add takes
  `{md5|path|url, …}`, reorder takes `{ids:[item_id]}` —
  `DELETE /api/playlists/{id}/items/{item_id}`.
- **Import / export** a playlist document (md5 + Modland path + cached display
  metadata): `POST /api/playlists/import` (kind `imported`),
  `GET /api/playlists/{id}/export`; `GET /api/library/md5` dumps all local md5s
  so an external curator can diff before producing an import doc.
- **Fetch missing** (download a playlist's missing items from Modland):
  `POST /api/playlists/{id}/fetch-missing` (background — downloads each item by
  its Modland `path`, else a generic `url`, into `<group>/<artist>/<file>`,
  records the md5, rescans so items resolve as present), `GET /api/fetch/status`
  (lock-free progress `{running, total, fetched, failed}`). The Modland base is
  `MODLAND_BASE` (default `https://ftp.modland.com`), env-overridable so the e2e
  drives it against a wiremock stub.

## Working on this repo

- Backend `:3010` (`TRACKER_BIND`): `cd backend && cp .env.example .env`, set
  `TRACKER_ROOT` / `TRACKER_ROOTS` (dev: `/Volumes/scene/mods` NAS mount), then `cargo run`. Boot only
  scans when the cache is **empty** (first run); a normal restart serves the
  persisted index instantly without re-walking the NAS. `/api/rescan` (synchronous)
  picks up on-disk changes.
- Frontend dev `:5173`: `cd frontend && yarn install && yarn dev`; Vite proxies
  `/api` + `/status` to `:3010`. `yarn validate` = typecheck + lint + format.
- integration: `cargo build -p tracker-backend && cargo test -p tracker-integration -- --ignored`.
- Key env: `TRACKER_ROOTS` or `TRACKER_ROOT` (one required), `TRACKER_BIND`, `TRACKER_DB_PATH`,
  `STATIC_DIR`, `DEV_AUTH`. See `backend/src/config.rs`.

## Status / roadmap

- **Done:** backend scanner + SQLite cache + API; SvelteKit SPA + library browser
  (group/artist/format facets, filter, rescan); **live scan progress bar**;
  **in-place rename/move** (inline edit in the list); **iPhone-portrait
  responsive UI** ([[feedback_iphone_portrait_ui]]); **libopenmpt WASM playback**
  via vendored chiptune3 (play/pause/stop transport, position, order/pattern/row)
  + **metadata write-back on play** (`/api/meta`); **live FT2 pattern view**
  (full-screen overlay, current row highlighted + auto-scrolled) with an
  **instrument/sample-list tab** and a **master oscilloscope** (`Scope.svelte`,
  AnalyserNode tap on the output); an **Amiga Boing Ball loader**
  (`BoingBall.svelte`, time-driven seamless bounce) shown during the first-run
  scan; e2e (7) + unit (11) tests; verified against the real NAS collection
  (3455 modules).
- **Playback engine notes:** chiptune3 worklet + embedded-wasm live in
  `static/vendor/chiptune3/` (served verbatim, 200 `text/javascript`); the
  main-thread class is vendored+patched in `src/lib/vendor/chiptune3.js` (load
  the worklet from a fixed `/vendor/...` URL so Vite doesn't bundle it). The
  **worklet's `getSong` is patched** to emit each cell as libopenmpt's formatted
  text (`format_pattern_row_channel` → "C-4 01 v64 A04") instead of 6 raw command
  values — runs once per load, off the audio path. `src/lib/player.svelte.ts` is
  the reactive store; `PatternView.svelte` renders the grid. **Vendored worklet
  files are excluded from eslint + prettier** (`static/vendor/`, `src/lib/vendor/`)
  — prettier silently reformats them otherwise. **Pending acceptance: in-browser
  audio + pattern smoke test** (everything else is statically verified).
- **Player/library features done:** queue (next/prev + auto-advance over the
  visible order), seek bar, shuffle, repeat, keyboard shortcuts, and **enrich-all**
  (parse every un-enriched module's metadata via a parse-only worklet command →
  POST /api/meta, with progress + cancel).
- **Keyboard jamming + sample extraction (done).** A **custom libopenmpt WASM**
  (`wasm/libopenmpt-ext/` — a from-source emscripten build in an amd64 emsdk container; the old "emcc not installed" note is
  stale) adds a tiny `smp_*` C ABI that reads **raw sample PCM + loop points** off
  a module (reaching the internal `CSoundFile` via a one-line accessor patch —
  libopenmpt's public API exposes sample *names* only). **Jamming is then pure Web
  Audio**: `packages/player`'s store builds an `AudioBuffer` from that PCM and
  plays it pitched to the key, looped at the sample's loop points — no libopenmpt
  playback engine, worker render-loop, or worklet involvement, and fully
  independent of the song's transport (`jamNote`/`jamStop` in `player.svelte.ts`;
  `JamKeyboard` + `SampleWave` UI gated on `playback.canReadSamples`). Party now
  vendors the same custom build, so it gets sample jamming too (the editor UI is
  tracker-only — see the engine note above). `decoder.worker.js` gained a `readSample` command
  (`smp_*` off the song module) — everything else is unchanged. Gate:
  `node wasm/libopenmpt-ext/spike/spike.mjs <mod>` (real PCM + loop points, MOD/XM/IT).
  **To bump libopenmpt:** `OMPT_REF=… ./build.sh` + re-run the gate (see
  `wasm/libopenmpt-ext/README.md`). **Caveat:** the chiptune3 *JS* layer
  (`chiptune3.js`/`decoder.worker.js`/`chiptune3.worklet.js`) is a hard fork — no
  upstream auto-sync; updates are a manual merge.
- **Player view modes:** pattern (toggle: locked fixed-centerline + vertical
  gradient VU, or free-scroll + header VU — persisted), samples, and a Boing-ball
  visualizer (reacts to channel VU). Per-channel VU is the only per-channel signal
  libopenmpt gives — true per-channel waveform scopes aren't possible.
- **Deploy:** multi-stage `Dockerfile` (vendored-yarn frontend build → musl
  cross-compile → `scratch`, **8.4 MB** `ghcr.io/eetu/tracker`), smoke-tested
  (scan, `/status`, SPA fallback, worklet served). **LAN-only, no oauth2-proxy:**
  the container runs with **`TRACKER_OPEN=1`** (config bypasses the forward-auth
  header assertion — same switch as `DEV_AUTH`); the host is egress-restricted.
  raspi wiring done (`../raspi`): `mods` CIFS share **mounted read-write**,
  `tasks/tracker.py` quadlet (mirrors `navidrome`), un-gated Traefik route,
  `network_restrict` + `RESTIC` entry. The `mods` share **reuses the `music` NAS
  login** via a `creds` alias, so no new vault fields are needed before deploy.
- **CI/CD:** `.github/workflows/` — `ci` (frontend lint/format/typecheck/build +
  Rust clippy/test/build + e2e), `dockerimage` (paths-gated arm64 → GHCR, prune
  untagged), `automerge` (dependabot, skips actions bumps), `cve-scan` (weekly
  Trivy → Security tab) + `dependabot.yaml`. Repo is public at `eetu/tracker`.
- **Player/OS integration:** Media Session metadata + transport handlers
  (play/pause/prev/next), a screen wake lock while playing, and an
  `AudioContext` resume on return to foreground. iOS suspends Web Audio in the
  background (only `HTMLMediaElement` survives — a render-to-`<audio>` bridge is
  still fragile on iOS in 2026), so this is a foreground player by design.
- **Tooling (done):** `install-hooks.sh` + `.githooks/pre-commit` (mode 755 —
  run `./install-hooks.sh` once; routes staged paths to vendored-yarn
  lint/format vs `cargo clippy --workspace`), `SECURITY.md`, and the
  monorepo-root `.claude/skills/scene-design` skill (shared across the scene
  apps). CI/dockerimage/automerge/cve-scan +
  dependabot already in `.github/`.
- **Next:** FT2 pixel font/chrome polish.
- **Favourites + play counts (done):** hash-keyed `stats` table (`favorite`,
  `play_count`, `last_played`) joined into `/api/tracks`; `POST /api/favorite/:hash`
  + `POST /api/play/:hash`. UI: per-row star, a header "favourites only" filter, a
  play-count badge, and a "most played" sort. Counts increment on every play start
  (server is authoritative; reflected optimistically). Both follow the file across
  moves (keyed by content hash, like `meta`); global, not per-user.
- **Virtualized library list (done):** the grouped tree is flattened to a row
  stream (group-header rows + track rows of open groups) and rendered with
  **TanStack Virtual** (`@tanstack/svelte-virtual`, `createVirtualizer` +
  `measureElement`). `<main>` is the scroll container (body no longer scrolls).
- **Playlists + Modland fetch (done):** `playlists` + `playlist_items` tables
  (items keyed by md5/path/url, `ON DELETE CASCADE` with `PRAGMA foreign_keys=ON`);
  full CRUD + reorder (by item id) API; a right-side `PlaylistsPanel.svelte`
  (create/rename/delete, item reorder, play-in-order via `playInOrder`) and a
  per-row "add to playlist" chooser. The `files` table gained an `md5` column
  (computed alongside SHA-256 in one read pass — one-time full re-hash on first
  boot after the upgrade) so an item resolves to a local file by md5 (falling
  back to a filename match when the md5 is unknown). **Import + fetch-missing:**
  `POST /api/playlists/import` ingests a curated document (each item an md5
  and/or a Modland `path`, plus cached display metadata); `fetch-missing`
  downloads the items not present locally via the `modland.rs` client — by
  Modland `path` (placed at `<format>/<author>/<file>`) or a generic `url`
  (placed at `_groupless/<artist>/<file>` from the item's curated artist, else
  `_groupless/<file>`) — sequential, throttled, capped at `FETCH_MAX`,
  then rescans so they resolve as present. `MODLAND_BASE` is env-overridable so
  the e2e drives it against a wiremock stub. (An earlier plan to auto-sync The
  Mod Archive "Top Favourites" chart was dropped in favour of this curated
  import + Modland fetch path — there is no `modarchive` client or `/api/top/*`.)
- **Backlog (ideas):**
  - **HVSC as a versioned data image** — deferred: the SMB mount works well
    enough, and the licensing makes a *public* image the wrong shape. Every tune
    is separately copyrighted and `DOCUMENTS/Disclaimer.txt` states the HVSC crew
    "do not have (and neither do they claim) the legal authority to grant
    licences"; bulk redistribution wants their permission (`HVSC.faq` [25]:
    email, non-profit only). A private image is fine, but if this comes back the
    cleaner shape is a pyinfra task fetching a pinned release from an official
    mirror at deploy time — no redistribution at all.
  - **HVSC update-available check** — deferred with the image. `hvsc.c64.org`
    publishes no feed or API (verified: JS SPA with a catch-all redirect), so it
    would mean polling CSDb's RSS for `High Voltage SID Collection #NN` and
    comparing to the indexed version. Best-effort on a fragile source; the
    version chip and the manual reindex already exist and cover the need.
  - **Installable offline PWA** — service worker caching the shell + chiptune
    WASM (+ recently-played module bytes) for offline foreground playback.
  - **Resume last session** — persist current track + queue + position to
    `localStorage`, restore on load (tap-to-resume on iOS).
  - **Faceted/sortable library** — sort by duration/channels/play-count, filter
    by tracker/format, using the enrichment already collected.
  - ~~**Sample waveform pane**~~ — DONE, and better than the original idea: the
    custom build reads the *stored* sample PCM + loop/sustain points directly
    (`SampleWave.svelte`), so the pane draws real waveforms with loop markers
    (no render-capture needed).

Out of scope: editing module *contents* (notes/samples) + saving new modules —
libopenmpt is read-only; a real tune-creating tracker would need a separate
engine (a sketched later phase, built on the jam/sample primitives). Note:
stored-sample waveforms + loop points are **now in scope** (the custom build
exposes them); true per-channel *output* scopes remain impossible (per-channel VU
is the only per-channel signal libopenmpt gives). Renaming/moving files *is* in
scope (see above). See `/Users/eetu/.claude/plans/magical-floating-toucan.md` for
the full plan.
