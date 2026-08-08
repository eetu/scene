# tracker — repo overview

FastTracker 2-style player for a filesystem tracker-module collection: ~3500
modules (MOD/XM/S3M/IT + the legacy zoo) via libopenmpt WASM, plus C64 SID via
libsidplayfp with HVSC as a first-class source, in a pixel-perfect FT2 UI.
Rust(axum) + SvelteKit, halo-design; layout in the monorepo root CLAUDE.md.

## Conventions

- **Multiple collection roots.** `TRACKER_ROOTS=id:kind:path[,…]`;
  `TRACKER_ROOT` is sugar for a single `mods` root. `kind` is `scan` (walk +
  hash) or `hvsc` (indexed from `DOCUMENTS/Songlengths.md5`, read-only —
  rename/delete refused). Index identity is **`(root_id, rel_path)`** (the same
  path can exist in two roots) plus a stable surrogate `files.id`, the API's
  track id. Every filesystem access resolves against *the row's own* root
  (`resolve_in_root`), never a default: a row whose root left the config
  resolves to nothing rather than being reinterpreted against another tree.
  The first declared root is primary — it owns `library.json` and receives
  Modland fetches. `/status` lists the roots.
- **SID is indexed, and a subtune is a track.** `.sid`/`.psid`/`.rsid` metadata
  is parsed **in Rust** from the PSID/RSID header (`sid.rs`) — SIDs never touch
  the browser's libopenmpt enrichment path; `hash_file` returns the first 124
  bytes, so no second open. Each subtune (1..256) is its own library entry (id,
  favourite, play count, queue slot): one `songs` row per subtune (hash-keyed),
  `subsong` in `stats`' PK, `library::track_id = files.id * 256 + subsong`.
  A headerless `.sid` (sidplay-v1 `SIDPLAY INFOFILE`) is skipped, not indexed.
  Duration stays **null**; playback falls back to `TRACKER_SID_DEFAULT_LENGTH`
  (180s) via the `playLength` hook, and the timer button stores a listened
  length (`POST /api/song-length/{hash}` → `songs.duration`, the column an
  HVSC index fills from Songlengths).
- **SID plays through the same pipeline, on a second decoder.**
  `libsidplayfp-wasm` (npm, **residfp** artifact for the 6581/8580 filters).
  The worklet is format-agnostic (it just drains chunk messages), so SID
  reuses the whole hand-tuned pipe; only the decoder differs
  (`src/sid/sid.worker.ts`, same protocol, *bundled* TS with an npm import —
  hence `chiptune3.js` taking `workerFactory` alongside `workerUrl`).
  `createEngine(cfg, kind)` picks the decoder by extension; `ensurePlayer`
  rebuilds the graph when the queue crosses formats; the subtune travels
  **with** the load so it can't race. C64 ROMs come from `TRACKER_ROMS_DIR`
  (`/api/roms/*`, filename allowlist + size check); unconfigured degrades to
  built-in images (a BASIC-driven RSID goes near-silent).
- **SID's player pane is a voice monitor, not a pattern grid**
  (`VoiceMonitor.svelte`, shown when `hasPatterns` is false): it reads the
  live chip registers off the audio-synced relay (`ProgressMsg.regs` →
  `playback.sidRegs`), so it matches what you hear; `sid/registers.ts` is the
  only place that knows the register layout (pure, unit-tested). Beat is onset
  detection (`BeatTracker.energy()`, bass-band + refractory window — the
  ~50Hz interrupt is a tick, not a beat); per-voice VU derives from the same
  registers.
