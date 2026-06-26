# tracker — repo overview

FastTracker 2-style player for a filesystem tracker-module collection. Browse
~3500 modules by group/artist/format and play them (MOD/XM/S3M/IT + the obscure
legacy zoo) via libopenmpt WASM, with a pixel-perfect FT2 UI. Sibling in eetu's
homebrew family ([represent](../represent), [scribe](../scribe),
[halo](../halo)) — Rust(axum) + SvelteKit, halo-design.

## Layout

```
backend/    Rust axum 0.8 — scans TRACKER_ROOT, SQLite cache, serves bytes + SPA
frontend/   Svelte 5 + SvelteKit (adapter-static) — library browser + (todo) FT2 UI
e2e/        spawned-binary integration tests (temp root + SQLite, real HTTP)
```

Cargo workspace = `backend` + `e2e`.

## Conventions

- **Filesystem is the source of truth.** `TRACKER_ROOT/group/artist/song.ext`.
  The first path segment is the group, the second (when present) the artist —
  files directly under a group dir have no artist. No sidecar metadata files;
  files can be freely moved with ordinary tools and a rescan reconciles. The
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
  run in the SPA via libopenmpt WASM (chiptune3's prebuilt build includes
  `libopenmpt_ext`, so keyboard `play_note` works — vendor + patch its worklet).
  The frontend POSTs parsed metadata back to `/api/meta/:hash`.
- **Auth is the edge's job.** Sits behind oauth2-proxy forward-auth; the binary
  only asserts `X-Auth-Request-User` is present (401 otherwise) — no per-user
  state, no own login. `DEV_AUTH=1` bypasses for local work. `/status` is unauth.
- **CSP** allows `'wasm-unsafe-eval'` + `worker-src blob:` for the WASM player,
  and hashes SvelteKit's inline bootstrap script at boot (no `'unsafe-inline'`).
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
  `tracker-design` skill. Consume tokens, never hard-coded hex.
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
- `GET /api/file/{hash}` — raw module bytes (player + WASM parse).
- `POST /api/meta/{hash}` — store enrichment parsed in the browser.
- `POST /api/rename` — rename / move a module by editing its group/artist/
  filename segments (validates safe segments, refuses overwrite, moves on disk,
  updates the index row in place; metadata follows by hash).
- `POST /api/rescan` — re-walk the tree (synchronous; returns counts).
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
  `TRACKER_ROOT` (dev: `/Volumes/mods` NAS mount), then `cargo run`. Boot only
  scans when the cache is **empty** (first run); a normal restart serves the
  persisted index instantly without re-walking the NAS. `/api/rescan` (synchronous)
  picks up on-disk changes.
- Frontend dev `:5173`: `cd frontend && yarn install && yarn dev`; Vite proxies
  `/api` + `/status` to `:3010`. `yarn validate` = typecheck + lint + format.
- e2e: `cargo build -p tracker-backend && cargo test -p tracker-e2e -- --ignored`.
- Key env: `TRACKER_ROOT` (required), `TRACKER_BIND`, `TRACKER_DB_PATH`,
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
- **Keyboard jamming is BLOCKED** on the stock chiptune3 wasm: it exports
  `ext_create_from_memory`/`ext_get_interface` but NOT
  `openmpt_module_ext_get_module_handle`, so the ext module can't be rendered and
  `play_note` can't reach the audio path. Needs a custom emscripten libopenmpt
  build (emcc not installed). Don't retry on the stock build.
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
  `.claude/skills/tracker-design` skill. CI/dockerimage/automerge/cve-scan +
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
  (placed under the url host) — sequential, throttled, capped at `FETCH_MAX`,
  then rescans so they resolve as present. `MODLAND_BASE` is env-overridable so
  the e2e drives it against a wiremock stub. (An earlier plan to auto-sync The
  Mod Archive "Top Favourites" chart was dropped in favour of this curated
  import + Modland fetch path — there is no `modarchive` client or `/api/top/*`.)
- **Backlog (ideas):**
  - **Installable offline PWA** — service worker caching the shell + chiptune
    WASM (+ recently-played module bytes) for offline foreground playback.
  - **Resume last session** — persist current track + queue + position to
    `localStorage`, restore on load (tap-to-resume on iOS).
  - **Faceted/sortable library** — sort by duration/channels/play-count, filter
    by tracker/format, using the enrichment already collected.
  - **Sample waveform pane** — render-captured PCM on the samples tab (no loop
    markers — libopenmpt doesn't expose them).

Out of scope: editing module *contents* (notes/samples), true stored-sample
waveforms + loop points (libopenmpt exposes neither — waveforms are
render-captured). Renaming/moving files *is* in scope (see above). See
`/Users/eetu/.claude/plans/magical-floating-toucan.md` for the full plan.
