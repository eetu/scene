# scene monorepo task runner. `just` with no args lists recipes.
# Frontends: yarn workspaces. Backends: one cargo workspace. Sidecars: uv.

# Yarn = the repo-vendored release pinned by `yarnPath` in .yarnrc.yml, run via
# node. No global yarn / corepack needed (recipes run under sh, which can't see a
# shell yarn function), and it auto-tracks `yarn set version` bumps.
yarn := "node " + (justfile_directory() / `awk '/^yarnPath:/{print $2}' .yarnrc.yml`)

default:
    @just --list

# Install all JS workspace deps (root yarn workspace).
install:
    {{yarn}} install

# Per-component alternative (own terminals): `cd apps/<app>/backend && bacon`
# (TUI), `cd apps/<app>/frontend && yarn dev`, `uv run …` for a Python sidecar.
# In `just dev` the backend runs headless (`bacon --headless -j run`) so all the
# logs compose into one stream; backends hot-reload on src + .env changes.
#
# Dev a whole service: backend (bacon) + frontend (vite) + sidecars. e.g. just dev tracker
# Add a `host` arg to expose the frontend on the LAN over HTTPS + print the
# network URL/QR, so another device can connect (e.g. `just dev party host`);
# HTTPS is needed for the emulators (secure-context SharedArrayBuffer). Off by
# default (localhost/http).
dev app host="":
    #!/usr/bin/env bash
    set -euo pipefail
    # Tear down every child (and its grandchildren — the backend binary under
    # bacon, vite under yarn) on Ctrl-C / exit, so nothing orphans and holds its
    # port. Killing only the children — NOT `kill 0` — leaves `just` and the
    # shell unsignalled, so no stray SIGTERM noise on exit.
    pids=""
    cleanup() {
        trap - INT TERM EXIT
        for p in $pids; do
            pkill -P "$p" 2>/dev/null || true
            kill "$p" 2>/dev/null || true
        done
    }
    trap cleanup INT TERM EXIT
    ( cd apps/{{app}}/backend && exec bacon --headless -j run ) &
    pids="$pids $!"
    ( cd apps/{{app}}/frontend && DEV_HOST="{{host}}" exec {{yarn}} dev ) &
    pids="$pids $!"
    # Sidecars this service needs (loopback). Party fronts the ffmpeg transcoder.
    if [ "{{app}}" = "party" ]; then
        ( cd services/transcoder && exec bacon --headless -j run ) &
        pids="$pids $!"
    fi
    wait

# Build everything: all frontends, then the whole rust workspace.
build:
    {{yarn}} build
    cargo build --release --workspace

# Build one app's frontend + backend.
build-app app:
    {{yarn}} workspace {{app}}-frontend run build
    cargo build --release -p {{app}}-backend

# Lint/format/typecheck across the repo.
lint:
    {{yarn}} lint
    cargo clippy --workspace --all-targets -- -D warnings

# Formatting check (prettier across the repo + rustfmt across the workspace).
# Apply with `yarn format:fix` / `cargo fmt --all`.
format:
    {{yarn}} format
    cargo fmt --all -- --check

# Tests: rust workspace.
test:
    cargo test --workspace

# Browser e2e (Playwright): real built SPA + real vendored WASM worklet in a
# real browser, backend mocked. Catches worklet/WebAudio regressions node can't
# (e.g. the emsdk-6 resizable-ArrayBuffer break). First run needs `just e2e-install`.
e2e app="tracker":
    {{yarn}} workspace {{app}}-frontend test:e2e

# One-time (and in CI): download the Playwright browsers + Linux system deps.
e2e-install app="tracker":
    {{yarn}} workspace {{app}}-frontend exec playwright install --with-deps chromium webkit

# Run the party transcoder sidecar (loopback), auto-reloading via bacon.
transcoder:
    cd services/transcoder && bacon --headless -j run