- **HVSC indexes itself, and is never modified.** An `hvsc` root is built from
  `DOCUMENTS/Songlengths.md5` (`hvsc.rs`): one read yields every tune's path,
  content MD5 (becomes `content_hash`; 32 hex vs a scanned 64, can't collide)
  and per-subtune length — 61k tunes in under a second, no walk or hashing;
  the tree is only ever read. `hvsc_state` (version, counts, size+mtime stamp)
  makes the boot check one stat — a newly mounted release reindexes
  automatically; `/api/rescan/{root}` reindexes rather than walks (400 if not
  a collection). The feature flag is the root itself: none configured → no
  `hvsc` facts in `/status`, nothing in the SPA. `artist_from_path` is
  HVSC-specific — `MUSICIANS/…/<Artist>/` names the composer; `DEMOS/`/
  `GAMES/` start with a category (the seg[0] rule would misfile ~4,600 tunes).
- **The source scope is sticky, defaults to one collection.** `Mods · HVSC ·
  All` (`SourceSelector.svelte`) sits between the view tabs and facet bar —
  deliberately not a fourth tab (favourites/playlists cut across sources);
  hidden with one root. The filter set (not the free-text query) persists in
  `localStorage`; `All` mixes on purpose. `/status` per-root counts label it.
- **Filesystem is the source of truth, artist-primary.**
  `<root>/artist/song.ext` — seg[0] is the artist (root files have none).
  **No path-group**: groups/aliases/albums come from `library.json` (the
  manifest), joined onto the artist in the frontend; the legacy `group/artist`
  mode was removed. No sidecar metadata; files move with ordinary tools, a
  rescan reconciles. The list view renames/moves in place (`/api/rename`), so
  the mount must be **read-write** (raspi mounts `/mnt/mods` writable).
  Renames never overwrite (409) and keep a module extension.
- **The DB is a cache, not state.** `files` is a path index; `meta` is
  enrichment **keyed by content hash**, so it follows a file across
  moves/renames. Losing `TRACKER_DB_PATH` only costs a rescan; boot migrations
  are idempotent (no `user_version` gating). Scans don't rehash the NAS:
  `content_hash` is reused when `(rel_path, size, mtime)` is unchanged; only
  new/changed files are read + SHA-256'd (first full scan ~2.5 min over CIFS).
  macOS junk (`._*`, `.DS_Store`, …) and hidden dirs are skipped.
- **One engine, in the browser.** The backend is pure Rust (no native
  libopenmpt → clean scratch container); playback **and** metadata extraction
  run in the SPA, which POSTs parsed metadata to `/api/meta/{hash}`. The WASM
  is the monorepo's custom libopenmpt build —
  `../../wasm/libopenmpt-ext/README.md` is canonical (`smp_*`/mute/cell ABI,
  pure-Web-Audio jamming, build + bump). Tracker specifics: the chiptune3 *JS*
  layer is a hard fork — `static/vendor/chiptune3/` +
  `src/lib/vendor/chiptune3.js` (worklet loaded from a fixed `/vendor/…` URL
  so Vite doesn't bundle it), both excluded from eslint + prettier, upstream
  merges manual; its `getSong` is patched to emit cells as formatted text.
  The pattern editor UI is tracker-only (this app's `+page.svelte`, not
  `PlayerStage`) — party never surfaces it though its build reports
  `canReadCells`.
- **Auth is the edge's job.** Sits behind oauth2-proxy forward-auth; the binary
  only asserts `X-Auth-Request-User` is present (401 otherwise) — no per-user
  state, no own login. `DEV_AUTH=1` bypasses for local work; the LAN-only
  deploy runs `TRACKER_OPEN=1` (same bypass). `/status` is unauth.
- **CSP** allows `'wasm-unsafe-eval'` + `'unsafe-eval'` (required by the SID
  engine alone — see `lib.rs`) + `worker-src 'self' blob:`, and hashes
  SvelteKit's inline bootstrap script at boot (no `'unsafe-inline'`).
- **The library index lives server-side.** The SPA no longer holds every
  track: it fetches a shaped, ordered **id stream** (`/api/library/ids`) and
  hydrates visible windows through `$lib/tracks.svelte` (a `SvelteMap` cache
  keyed by `files.id`, filled by `/api/tracks/batch` from the virtualizer's
  scroll effect). Rows can exist before their data arrives — a fixed-height
  skeleton keeps offsets exact. The **queue is refs, not tracks**:
  `@scene/player` takes `playRefs(ids, index)` / `cueRefs` and resolves ids
  through the host (`peekTrack` for cache hits, `resolveTrack` to fetch), so
  shuffle still permutes *indices* — reproducibility, prev-history and
  reload-survival untouched. Party keeps the in-memory `playInOrder(list,
  track)` form; one code path. The backend-less (Pages) build shapes in the
  browser with the same pure helpers (`$lib/library`) and seeds the same
  cache. Anything that used to scan `library.tracks` asks the backend instead;
  with a backend that array is empty by design.
- **Type sharing is manual**: `frontend/src/lib/api.ts` mirrors
  `backend/src/routes.rs` structs by hand.
- **Design.** Icons: **Lucide** (`@lucide/svelte`), squared via CSS
  (`square`/`miter`, thicker, small) to sit with the retro fonts — not
  Material Icons. Fonts self-hosted via fontsource (no Google CDN): Inter
  Variable body/chrome, Amiga **TopazPlus** on player surfaces
  (`--font-retro`). `--halo-*` tokens in `src/lib/styles/halo.css`
  (dark-first, `data-theme`-flipped) map to the app tokens in
  `+layout.svelte`; light/dark/auto via `src/lib/theme.svelte.ts`. See the
  `scene-design` skill. Consume tokens, never hard-coded hex.
- **Player control model** (`player.svelte.ts`, stopped/playing/paused over
  one loaded `current`): tap a track → player view + play; the already-loaded
  track just reopens (no rewind). Play/pause toggles in place (restarts after
  the queue ends); prev/next walk the visible grouped+filtered order with
  auto-advance; click-to-seek; **✕** returns to the list (playback continues
  as a mini-player); mute is an orthogonal volume toggle; no stop button.
  Media Session + wake lock are wired; iOS suspends background Web Audio — a
  foreground player by design.

## API

`frontend/src/lib/api.ts` mirrors `routes.rs` by hand; auth on all but `/status`.

- `GET /status` — liveness, roots + counts, hvsc facts, live scan progress.
- `GET /api/library/ids?collection&fav&fmt&tracker&q&group_by&…` — shaped
  library `{groups:[{name,ids}], total, formats, trackers}` (`library.rs`);
  the ids in order *are* the play queue (deterministic → the client's seeded
  shuffle keeps permuting indices).
- `GET /api/tracks/batch?ids=…` — hydrate a window (order echoed, ≤1000 ids).
- `GET /api/track/{hash}` — `?t=` deep-link restore.
- `GET /api/tracks` — full index; module-scale only, does not scale to HVSC.
- `GET /api/library/unenriched` — unparsed-tracks page (excludes `.sid`).
- `GET /api/file/{hash}` — raw bytes; `POST /api/meta/{hash}` — enrichment.
- `POST /api/favorite|play|song-length/{hash}` — hash-keyed listener state.
- `POST /api/rename`, `/api/delete` — organise the collection on disk.
- `POST /api/rescan[/{root}]` — re-walk primary / one root (hvsc reindexes).
- `GET /api/stil/{id}` — STIL notes; `GET /api/roms/{which}` — C64 ROMs.
- Playlists (items keyed md5/path/url so they follow a module's bytes):
  `GET/POST /api/playlists`; `GET/POST(rename)/DELETE /api/playlists/{id}`;
  `POST(add)/PUT(reorder) …/{id}/items`; `DELETE …/{id}/items/{item_id}`.
- `POST /api/playlists/import`, `GET …/{id}/export`, `GET /api/library/md5` —
  curated import/export + an md5 dump for external diffing.
- `POST …/{id}/fetch-missing` + `GET /api/fetch/status` — Modland fetch
  (background; `MODLAND_BASE` env-overridable, the e2e stubs it).
- Manifest/curation (write `library.json` atomically, hot-swap, no rescan):
  `GET /api/manifest`, `POST /api/library/reload`, `PUT /api/artist/{name}`,
  `POST /api/albums`, `PUT/DELETE /api/albums/{id}`, `POST …/{id}/songs`,
  `DELETE …/{id}/songs/{md5}`, `PUT /api/song/{md5}`.
- `GET /api/dupes` — duplicate report (exact + likely).

## Working on this repo

- Backend `:3010` (`TRACKER_BIND`): `cd backend && cp .env.example .env`, set
  `TRACKER_ROOT`/`TRACKER_ROOTS` (dev: the `/Volumes/scene/mods` NAS mount),
  then `cargo run`. Boot only scans when the cache is empty; a restart serves
  the persisted index without re-walking the NAS. `/api/rescan` (synchronous)
  picks up on-disk changes.
- Frontend dev `:5173`: `cd frontend && yarn install && yarn dev`; Vite
  proxies `/api` + `/status` to `:3010`. `yarn validate` = typecheck + lint +
  format. Integration: `cargo build -p tracker-backend && cargo test -p
  tracker-integration -- --ignored`.
- Key env: `TRACKER_ROOTS`/`TRACKER_ROOT` (one required), `TRACKER_BIND`,
  `TRACKER_DB_PATH`, `TRACKER_ROMS_DIR`, `STATIC_DIR`,
  `DEV_AUTH`/`TRACKER_OPEN`. See `backend/src/config.rs`.

## Next / deferred

- **Next:** FT2 pixel font/chrome polish.
- **HVSC as a versioned data image** — deferred: the SMB mount works, and
  every tune is separately copyrighted (redistribution wants the crew's
  permission, `HVSC.faq` [25]) — a public image is the wrong shape. If
  revisited: a pyinfra task fetching a pinned release at deploy time.
- **HVSC update-available check** — deferred with the image: `hvsc.c64.org`
  has no feed/API, so it'd mean polling CSDb's RSS — fragile; the version
  chip + manual reindex cover the need.
- **Installable offline PWA** — service worker caching shell + WASM + recent
  module bytes for offline foreground playback.
- **Resume last session** — persist track/queue/position to `localStorage`;
  tap-to-resume on iOS.

## Out of scope

Editing module *contents* (notes/samples) and saving new modules — libopenmpt
is read-only; a tune-creating tracker would need a separate engine. Stored
sample waveforms + loop points *are* in scope (the custom build exposes them);
true per-channel *output* scopes remain impossible (per-channel VU is the only
per-channel signal libopenmpt gives). Renaming/moving files is in scope.