# Boot an Amiga demo from the party tree in fs-uae (native, on your desktop).
#
# Why: the in-browser core (libretro-uae under EmulatorJS) has NO JIT, so AGA
# demos — 68020+ chasing a full-rate AGA display — run poorly there. fs-uae JITs
# and runs them at speed. It's also the honest way to tell "this demo is broken"
# from "the WASM core is too slow", and the fastest loop when fixing an .hdf.
#
# The machine + Kickstart come from the demo's FILENAME TAG — the same mapping
# `EjsEmulator.svelte` uses, so what you see here is what the app aims for. See
# apps/party/AMIGA-ROMS.md for the tags and the ROM table.
#
#   (A500)/(OCS)/(ECS) → A500,      kick34005.A500
#   (030)/(A4030)      → A4000+030, kick40068.A4000
#   (040)/(A4040)      → A4000/040, kick40068.A4000
#   else (e.g. (AGA))  → A1200,     kick40068.A1200   + 8 MB fast RAM
#
# `target` is a path, or any substring to search the tree for (.hdf/.adf/.dms/
# .adz/.ipf, including per-prod .support/ dirs). PARTY_ROOT comes from the env,
# else backend/.env, else the `root` argument. e.g. `just amiga ZIF`,
# `just amiga "Desert Dream"`, or a full path to an image.
#
# Boot an Amiga demo natively in fs-uae (JIT — the browser core has none).
amiga target root="":
    #!/usr/bin/env bash
    set -euo pipefail
    root="{{root}}"
    if [ -z "$root" ]; then root="${PARTY_ROOT:-}"; fi
    if [ -z "$root" ] && [ -f apps/party/backend/.env ]; then
        root="$(sed -n 's/^[[:space:]]*PARTY_ROOT=//p' apps/party/backend/.env | tail -1 | tr -d '"' )"
    fi
    root="${root:-/Volumes/scene/parties}"
    root="${root%/}"
    [ -d "$root" ] || { echo "PARTY_ROOT not found: $root (is the NAS mounted?)" >&2; exit 1; }

    # A real path wins; otherwise search the tree by name. Walking the NAS takes
    # minutes (SMB stats every file), so the image list is cached and only rebuilt
    # when a search misses — which also picks up newly-added demos by itself.
    cache="${XDG_CACHE_HOME:-$HOME/.cache}/scene-amiga-images.txt"
    fresh=0   # set once we've built the index in THIS run, so a miss doesn't redo it
    reindex() {
        echo "indexing Amiga images under $root (a few minutes over SMB)…" >&2
        mkdir -p "$(dirname "$cache")"
        find "$root" -type f \
            \( -iname '*.hdf' -o -iname '*.adf' -o -iname '*.dms' -o -iname '*.adz' -o -iname '*.ipf' \) \
            -not -name '._*' > "$cache.tmp" && sort "$cache.tmp" > "$cache" && rm -f "$cache.tmp"
        fresh=1
        echo "indexed $(wc -l < "$cache" | tr -d ' ') images" >&2
    }
    # No `mapfile` — macOS ships bash 3.2.
    search() {
        hits=()
        while IFS= read -r line; do [ -n "$line" ] && hits+=("$line"); done < <(
            grep -i -F -- "{{target}}" "$cache" 2>/dev/null || true)
    }

    if [ -f "{{target}}" ]; then
        img="{{target}}"
    else
        [ -s "$cache" ] || reindex
        search
        # Nothing found, or the cache points at something that's since moved →
        # rebuild once and retry before giving up (skipped if we just built it).
        if [ "$fresh" -eq 0 ] && { [ "${#hits[@]}" -eq 0 ] || { [ "${#hits[@]}" -eq 1 ] && [ ! -f "${hits[0]}" ]; }; }; then
            reindex
            search
        fi
        if [ "${#hits[@]}" -eq 0 ]; then echo "no Amiga image matching '{{target}}' under $root" >&2; exit 1; fi
        if [ "${#hits[@]}" -gt 1 ]; then
            echo "'{{target}}' matches ${#hits[@]} images — narrow it down:" >&2
            printf '  %s\n' "${hits[@]#$root/}" >&2
            exit 1
        fi
        img="${hits[0]}"
    fi

    # Tag → machine. Matched against the whole path (the tag is on the image, but
    # a prod folder may carry it too), lowercased.
    lower="$(printf '%s' "$img" | tr '[:upper:]' '[:lower:]')"
    extra=()
    case "$lower" in
        *'(a500)'*|*'(ocs)'*|*'(ecs)'*) model="A500";      rom="kick34005.A500"  ;;
        *'(040)'*|*'(a4040)'*)          model="A4000/040"; rom="kick40068.A4000" ;;
        *'(030)'*|*'(a4030)'*)          model="A4000";     rom="kick40068.A4000"; extra+=(--cpu=68030) ;;
        # A1200's "2M chip + 8M fast" preset is what the app forces; without the
        # fast RAM any sizable demo aborts with "not enough memory available".
        *)                              model="A1200";     rom="kick40068.A1200"; extra+=(--fast_memory=8192) ;;
    esac
    ks="$root/.support/$rom"
    [ -f "$ks" ] || { echo "missing Kickstart: $ks" >&2; echo "see apps/party/AMIGA-ROMS.md (ROMs are copyrighted and supplied separately)" >&2; exit 1; }

    # .hdf mounts as a hard drive; floppy formats go in DF0.
    case "$lower" in
        *.hdf) media=(--hard_drive_0="$img") ;;
        *)     media=(--floppy_drive_0="$img") ;;
    esac

    echo "fs-uae: $model  rom=$rom"
    echo "        ${img#$root/}"
    exec fs-uae --amiga_model="$model" --kickstart_file="$ks" "${media[@]}" "${extra[@]}"

# Package a finalized party tree into a read-only data image (run where the NAS
# is mounted). The content (~hundreds of MB) isn't in the repo, so this is a
# manual, reproducible one-off — NOT a CI artifact. Re-push a new :tag whenever
# the tree changes. Whatever sits under <party>/**/.support/ (the per-prod Amiga
# ADF/HDF) is captured automatically. The runtime party image is unchanged —
# PARTY_ROOT still points at this data volume at deploy time.
#
# Cleanliness: the build stages a junk-free copy first, so macOS/OS sidecars
# (._*, .DS_Store, .Spotlight-V100, …) never land in the image. The derived-asset
# cache (PARTY_CACHE_DIR) and party.db live OUTSIDE PARTY_ROOT and so are never in
# the tree being packaged; the cache/*.db excludes are belt-and-suspenders.
# Image repo names must be lowercase, so the slug is lowercased for the tag while
# the in-image path keeps the real directory name.
#
# Usage: just package-party-data /Volumes/scene/parties Assembly95 1995
package-party-data src slug tag:
    #!/usr/bin/env bash
    set -euo pipefail
    stage="$(mktemp -d)"
    trap 'rm -rf "$stage"' EXIT
    rsync -a \
      --exclude='._*' --exclude='.DS_Store' --exclude='.AppleDouble' \
      --exclude='.Spotlight-V100' --exclude='.Trashes' --exclude='.fseventsd' \
      --exclude='.TemporaryItems' --exclude='.DocumentRevisions-V100' \
      --exclude='.apdisk' --exclude='Thumbs.db' --exclude='desktop.ini' \
      --exclude='cache' --exclude='.cache' \
      --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' \
      "{{src}}/{{slug}}" "$stage/"
    # Normalize perms: the source tree (NAS) is often drwx------/-rwx------ root-only.
    # The party backend runs as a NON-root UID, so make dirs world-traversable (0755)
    # and files world-readable (0644) or it can't read the archive (indexes 0 files).
    find "$stage/{{slug}}" -type d -exec chmod 0755 {} +
    find "$stage/{{slug}}" -type f -exec chmod 0644 {} +
    # Content-at-root: COPY the party's *contents* (trailing slash) to /, NOT the
    # `<Party>/` dir itself. Each party ships as its own image mounted at
    # /srv/parties/<Party>, so the files (incl. `.party.json`) must sit at the image
    # root — nesting would double up as /srv/parties/<Party>/<Party>. The tree stays
    # self-contained because `.party.json` lives inside the folder we copy.
    printf 'FROM scratch\nCOPY %s/ /\n' '{{slug}}' > "$stage/Dockerfile"
    img="ghcr.io/eetu/scene-party-data-$(printf '%s' '{{slug}}' | tr '[:upper:]' '[:lower:]'):{{tag}}"
    # podman or docker (override with CONTAINER_ENGINE). A scratch + COPY image
    # runs nothing, so --platform just stamps the amd64 manifest on any host (no
    # emulation, no buildx); plain build + push is portable across both engines.
    engine="${CONTAINER_ENGINE:-$(command -v podman >/dev/null 2>&1 && echo podman || echo docker)}"
    "$engine" build --platform linux/amd64 -t "$img" "$stage"
    "$engine" push "$img"
    echo "pushed $img via $engine"
